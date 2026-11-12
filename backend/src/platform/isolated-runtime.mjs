import { readFile, writeFile, unlink } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { callChannel, checkChannel } from './service-channel.mjs';
import { sha256, safeRoot, promoteResources, isId, validateManifest, readBound } from './serving-store.mjs';
import { AppError } from './errors.mjs';

export async function readRuntimeConfig(path, role) {
  const config = JSON.parse(await readFile(path, 'utf8'));
  if (config.role !== role || config.version !== 1) throw Error('Invalid runtime role');
  for (const name of ['auth', 'validator', 'control']) if (config[name]) {
    config[name].key = (await readFile(config[name].keyFile, 'utf8')).trim();
    checkChannel(config[name]);
  }
  for (const name of ['servingRoot', 'inboxRoot', 'stageRoot']) if (config[name]) {
    if (!isAbsolute(config[name])) throw Error('Runtime paths must be absolute');
    await safeRoot(config[name]);
  }
  return config;
}
export function validationClient(runtime, limits) {
  return async (bytes, id) => {
    if (!isId(id) || bytes.length > limits.compressed) throw new AppError('ZIP_LIMIT', 400, '压缩包过大');
    const digest = sha256(bytes);
    await writeFile(join(await safeRoot(runtime.inboxRoot), id), bytes, { flag: 'wx' });
    let result;
    try { result = await callChannel(runtime.validator, { action: 'validate', id, digest, size: bytes.length }, 120000); }
    finally { await unlink(join(runtime.inboxRoot, id)); }
    if (result.rejected) return result;
    if (!['clean', 'infected', 'error'].includes(result.status) || !Array.isArray(result.findings) || result.findings.length > limits.files * 3) throw Error('Invalid validation result');
    if (result.status === 'clean') {
      validateManifest(result.manifest, digest, limits);
      result.serving = await promoteResources({ ...runtime, id, manifest: result.manifest, limits });
    }
    return result;
  };
}
export async function resourcePermit(runtime, version, path, limits) {
  const expected = version.metadata.serving;
  if (!expected) throw new AppError('REVALIDATION_REQUIRED', 503, '此版本需重新进行隔离校验');
  const root = join(runtime.servingRoot, version.id);
  const manifest = validateManifest(JSON.parse(await readBound(root, expected.digest, expected.digest, expected.size, 262144)), version.digest, limits);
  const entry = manifest.files.find(file => file.path === path);
  if (!entry && path !== '__platform_bridge.mjs') throw new AppError('NOT_FOUND', 404, '资源不存在');
  return { id: version.id, metadata: { domains: version.metadata.domains }, entry: entry ?? null };
}
