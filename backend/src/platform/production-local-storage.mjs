import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Production-only private NTFS store. It implements the same driver contract as
// the object-storage supplier (checkPrivate / put / get) and is never served as
// a public static directory. No object is exposed by URL or signed URL.
const projectRoot = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const areas = ['incoming', 'quarantine', 'review', 'release', 'serving'];

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

async function assertPrivate(path, kind) {
  let stat;
  try { stat = await lstat(path); } catch { throw new Error('Private storage unavailable'); }
  // lstat alone does not reliably classify Windows junctions; realpath resolves
  // every reparse point, so a redirected path is refused as well.
  if (stat.isSymbolicLink() || !samePath(await realpath(path), path)) throw new Error('Private storage link refused');
  if (kind === 'directory' && !stat.isDirectory()) throw new Error('Private storage layout refused');
  if (kind === 'file' && !stat.isFile()) throw new Error('Private storage object refused');
  return stat;
}

export function createProductionLocalStorageDriver(config) {
  if (config?.environment !== 'production' || config?.storage?.driver !== 'local' ||
      !config.storage.root || config.storage.endpoint || config.storage.bucket) {
    throw new Error('Invalid production local storage configuration');
  }
  const root = resolve(config.storage.root);
  const forbidden = [resolve(projectRoot, 'frontend'), resolve(projectRoot, 'backend'),
    resolve(projectRoot, 'data/postgres'), resolve(projectRoot, 'data/backups')];
  if (root === projectRoot || forbidden.some(dir => under(root, dir))) throw new Error('Private storage root refused');
  const environment = config.environment;
  const keyPattern = new RegExp(`^${environment}/(${areas.join('|')})/([a-zA-Z0-9_-]{1,128})$`);

  function pathFor(key) {
    const match = typeof key === 'string' ? keyPattern.exec(key) : null;
    if (!match) throw new Error('Invalid private storage key');
    const path = join(root, environment, match[1], match[2]);
    const rel = relative(root, path);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Invalid private storage key');
    return path;
  }

  async function ensureLayout() {
    await mkdir(root, { recursive: true, mode: 0o700 });
    await assertPrivate(root, 'directory');
    const envDir = join(root, environment);
    await mkdir(envDir, { recursive: true, mode: 0o700 });
    await assertPrivate(envDir, 'directory');
    for (const area of areas) {
      const dir = join(envDir, area);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await assertPrivate(dir, 'directory');
    }
  }

  return Object.freeze({
    async checkPrivate(args) {
      if (args?.driver !== 'local' || args?.bucket || args?.root !== config.storage.root) {
        throw new Error('Private storage driver mismatch');
      }
      await ensureLayout();
      return true;
    },
    async put({ key, bytes, visibility, ifAbsent, bucket }) {
      if (visibility !== 'private' || ifAbsent !== true || bucket || !(bytes instanceof Uint8Array)) {
        throw new Error('Private storage write refused');
      }
      const path = pathFor(key);
      await ensureLayout();
      await assertPrivate(dirname(path), 'directory');
      try {
        await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
      } catch (error) {
        if (error.code !== 'EEXIST') throw new Error('Private storage write refused');
        await assertPrivate(path, 'file');
        // Idempotent retry of identical bytes is allowed; changing an existing
        // object (including an approved release) is not.
        if (!(await readFile(path)).equals(Buffer.from(bytes))) throw new Error('Private storage immutable write refused');
      }
      await assertPrivate(path, 'file');
      return key;
    },
    async get({ key, bucket }) {
      if (bucket) throw new Error('Private storage read refused');
      const path = pathFor(key);
      await assertPrivate(dirname(path), 'directory');
      await assertPrivate(path, 'file');
      return readFile(path);
    },
  });
}
