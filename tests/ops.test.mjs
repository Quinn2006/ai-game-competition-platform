import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { dependenciesReady, createHealthMonitor } from '../src/platform/health.mjs';
import { localTarget, loadProbe } from '../scripts/ops-probe.mjs';

test('readiness times out hung drivers and handles synchronous/rejected failures', async () => {
  assert.equal(await dependenciesReady([() => new Promise(() => {})], 20), false);
  assert.equal(await dependenciesReady([() => { throw new Error('private'); }]), false);
  assert.equal(await dependenciesReady([async () => false]), false);
  assert.equal(await dependenciesReady([async () => true, () => true]), true);
});

test('monitor debounces, suppresses duplicates, reports recovery and retries failed delivery', async () => {
  const events = [];
  let fail = true;
  const observe = createHealthMonitor({ notify: async e => {
    if (fail) { fail = false; throw new Error('delivery unavailable'); }
    events.push(e.event);
  } });
  await observe(false); await observe(false);
  await assert.rejects(observe(false));
  await observe(false); await observe(false);
  await observe(true); await observe(false); await observe(true); await observe(true); await observe(true);
  assert.deepEqual(events, ['service.unavailable', 'service.recovered']);
});

test('bounded local load measures failures and refuses external targets and redirects', async t => {
  for (const value of ['https://example.com', 'http://localhost', 'http://127.0.0.1/?token=x', 'http://user:pass@127.0.0.1']) assert.throws(() => localTarget(value));
  let count = 0;
  const app = createServer((req,res) => {
    count++;
    res.writeHead(req.url === '/redirect' ? 302 : count % 2 ? 200 : 503, { location: 'http://example.com' });
    res.end();
  }).listen(0, '127.0.0.1');
  await once(app, 'listening');
  t.after(() => new Promise(resolve => { app.close(resolve); app.closeAllConnections(); }));
  const base = `http://127.0.0.1:${app.address().port}`;
  const result = await loadProbe(base, { requests: 20, concurrency: 4 });
  assert.equal(count, 20); assert.equal(result.errors, 10); assert.equal(result.errorRate, .5);
  assert.ok(result.p99Ms >= result.p50Ms);
  assert.equal((await loadProbe(`${base}/redirect`, { requests: 1 })).errors, 1);
  await assert.rejects(loadProbe(base, { requests: 10001 }));
});
