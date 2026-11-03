import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { loadConfig } from '../backend/src/config.mjs';
import { createLogger } from '../backend/src/platform/logger.mjs';
import { publicError } from '../backend/src/platform/errors.mjs';
import { createPrivateStorage } from '../backend/src/platform/storage.mjs';
import { createApp } from '../backend/src/app.mjs';
import { appendAudit } from '../backend/src/modules/audit/repository.mjs';
import { migrate, migrationFiles } from '../backend/src/platform/migrations.mjs';

test('development runs without fabricated credentials; configuration rejects unsafe boundaries', () => {
  const config = loadConfig({});
  assert.equal(config.databaseUrl, null);
  assert.equal(config.sessionSecret, null);
  assert.equal(config.host, '127.0.0.1');
  for (const env of [
    { APP_ENV: 'staging' }, { PORT: '0' }, { PORT: 'abc' }, { HOST: '0.0.0.0' },
    { GAME_ORIGIN: 'http://127.0.0.1:9999' }, { MAIN_ORIGIN: 'https://host.example', GAME_ORIGIN: 'https://games.host.example' },
    { DATABASE_URL: 'postgres://app_test:private@localhost/ai_games_production' },
    { DATABASE_URL: 'postgres://app_development:private@localhost/ai_games_development?sslmode=no-verify' },
    { DATABASE_URL: 'broken-private-value' }, { SESSION_SECRET: 'short' },
    { OBJECT_STORAGE_ENDPOINT: 'http://127.0.0.1:9000' },
    { OBJECT_STORAGE_ENDPOINT: 'http://127.0.0.1:9000', OBJECT_STORAGE_BUCKET: 'games-production' },
    { APP_ENV: 'production' },
  ]) assert.throws(() => loadConfig(env), /Invalid configuration/);
  assert.doesNotThrow(() => loadConfig({ APP_ENV: 'test', DATABASE_URL: 'postgres://app_test:synthetic@localhost/ai_games_test' }));
  const production = { APP_ENV: 'production', DATABASE_URL: 'postgres://app_production:synthetic@db/ai_games_production',
    MAIN_ORIGIN: 'https://platform.example', GAME_ORIGIN: 'https://games.example.net',
    OBJECT_STORAGE_ENDPOINT: 'https://storage.example', OBJECT_STORAGE_BUCKET: 'games-production', SESSION_SECRET: 'x'.repeat(32) };
  assert.equal(loadConfig(production).databaseTls, 'verify-full');
  assert.throws(() => loadConfig({ ...production, DATABASE_TLS: 'disable' }));
});

test('logger and public errors do not expose arbitrary exception or credential fields', () => {
  const output = [];
  const log = createLogger(line => output.push(line));
  log('http.request', { requestId: 'test', route: 'unmatched', status: 404,
    password: 'DO_NOT_LOG', url: '/?token=DO_NOT_LOG', headers: { authorization: 'DO_NOT_LOG' }, error: new Error('DO_NOT_LOG') });
  assert.equal(output.join('').includes('DO_NOT_LOG'), false);
  assert.equal(JSON.parse(output[0]).status, 404);
  assert.equal(publicError(new Error('DO_NOT_LOG'), 'test').body.error.code, 'INTERNAL_ERROR');
  assert.equal(JSON.stringify(publicError(new Error('DO_NOT_LOG'), 'test')).includes('DO_NOT_LOG'), false);
});

test('HTTP liveness, unavailable readiness, method/route errors and query secrecy over real sockets', async t => {
  const logs = [];
  const config = loadConfig({});
  const app = createApp({ config, database: null, storage: createPrivateStorage(config), log: createLogger(line => logs.push(line)) });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  t.after(() => new Promise(resolve => { app.close(resolve); app.closeAllConnections(); }));
  const base = `http://127.0.0.1:${app.address().port}`;
  const live = await fetch(`${base}/health/live?token=DO_NOT_LOG`, { headers: { authorization: 'DO_NOT_LOG', 'x-request-id': 'DO_NOT_LOG' } });
  assert.equal(live.status, 200);
  assert.equal(live.headers.get('cache-control'), 'no-store');
  const data = await live.json();
  assert.equal(data.status, 'alive');
  assert.equal(live.headers.get('x-request-id'), data.requestId);
  assert.notEqual(data.requestId, 'DO_NOT_LOG');
  const ready = await fetch(`${base}/health/ready`);
  assert.equal(ready.status, 503);
  assert.equal((await ready.json()).error.code, 'DEPENDENCIES_NOT_READY');
  const missing = await fetch(`${base}/DO_NOT_LOG`);
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, 'NOT_FOUND');
  const post = await fetch(`${base}/health/live`, { method: 'POST', body: 'DO_NOT_LOG' });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('allow'), 'GET, HEAD');
  const head = await fetch(`${base}/health/live`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.equal(logs.join('').includes('DO_NOT_LOG'), false);
});

test('HTTP readiness checks schema identity and storage; dependency exceptions remain private', async t => {
  const migrations = await migrationFiles();
  let fail = false;
  const app = createApp({ config: loadConfig({ APP_ENV: 'test' }), log: () => {},
    database: { query: async sql => {
      if (fail) throw new Error('password=DO_NOT_LOG');
      return { rows: sql.includes('schema_migrations') ? migrations : [{ environment: 'test' }] };
    } }, storage: { health: async () => true } });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  t.after(() => new Promise(resolve => { app.close(resolve); app.closeAllConnections(); }));
  const url = `http://127.0.0.1:${app.address().port}/health/ready`;
  assert.equal((await fetch(url)).status, 200);
  fail = true;
  const res = await fetch(url);
  assert.equal(res.status, 503);
  assert.equal((await res.text()).includes('DO_NOT_LOG'), false);
});

test('private storage fails closed and confines object keys and immutable writes', async () => {
  const calls = [];
  const config = loadConfig({ APP_ENV: 'test', OBJECT_STORAGE_ENDPOINT: 'http://127.0.0.1:9000', OBJECT_STORAGE_BUCKET: 'games-test' });
  const disabled = createPrivateStorage(config);
  assert.equal(await disabled.health(), false);
  await assert.rejects(disabled.get('quarantine', 'id'), { code: 'STORAGE_UNAVAILABLE' });
  const storage = createPrivateStorage(config, { checkPrivate: async () => true,
    put: async args => calls.push(args), get: async args => args.key });
  assert.equal(await storage.health(), true);
  assert.equal(await storage.put('quarantine', 'object-1', new Uint8Array([1])), 'test/quarantine/object-1');
  assert.equal(calls[0].visibility, 'private');
  assert.equal(calls[0].ifAbsent, true);
  assert.equal(calls[0].bucket, 'games-test');
  assert.equal(await storage.get('review', 'id'), 'test/review/id');
  for (const id of ['../secret', '/absolute', 'a/b', 'a\\b', '%2e%2e', '']) await assert.rejects(storage.get('quarantine', id));
  await assert.rejects(storage.get('public', 'id'));
});

test('audit writes parameterized minimal events and refuses unregistered data', async () => {
  const calls = [];
  const client = { query: async (...args) => calls.push(args) };
  const event = { action: 'system.error', requestId: randomUUID(), outcome: 'failure' };
  const id = await appendAudit(client, event);
  assert.ok(calls[0][0].includes('$1'));
  assert.deepEqual(calls[0][1], [id, event.action, event.requestId, 'failure']);
  await assert.rejects(appendAudit(client, { ...event, password: 'private' }));
  await assert.rejects(appendAudit(client, { ...event, action: 'results.publish' }));
  await assert.rejects(appendAudit(client, { ...event, requestId: "'; DROP TABLE x;" }));
  assert.equal(calls.length, 1);
});

test('migration failure rolls back and releases its dedicated client; production denied', async () => {
  const calls = [];
  let released = false;
  const pool = { connect: async () => ({ query: async sql => {
    calls.push(sql);
    if (sql.includes('to_regclass')) return { rows: [{ name: null }] };
    if (sql.startsWith('SELECT id')) return { rows: [] };
    if (sql.startsWith('CREATE SCHEMA')) throw new Error('simulated DDL failure');
    return { rows: [] };
  }, release: () => { released = true; } }) };
  await assert.rejects(migrate(pool, 'test', 'up'), /simulated DDL failure/);
  assert.equal(calls.at(-1), 'ROLLBACK');
  assert.equal(calls.includes('COMMIT'), false);
  assert.ok(calls.includes('SELECT pg_advisory_xact_lock(432001)'));
  assert.equal(released, true);
  await assert.rejects(migrate(pool, 'production', 'up'), /Production migration/);
});
