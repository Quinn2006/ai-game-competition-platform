import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readlink, realpath, link, unlink, rename, readdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertStorageAcl, createWindowsAclProbe, guardPaths } from './acl.mjs';

// Production-only private NTFS store. Same driver contract as the object-store
// supplier (checkPrivate / put / get); never served as a public static directory.
const projectRoot = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const areas = ['incoming', 'quarantine', 'review', 'release', 'serving'];
const chunkSize = 1024 * 1024;
const digestPattern = /^[a-f0-9]{64}$/;

function under(child, parent) {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function samePath(left, right) {
  const norm = path => {
    const value = resolve(path).replace(/^\\\\\?\\/, '');
    return process.platform === 'win32' ? value.toLowerCase() : value;
  };
  return norm(left) === norm(right);
}

// lstat alone reports a Windows junction as a directory; readlink + realpath
// are combined so symlinks, junctions and other reparse points are refused.
async function assertPrivate(path, kind) {
  let stat;
  try { stat = await lstat(path); } catch { throw new Error('Private storage unavailable'); }
  if (stat.isSymbolicLink()) throw new Error('Private storage link refused');
  let target = null;
  try { target = await readlink(path); }
  catch (error) {
    if (!['EINVAL', 'UNKNOWN', 'ENOENT', 'ENOTSUP', 'EPERM'].includes(error.code)) throw error;
  }
  if (target) throw new Error('Private storage link refused');
  if (!samePath(await realpath(path), path)) throw new Error('Private storage link refused');
  if (kind === 'directory' && !stat.isDirectory()) throw new Error('Private storage layout refused');
  if (kind === 'file' && !stat.isFile()) throw new Error('Private storage object refused');
  return stat;
}

// One pass over an already-open fd: SHA-256 + optional byte collection.
// No readFile() of the whole object is used for comparison (200MB safe).
async function scanHandle(handle, size, collect = false) {
  const hash = createHash('sha256');
  const chunks = collect ? [] : null;
  const buffer = Buffer.allocUnsafe(Math.min(chunkSize, Math.max(size, 1)));
  let position = 0;
  while (position < size) {
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - position), position);
    if (bytesRead <= 0) break;
    const slice = buffer.subarray(0, bytesRead);
    hash.update(slice);
    if (collect) chunks.push(Buffer.from(slice));
    position += bytesRead;
  }
  return { digest: hash.digest('hex'), size: position, bytes: collect ? Buffer.concat(chunks) : null };
}

export function createProductionLocalStorageDriver(config, deps = {}) {
  if (config?.environment !== 'production' || config?.storage?.driver !== 'local' ||
      !config.storage.root || config.storage.endpoint || config.storage.bucket) {
    throw new Error('Invalid production local storage configuration');
  }
  const root = resolve(config.storage.root);
  const forbidden = [resolve(projectRoot, 'frontend'), resolve(projectRoot, 'backend'),
    resolve(projectRoot, 'data/postgres'), resolve(projectRoot, 'data/backups')];
  if (root === projectRoot || forbidden.some(dir => under(root, dir))) throw new Error('Private storage root refused');
  const environment = config.environment;
  const envDir = join(root, environment);
  const areaDirs = areas.map(area => join(envDir, area));
  const orphanRoot = join(root, '_orphans');
  const keyPattern = new RegExp(`^${environment}/(${areas.join('|')})/([a-zA-Z0-9_-]{1,128})$`);
  const probe = deps.aclProbe ?? createWindowsAclProbe();
  const hooks = deps.hooks ?? {};
  const aclOptions = { root, account: config.storage.account, accountSid: config.storage.accountSid,
    extraSids: config.storage.extraSids ?? [], probe };
  // Startup assertion: synchronous, inside server.mjs try-block. A refusal here
  // prevents app.listen entirely (fail closed). Only root + parent chain is
  // required; area directories are created and checked at readiness.
  assertStorageAcl({ ...aclOptions, paths: guardPaths(root) });

  const locks = new Map();
  let orphansIsolated = false;

  function pathFor(key) {
    const match = typeof key === 'string' ? keyPattern.exec(key) : null;
    if (!match) throw new Error('Invalid private storage key');
    const path = join(root, environment, match[1], match[2]);
    const rel = relative(root, path);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Invalid private storage key');
    return path;
  }
  const metaPathFor = path => join(dirname(path), `.${basename(path)}.meta`);
  const tmpPathFor = path => join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);

  async function ensureLayout() {
    await mkdir(root, { recursive: true, mode: 0o700 });
    await assertPrivate(root, 'directory');
    await mkdir(envDir, { recursive: true, mode: 0o700 });
    await assertPrivate(envDir, 'directory');
    for (const dir of areaDirs) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await assertPrivate(dir, 'directory');
    }
  }

  // Restart recovery: move leftover .tmp files into a quarantined, non-addressable
  // area. Never republished, never silently deleted.
  async function isolateOrphans() {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const destination = join(orphanRoot, stamp);
    let created = false;
    for (const dir of areaDirs) {
      for (const name of await readdir(dir)) {
        if (!name.startsWith('.') || !name.endsWith('.tmp')) continue;
        if (!created) {
          await mkdir(destination, { recursive: true, mode: 0o700 });
          await assertPrivate(destination, 'directory');
          created = true;
        }
        await rename(join(dir, name), join(destination, `${basename(dir)}-${name}`));
      }
    }
  }

  // Windows: Node cannot fsync a directory handle. Best effort, reported as
  // unproven rather than claimed as a durability guarantee.
  async function syncDirectoryBestEffort(dir) {
    let handle = null;
    try { handle = await open(dir, 'r'); await handle.sync(); }
    catch { /* unsupported on Windows */ }
    finally { await handle?.close().catch(() => {}); }
  }

  // Idempotent verification of an already published object, by fd only.
  async function verifyPublished(target, digest, size) {
    await assertPrivate(target, 'file');
    const handle = await open(target, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size !== size) throw new Error('Private storage immutable write refused');
      const checked = await scanHandle(handle, size);
      if (checked.size !== size || checked.digest !== digest) throw new Error('Private storage immutable write refused');
    } finally { await handle.close(); }
  }

  // Same-directory temp file -> fsync -> size/SHA-256 check -> atomic hard link.
  // NTFS link fails with EEXIST instead of overwriting, so the final path never
  // appears until a fully written, synced and verified inode exists.
  async function atomicPublish(target, bytes, size, digest) {
    const dir = dirname(target);
    await hooks.beforePublish?.();
    await assertPrivate(dir, 'directory');
    const tmp = tmpPathFor(target);
    let handle = null;
    let created = false;
    try {
      // wx+ = read/write + exclusive create; the same fd is used for write,
      // fsync, fstat and the streaming digest check (no extra path resolution).
      handle = await open(tmp, 'wx+', 0o600);
      const initial = await handle.stat();
      if (!initial.isFile()) throw new Error('Private storage temp refused');
      await handle.writeFile(bytes);
      await hooks.afterWrite?.();
      await handle.sync();
      const written = await handle.stat();
      if (written.size !== size) throw new Error('Private storage size refused');
      const checked = await scanHandle(handle, size);
      if (checked.size !== size || checked.digest !== digest) throw new Error('Private storage digest refused');
      await handle.close(); handle = null;
      try { await link(tmp, target); created = true; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        await verifyPublished(target, digest, size);
      }
      await syncDirectoryBestEffort(dir);
      return { created };
    } finally {
      await handle?.close().catch(() => {});
      await unlink(tmp).catch(() => {});
    }
  }

  async function readMeta(objectPath) {
    const meta = metaPathFor(objectPath);
    await assertPrivate(meta, 'file');
    const handle = await open(meta, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 4096) throw new Error('Private storage metadata refused');
      const raw = await scanHandle(handle, stat.size, true);
      const value = JSON.parse(raw.bytes.toString('utf8'));
      if (value?.v !== 1 || value.key !== objectPath || !digestPattern.test(value.sha256) ||
          !Number.isSafeInteger(value.size) || value.size < 0) throw new Error('Private storage metadata refused');
      return value;
    } finally { await handle.close(); }
  }

  // Per-key serialization: concurrent writers cannot read each other's half-written
  // temp files, and the losing writer is resolved through the same immutable check.
  function withKeyLock(key, task) {
    const previous = locks.get(key) ?? Promise.resolve();
    let release;
    const gate = new Promise(done => { release = done; });
    locks.set(key, gate);
    return (async () => {
      try { await previous.catch(() => {}); return await task(); }
      finally { if (locks.get(key) === gate) locks.delete(key); release(); }
    })();
  }

  return Object.freeze({
    async checkPrivate(args) {
      if (args?.driver !== 'local' || args?.bucket || args?.root !== config.storage.root) {
        throw new Error('Private storage driver mismatch');
      }
      await ensureLayout();
      if (!orphansIsolated) { await isolateOrphans(); orphansIsolated = true; }
      // Re-check at readiness: the root plus every area directory. The parent
      // chain was asserted at startup; keeping this to one probe call fits the
      // 2s readiness budget while still detecting a widened runtime ACL.
      assertStorageAcl({ ...aclOptions, paths: [root, ...areaDirs] });
      return true;
    },
    async put({ key, bytes, visibility, ifAbsent, bucket }) {
      if (visibility !== 'private' || ifAbsent !== true || bucket || !(bytes instanceof Uint8Array)) {
        throw new Error('Private storage write refused');
      }
      const path = pathFor(key);
      await ensureLayout();
      await assertPrivate(dirname(path), 'directory');
      await hooks.afterAssert?.();
      return withKeyLock(key, async () => {
        const size = bytes.length;
        const digest = createHash('sha256').update(bytes).digest('hex');
        const metaBytes = Buffer.from(JSON.stringify({ v: 1, key: path, size, sha256: digest }), 'utf8');
        const metaDigest = createHash('sha256').update(metaBytes).digest('hex');
        const object = await atomicPublish(path, bytes, size, digest);
        try {
          await atomicPublish(metaPathFor(path), metaBytes, metaBytes.length, metaDigest);
        } catch (error) {
          if (object.created) await unlink(path).catch(() => {});
          throw error;
        }
        await assertPrivate(path, 'file');
        return key;
      });
    },
    async get({ key, bucket, expectedDigest, expectedSize }) {
      if (bucket) throw new Error('Private storage read refused');
      const path = pathFor(key);
      await assertPrivate(dirname(path), 'directory');
      await assertPrivate(path, 'file');
      await hooks.beforeGet?.();
      const handle = await open(path, 'r');
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) throw new Error('Private storage object refused');
        const meta = await readMeta(path);
        if (meta.key !== path || stat.size !== meta.size) throw new Error('Private storage integrity refused');
        const checked = await scanHandle(handle, stat.size, true);
        if (checked.size !== meta.size || checked.digest !== meta.sha256) throw new Error('Private storage integrity refused');
        // Optional expected digest reuses platform.game_versions.digest (005) with
        // no database schema change; the sidecar digest is always verified.
        if (expectedDigest && checked.digest !== expectedDigest) throw new Error('Private storage integrity refused');
        if (expectedSize != null && stat.size !== expectedSize) throw new Error('Private storage integrity refused');
        return checked.bytes;
      } finally { await handle.close(); }
    },
  });
}
