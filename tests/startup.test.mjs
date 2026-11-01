import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';

test('real server entry starts with absent dependencies and fails closed on invalid config', { timeout: 15000 }, async t => {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  // Child receives no developer secrets or ambient database settings.
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, APP_ENV: 'development', PORT: String(port) };
  const child = spawn(process.execPath, ['--env-file-if-exists=.env.startup-test-absent', 'src/server.mjs'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close');
      child.kill();
      await closed;
    }
  });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`Server exited before startup: ${code}`)));
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.includes('app.started')) resolve();
    });
  });
  const live = await fetch(`http://127.0.0.1:${port}/health/live`);
  assert.equal(live.status, 200);
  assert.equal((await live.json()).status, 'alive');
  assert.equal((await fetch(`http://127.0.0.1:${port}/health/ready`)).status, 503);
  const invalid = spawn(process.execPath, ['src/server.mjs'], { env: { ...env, PORT: 'invalid' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let invalidOutput = '';
  invalid.stdout.on('data', chunk => { invalidOutput += chunk; });
  const [exitCode] = await once(invalid, 'close');
  assert.equal(exitCode, 1);
  assert.ok(invalidOutput.includes('CONFIGURATION_ERROR'));
});
