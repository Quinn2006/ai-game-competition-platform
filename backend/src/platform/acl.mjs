import { spawn, spawnSync } from 'node:child_process';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

// Windows well-known SIDs that must never hold an Allow ACE on private storage.
// Matching by SID (not a localised account name) is required: names differ per OS language.
const forbiddenSids = new Set([
  'S-1-1-0',       // Everyone
  'S-1-5-7',       // Anonymous Logon
  'S-1-5-11',      // Authenticated Users
  'S-1-5-32-545',  // BUILTIN\Users
  'S-1-5-32-546',  // BUILTIN\Guests
  'S-1-5-32-547',  // BUILTIN\Power Users
  'S-1-5-32-551',  // BUILTIN\Backup Operators
]);
const trustedSids = new Set([
  'S-1-5-18',       // SYSTEM
  'S-1-5-32-544',  // BUILTIN\Administrators
]);
const sidPattern = /^S-1-\d+(?:-\d+)+$/i;

// FileSystemRights bits (winnt.h / System.Security.AccessControl.FileSystemRights).
const rights = {
  readData: 0x1, writeData: 0x2, appendData: 0x4, readEa: 0x8, writeEa: 0x10,
  execute: 0x20, deleteChild: 0x40, readAttributes: 0x80, writeAttributes: 0x100,
  delete: 0x10000, readControl: 0x20000, writeDac: 0x40000, writeOwner: 0x80000,
  synchronize: 0x100000,
  genericAll: 0x10000000, genericExecute: 0x20000000, genericWrite: 0x40000000, genericRead: 0x80000000,
};
// Minimum rights the service account needs on the storage root and every area
// directory: enumerate, create files and directories, delete/ rename temp
// objects and quarantined files, read attributes and the security descriptor.
const requiredDirectoryRights = rights.readData | rights.writeData | rights.appendData |
  rights.readAttributes | rights.delete | rights.readControl;

export function isSid(value) {
  return typeof value === 'string' && sidPattern.test(value);
}

function norm(path) {
  return resolve(path).toLowerCase();
}

function under(child, parent) {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

// The storage root, every parent up to the trusted boundary (or the volume
// root when no boundary is configured), plus optional extra directories.
// A writable parent can replace a guarded subtree, so every parent below the
// boundary is in scope. The boundary itself is always guarded: configuring a
// boundary never skips validation of any directory that can delete, rename or
// replace the storage tree. Only ancestors ABOVE the boundary are excluded,
// and the boundary must be hardened, so actors above it can at most remove or
// rename the whole store (availability), never inject or read content.
export function guardPaths(root, extra = [], trustRoot = null) {
  const boundary = trustRoot ? resolve(trustRoot) : null;
  if (boundary && !under(resolve(root), boundary)) {
    throw new Error('Trust root is not an ancestor of the storage root');
  }
  const paths = [];
  let current = resolve(root);
  for (;;) {
    paths.push(current);
    if (boundary && norm(current) === norm(boundary)) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const path of extra) {
    const absolute = resolve(path);
    if (!paths.some(existing => norm(existing) === norm(absolute))) paths.push(absolute);
  }
  return paths;
}

// One PowerShell process resolves every path and the caller identity to SIDs.
// Paths travel as base64 JSON embedded in the script, never interpolated as shell text.
// Rights are emitted numerically so generic composite ACEs are machine-checkable.
function scriptFor(paths, accountName) {
  const payload = Buffer.from(JSON.stringify({ paths, accountName }), 'utf8').toString('base64');
  return [
    "$ErrorActionPreference='Stop'",
    // PowerShell 7 module paths inherited by Node can shadow Windows PowerShell
    // 5.1 security cmdlets. Use the modules belonging to the selected host.
    "$env:PSModulePath=Join-Path $PSHOME 'Modules'",
    `$spec=ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')))`,
    '$identity=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
    '$accountSid=$null',
    'if($spec.accountName){$accountSid=(New-Object Security.Principal.NTAccount($spec.accountName)).Translate([Security.Principal.SecurityIdentifier]).Value}',
    '$results=[System.Collections.Generic.List[object]]::new()',
    'foreach($p in $spec.paths){',
    '  $a=Get-Acl -LiteralPath $p',
    '  $aces=[System.Collections.Generic.List[object]]::new()',
    '  foreach($ace in $a.Access){',
    "    try{$sid=$ace.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value}catch{$sid='UNRESOLVED'}",
    "    $aces.Add([pscustomobject]@{sid=$sid;allow=([string]$ace.AccessControlType -eq 'Allow');inherited=[bool]$ace.IsInherited;rights=[int64]$ace.FileSystemRights})",
    '  }',
    "  try{$owner=(New-Object Security.Principal.NTAccount($a.Owner)).Translate([Security.Principal.SecurityIdentifier]).Value}catch{$owner='UNRESOLVED'}",
    '  $results.Add([pscustomobject]@{path=$p;protected=[bool]$a.AreAccessRulesProtected;owner=$owner;aces=$aces.ToArray()})',
    '}',
    'ConvertTo-Json -InputObject ([pscustomobject]@{identitySid=$identity;accountSid=$accountSid;results=$results.ToArray()}) -Compress -Depth 8',
  ].join('\n');
}

function probeArgs(paths, accountName) {
  const encoded = Buffer.from(scriptFor(paths, accountName), 'utf16le').toString('base64');
  const shell = process.env.SystemRoot
    ? join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell';
  return [shell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded]];
}

// Any failure to observe the ACL is a failure, never a reason to open.
function parseProbeResult(result, paths) {
  if (result.error || result.status !== 0 || typeof result.stdout !== 'string' || !result.stdout.trim())
    throw new Error('ACL probe failed');
  let raw;
  try { raw = JSON.parse(result.stdout.trim()); } catch { throw new Error('ACL probe unreadable'); }
  const results = Array.isArray(raw.results) ? raw.results : [raw.results];
  if (!isSid(raw.identitySid) || results.length !== paths.length) throw new Error('ACL probe incomplete');
  return {
    identitySid: String(raw.identitySid).toUpperCase(),
    accountSid: raw.accountSid ? String(raw.accountSid).toUpperCase() : null,
    results,
  };
}

// Default probe. Injectable: tests supply a deterministic stub; a real Windows
// ACL integration test is marked separately and never mutates any ACL.
// inspect() is synchronous and may only be used for the one-shot startup
// assertion. inspectAsync() uses a non-blocking child process so readiness
// re-checks never block the Node.js event loop.
export function createWindowsAclProbe() {
  const win32 = () => {
    if (process.platform !== 'win32') throw new Error('ACL probe unavailable');
  };
  return {
    inspect(paths, accountName = null) {
      win32();
      const [shell, args] = probeArgs(paths, accountName);
      return parseProbeResult(spawnSync(shell, args, {
        encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 8 * 1024 * 1024,
      }), paths);
    },
    inspectAsync(paths, accountName = null) {
      win32();
      const [shell, args] = probeArgs(paths, accountName);
      return new Promise((resolvePromise, rejectPromise) => {
        let stdout = '';
        let settled = false;
        const child = spawn(shell, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
        const finish = (error, status) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          try { resolvePromise(parseProbeResult({ error, status, stdout }, paths)); }
          catch (probeError) { rejectPromise(probeError); }
        };
        const timer = setTimeout(() => { child.kill(); finish(new Error('ACL probe timeout'), null); }, 30000);
        child.stdout.on('data', chunk => {
          stdout += chunk;
          if (stdout.length > 8 * 1024 * 1024) { child.kill(); finish(new Error('ACL probe overflow'), null); }
        });
        child.once('error', error => finish(error, null));
        child.once('close', code => finish(null, code));
      });
    },
  };
}

// Enum rights to a specific-rights mask. Generic composites (often the only
// content of ACEs created by legacy tooling) are expanded to the concrete
// rights they imply. Unparseable rights yield -1 so no required bit ever passes.
function expandRights(value) {
  const raw = Number(value);
  if (!Number.isInteger(raw)) return -1;
  const bits = raw >>> 0;
  let mask = bits & 0x1ffffff;
  if (bits & rights.genericRead)
    mask |= rights.readData | rights.readEa | rights.readAttributes | rights.execute | rights.readControl | rights.synchronize;
  if (bits & rights.genericWrite)
    mask |= rights.writeData | rights.appendData | rights.writeEa | rights.readAttributes | rights.readControl | rights.synchronize;
  if (bits & rights.genericExecute)
    mask |= rights.execute | rights.readAttributes | rights.readControl | rights.synchronize;
  if (bits & rights.genericAll) mask |= 0x1ffffff;
  return mask;
}

function prepareContext({ root, paths, account, accountSid, extraSids = [], trustRoot = null, accountPaths = null }, info) {
  const expected = isSid(accountSid) ? accountSid : isSid(account) ? account : info?.accountSid;
  if (!isSid(expected)) throw new Error('ACL account unresolved');
  const expectedSid = expected.toUpperCase();
  const allowed = new Set([...trustedSids, expectedSid, ...extraSids.map(sid => String(sid).toUpperCase())]);
  return {
    paths: paths.map(path => resolve(path)),
    expectedSid,
    allowed,
    accountPaths: (accountPaths ?? [resolve(root)]).map(path => resolve(path)),
    protectedPaths: trustRoot ? [resolve(root), resolve(trustRoot)] : [resolve(root)],
  };
}

// Pure evaluation of probe output. Fail closed on: identity mismatch, any
// broad/ unknown/ unresolved principal on any guarded path, an untrusted or
// unresolved owner, a Deny ACE that would strip a right the service needs,
// insufficient service-account rights where they are required, missing probe
// data, or inheritance left enabled on the storage root or the trust boundary.
function evaluateAcl(info, context) {
  if (String(info.identitySid).toUpperCase() !== context.expectedSid) throw new Error('ACL identity mismatch');
  const byPath = new Map();
  for (const entry of info.results) {
    if (!entry || typeof entry.path !== 'string' || !Array.isArray(entry.aces)) throw new Error('ACL probe incomplete');
    byPath.set(norm(entry.path), entry);
  }
  const accountPaths = new Set(context.accountPaths.map(norm));
  for (const path of context.paths) {
    const entry = byPath.get(norm(path));
    if (!entry) throw new Error('ACL probe incomplete');
    const owner = typeof entry.owner === 'string' ? entry.owner.toUpperCase() : '';
    if (!context.allowed.has(owner)) throw new Error('ACL untrusted owner');
    let accountAllow = 0;
    for (const ace of entry.aces) {
      const sid = typeof ace.sid === 'string' ? ace.sid.toUpperCase() : '';
      if (!isSid(sid)) throw new Error('ACL unresolved principal');
      const mask = expandRights(ace.rights);
      if (ace.allow) {
        if (forbiddenSids.has(sid) || !context.allowed.has(sid)) throw new Error('ACL broad or unknown principal');
        if (sid === context.expectedSid && mask > 0) accountAllow |= mask;
      } else if (context.allowed.has(sid) && mask > 0 && (mask & requiredDirectoryRights) !== 0) {
        // A deny that could strip a right the service needs: cannot judge -> refuse.
        throw new Error('ACL denies the service principal');
      }
    }
    if (accountPaths.has(norm(path)) && (accountAllow & requiredDirectoryRights) !== requiredDirectoryRights)
      throw new Error('ACL service account rights insufficient');
  }
  for (const protectedPath of context.protectedPaths) {
    const entry = byPath.get(norm(protectedPath));
    if (!entry || entry.protected !== true) throw new Error('ACL inheritance not disabled');
  }
  return { accountSid: context.expectedSid, paths: context.paths };
}

function accountNameFor({ account, accountSid }) {
  return isSid(accountSid) || isSid(account) ? null : account;
}

// Synchronous one-shot assertion (startup). Blocks the event loop once; the
// readiness path must use assertStorageAclAsync instead.
export function assertStorageAcl(options) {
  const info = options.probe.inspect(options.paths, accountNameFor(options));
  return evaluateAcl(info, prepareContext(options, info));
}

// Asynchronous assertion for readiness re-checks. Requires a probe that can
// inspect without blocking the event loop; absence of that capability is a
// failure, never a reason to skip the check.
export async function assertStorageAclAsync(options) {
  if (typeof options.probe?.inspectAsync !== 'function') throw new Error('ACL probe unavailable');
  const info = await options.probe.inspectAsync(options.paths, accountNameFor(options));
  return evaluateAcl(info, prepareContext(options, info));
}
