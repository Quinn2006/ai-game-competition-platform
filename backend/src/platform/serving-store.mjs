import { createHash } from 'node:crypto';
import { lstat, open, mkdir, writeFile, rename, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { AppError } from './errors.mjs';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = () => { throw new AppError('ASSET_INTEGRITY', 503, '资源校验失败'); };
export const isDigest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const isId = value => typeof value === 'string' && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
export async function safeRoot(root) {
  root = resolve(root);
  const stat = await lstat(root); if (!stat.isDirectory() || stat.isSymbolicLink()) fail();
  // Resolving the complete path also catches ancestor junctions; do not demand
  // permission to enumerate private ancestors above the installed boundary.
  if ((await realpath(root)).toLowerCase() !== root.toLowerCase()) fail();
  return root;
}
export async function readBound(root, name, digest, size, maximum = 300000000) {
  if (!/^[a-f0-9-]{1,100}$/.test(name) || !isDigest(digest) || !Number.isSafeInteger(size) || size < 0 || size > maximum) fail();
  const path = join(await safeRoot(root), name), stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== size) fail();
  const file = await open(path, 'r');
  try {
    const actual = await file.stat();
    if (!actual.isFile() || actual.nlink !== 1 || actual.ino !== stat.ino || actual.dev !== stat.dev || actual.size !== size) fail();
    const bytes = Buffer.alloc(size); let offset = 0;
    while (offset < size) { const part = await file.read(bytes, offset, size - offset, offset); if (!part.bytesRead) fail(); offset += part.bytesRead; }
    if ((await file.stat()).size !== size || sha256(bytes) !== digest) fail();
    return bytes;
  } finally { await file.close(); }
}
export function validateManifest(manifest, digest, limits) {
  if (!manifest || manifest.archive !== digest || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > limits.files) fail();
  let total = 0; const paths = new Set();
  for (const entry of manifest.files) {
    if (typeof entry.path !== 'string' || entry.path.length > 240 || /[\\:%?#\x00-\x1f\x7f]/.test(entry.path) || entry.path.split('/').some(p => !p || p === '.' || p === '..') || paths.has(entry.path) || !isDigest(entry.digest) || !Number.isSafeInteger(entry.size) || entry.size < 0) fail();
    total += entry.size; paths.add(entry.path);
  }
  if (total > limits.expanded || !paths.has('index.html') || paths.has('__platform_bridge.mjs')) fail();
  return manifest;
}
// Main alone writes final serving files. Worker output is never served directly.
export async function promoteResources({ stageRoot, servingRoot, id, manifest, limits }) {
  if (!isId(id)) fail();
  validateManifest(manifest, manifest.archive, limits);
  const source = join(await safeRoot(stageRoot), id), target = join(await safeRoot(servingRoot), id);
  await mkdir(target); // Immutable version namespace: never overwrite/reuse.
  for (const entry of manifest.files) {
    const bytes = await readBound(source, entry.digest, entry.digest, entry.size, limits.expanded);
    try { await writeFile(join(target, entry.digest), bytes, { flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; await readBound(target, entry.digest, entry.digest, entry.size, limits.expanded); }
  }
  const bytes = Buffer.from(JSON.stringify(manifest));
  await writeFile(join(target, 'manifest-tmp'), bytes, { flag: 'wx' });
  await rename(join(target, 'manifest-tmp'), join(target, sha256(bytes)));
  return { digest: sha256(bytes), size: bytes.length };
}
