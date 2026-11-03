import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';

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

export function isSid(value) {
  return typeof value === 'string' && sidPattern.test(value);
}

// The root, every parent up to the volume root, plus optional area directories.
// A writable parent can replace the whole root, so the parent chain is in scope.
export function guardPaths(root, extra = []) {
  const paths = [];
  let current = resolve(root);
  for (;;) {
    paths.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const path of extra) {
    const absolute = resolve(path);
    if (!paths.includes(absolute)) paths.push(absolute);
  }
  return paths;
}

function norm(path) {
  return resolve(path).toLowerCase();
}

// One PowerShell process resolves every path and the caller identity to SIDs.
// Paths travel as base64 JSON embedded in the script, never interpolated as shell text.
function scriptFor(paths, accountName) {
  const payload = Buffer.from(JSON.stringify({ paths, accountName }), 'utf8').toString('base64');
  return [
    "$ErrorActionPreference='Stop'",
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
    '    $aces.Add([pscustomobject]@{sid=$sid;allow=([string]$ace.AccessControlType -eq \'Allow\');inherited=[bool]$ace.IsInherited;rights=[string]$ace.FileSystemRights})',
    '  }',
    "  try{$owner=(New-Object Security.Principal.NTAccount($a.Owner)).Translate([Security.Principal.SecurityIdentifier]).Value}catch{$owner='UNRESOLVED'}",
    '  $results.Add([pscustomobject]@{path=$p;protected=[bool]$a.AreAccessRulesProtected;owner=$owner;aces=$aces.ToArray()})',
    '}',
    'ConvertTo-Json -InputObject ([pscustomobject]@{identitySid=$identity;accountSid=$accountSid;results=$results.ToArray()}) -Compress -Depth 8',
  ].join('\n');
}

// Default probe. Injectable: tests supply a deterministic stub; a real Windows
// ACL integration test is marked separately and never mutates any ACL.
export function createWindowsAclProbe() {
  const shell = process.env.SystemRoot
    ? join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell';
  return {
    inspect(paths, accountName = null) {
      if (process.platform !== 'win32') throw new Error('ACL probe unavailable');
      const encoded = Buffer.from(scriptFor(paths, accountName), 'utf16le').toString('base64');
      const result = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
        encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 8 * 1024 * 1024,
      });
      // Any failure to observe the ACL is a failure, never a reason to open.
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
    },
  };
}

// Fail closed: throws on any broad/unknown principal, unresolved identity,
// missing service account, enabled inheritance on the root, or probe failure.
export function assertStorageAcl({ root, paths, account, accountSid, extraSids = [], probe }) {
  const accountName = isSid(accountSid) || isSid(account) ? null : account;
  const info = probe.inspect(paths, accountName);
  const expected = isSid(accountSid) ? accountSid : isSid(account) ? account : info.accountSid;
  if (!isSid(expected)) throw new Error('ACL account unresolved');
  const expectedSid = expected.toUpperCase();
  if (String(info.identitySid).toUpperCase() !== expectedSid) throw new Error('ACL identity mismatch');
  const allowed = new Set([...trustedSids, expectedSid, ...extraSids.map(s => String(s).toUpperCase())]);
  const seen = new Set();
  for (const entry of info.results) {
    if (!entry || typeof entry.path !== 'string' || !Array.isArray(entry.aces)) throw new Error('ACL probe incomplete');
    seen.add(norm(entry.path));
    for (const ace of entry.aces) {
      if (!ace.allow) continue;
      const sid = typeof ace.sid === 'string' ? ace.sid.toUpperCase() : 'UNRESOLVED';
      if (forbiddenSids.has(sid) || !allowed.has(sid)) throw new Error('ACL broad or unknown principal');
    }
  }
  for (const path of paths) if (!seen.has(norm(path))) throw new Error('ACL probe incomplete');
  const rootEntry = info.results.find(entry => norm(entry.path) === norm(root));
  if (!rootEntry || rootEntry.protected !== true) throw new Error('ACL inheritance not disabled');
  if (!rootEntry.aces.some(ace => ace.allow && String(ace.sid).toUpperCase() === expectedSid))
    throw new Error('ACL service account missing');
  return { accountSid: expectedSid, paths };
}
