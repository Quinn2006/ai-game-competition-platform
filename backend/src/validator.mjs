import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inspectZip } from './modules/uploads/zip.mjs';
import { createScanner } from './modules/uploads/scanner.mjs';
import { serveChannel } from './platform/service-channel.mjs';
import { readRuntimeConfig } from './platform/isolated-runtime.mjs';
import { sha256, isId, safeRoot, readBound } from './platform/serving-store.mjs';
import { AppError } from './platform/errors.mjs';

export async function startValidator(config) {
  const scan = createScanner({ port: config.scannerPort });
  let busy = false;
  return serveChannel(config.validator, async input => {
    if (input?.action === 'health') return { ready: (await scan(Buffer.from('isolated validator readiness'))).status === 'clean', busy, pid: process.pid };
    if (input?.action !== 'validate' || !isId(input.id)) throw new AppError('INVALID_JOB', 400, '无效任务');
    if (busy) throw new AppError('VALIDATOR_BUSY', 429, '校验繁忙');
    busy = true;
    const deadline = setTimeout(() => process.exit(1), 110000);
    try {
      const bytes = await readBound(config.inboxRoot, input.id, input.digest, input.size, config.limits.compressed);
      let result = await scan(bytes), archive;
      try { archive = await inspectZip(bytes, config.limits); }
      catch (error) { return { rejected: true, code: error.code ?? 'INVALID_ZIP' }; }
      if (archive.files.has('__platform_bridge.mjs')) return { rejected: true, code: 'RESERVED_PATH' };
      if (result.status === 'clean') for (const bytes of archive.files.values()) { result = await scan(bytes); if (result.status !== 'clean') break; }
      if (result.status !== 'clean') return { ...result, findings: archive.findings };
      const root = join(await safeRoot(config.stageRoot), input.id); await mkdir(root);
      const files = [], written = new Set();
      for (const [path, data] of archive.files) {
        const digest = sha256(data);
        if (!written.has(digest)) await writeFile(join(root, digest), data, { flag: 'wx' });
        written.add(digest); files.push({ path, digest, size: data.length });
      }
      return { ...result, findings: archive.findings, manifest: { archive: input.digest, files } };
    } finally { clearTimeout(deadline); busy = false; }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const runtime = await startValidator(await readRuntimeConfig(process.argv[2], 'validator'));
    for (const event of ['SIGINT', 'SIGTERM']) process.on(event, () => runtime.close());
  } catch { console.error('Validator startup failed'); process.exitCode = 1; }
}
