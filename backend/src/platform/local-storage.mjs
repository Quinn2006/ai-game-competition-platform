import { mkdir, readFile, writeFile, lstat } from 'node:fs/promises';
import { resolve, join } from 'node:path';

// Development only: outside the web root, opaque keys, exclusive immutable writes.
export function createLocalStorage(root, environment) {
  if (!['development', 'test'].includes(environment)) throw new Error('Local storage is development/test only');
  const base = resolve(root);
  async function pathFor(area, id) {
    if (!['quarantine', 'review', 'release'].includes(area) || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error('Invalid object key');
    const directory = join(base, environment, area);
    await mkdir(directory, { recursive: true });
    for (const path of [base, join(base, environment), directory]) if ((await lstat(path)).isSymbolicLink()) throw new Error('Storage symlink refused');
    return join(directory, id);
  }
  return {
    async health() { await pathFor('quarantine', 'health'); return true; },
    async put(area, id, bytes) {
      const path=await pathFor(area,id);
      try { await writeFile(path, bytes, { flag: 'wx', mode: 0o600 }); }
      catch(error) {
        if(error.code!=='EEXIST' || (await lstat(path)).isSymbolicLink() || !(await readFile(path)).equals(bytes)) throw error;
      }
    },
    async get(area, id) {
      const path = await pathFor(area, id);
      if ((await lstat(path)).isSymbolicLink()) throw new Error('Storage symlink refused');
      return readFile(path);
    },
  };
}
