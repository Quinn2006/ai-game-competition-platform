import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { mkdir, readdir, rm, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../backend/src/config.mjs';
import { createApp } from '../backend/src/app.mjs';
import { createPrivateStorage } from '../backend/src/platform/storage.mjs';
import { createProductionLocalStorageDriver } from '../backend/src/platform/production-local-storage.mjs';
import { migrationFiles } from '../backend/src/platform/migrations.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const tmpRoot = join(projectRoot, 'tmp', `production-storage-${randomUUID()}`);

function productionEnv(root) {
  return {
    APP_ENV: 'production', HOST: '127.0.0.1',
    MAIN_ORIGIN: 'https://platform.example', GAME_ORIGIN: 'https://games.example.net',
    DATABASE_URL: 'postgres://app_production:synthetic@127.0.0.1:1/ai_games_production',
    DATABASE_TLS: 'verify-full', SESSION_SECRET: 'x'.repeat(32),
    PRIVATE_STORAGE_DRIVER: 'local', PRIVATE_STORAGE_ROOT: root,
  };
}

function storageFor(root) {
  const config = loadConfig(productionEnv(root));
  const driver = createProductionLocalStorageDriver(config);
  return { config, driver, storage: createPrivateStorage(config, driver) };
}

test('production local storage config is explicit, private and keeps every existing guard', async t => {
  const root = join(tmpRoot, 'config');
  const config = loadConfig(productionEnv(root));
  assert.equal(config.storage.driver, 'local');
  assert.equal(config.storage.endpoint, null);
  assert.equal(config.storage.bucket, null);
  assert.equal(config.storage.root, resolve(projectRoot, root));
  assert.equal(config.databaseTls, 'verify-full');
  assert.equal(config.localGames, false);

  for (const [name, env] of [
    ['missing root', { ...productionEnv(root), PRIVATE_STORAGE_ROOT: '' }],
    ['unknown driver', { ...productionEnv(root), PRIVATE_STORAGE_DRIVER: 's3' }],
    ['mixed object storage', { ...productionEnv(root), OBJECT_STORAGE_ENDPOINT: 'https://storage.example', OBJECT_STORAGE_BUCKET: 'games-production' }],
    ['local driver in development', { APP_ENV: 'development', PRIVATE_STORAGE_DRIVER: 'local', PRIVATE_STORAGE_ROOT: root }],
    ['local driver in test', { ...productionEnv(root), APP_ENV: 'test' }],
    ['root under frontend static tree', { ...productionEnv(root), PRIVATE_STORAGE_ROOT: 'frontend' }],
    ['root is backend source', { ...productionEnv(root), PRIVATE_STORAGE_ROOT: 'backend' }],
    ['root is postgres cluster', { ...productionEnv(root), PRIVATE_STORAGE_ROOT: 'data/postgres' }],
    ['root is project root', { ...productionEnv(root), PRIVATE_STORAGE_ROOT: '.' }],
    ['object config with root', { ...productionEnv(root), PRIVATE_STORAGE_DRIVER: 'object', OBJECT_STORAGE_ENDPOINT: 'https://storage.example', OBJECT_STORAGE_BUCKET: 'games-production' }],
    ['TLS downgraded', { ...productionEnv(root), DATABASE_TLS: 'disable' }],
    ['HTTP main origin', { ...productionEnv(root), MAIN_ORIGIN: 'http://platform.example' }],
    ['parent/child game origin', { ...productionEnv(root), GAME_ORIGIN: 'https://games.platform.example' }],
    ['weak secret', { ...productionEnv(root), SESSION_SECRET: 'short' }],
    ['local games in production', { ...productionEnv(root), LOCAL_GAMES: '1' }],
    ['unpaired object endpoint', { ...productionEnv(root), OBJECT_STORAGE_ENDPOINT: 'https://storage.example' }],
  ]) assert.throws(() => loadConfig(env), /Invalid configuration/, name);

  // The original object-storage production branch is unchanged.
  const objectConfig = loadConfig({ APP_ENV: 'production',
    DATABASE_URL: 'postgres://app_production:synthetic@db/ai_games_production',
    MAIN_ORIGIN: 'https://platform.example', GAME_ORIGIN: 'https://games.example.net',
    OBJECT_STORAGE_ENDPOINT: 'https://storage.example', OBJECT_STORAGE_BUCKET: 'games-production',
    SESSION_SECRET: 'x'.repeat(32) });
  assert.equal(objectConfig.storage.driver, 'object');
  assert.equal(objectConfig.storage.root, null);
  assert.equal(objectConfig.storage.bucket, 'games-production');
  t.after(async () => { await rm(resolve(projectRoot, root), { recursive: true, force: true }); });
});

test('development configuration and local storage remain unchanged', async () => {
  const development = loadConfig({});
  assert.equal(development.environment, 'development');
  assert.equal(development.storage.driver, 'object');
  assert.equal(development.storage.root, null);
  assert.equal(development.storage.bucket, null);
  const localGames = loadConfig({ LOCAL_GAMES: '1' });
  assert.equal(localGames.localGames, true);
  assert.equal(localGames.storage.driver, 'object');
  assert.equal(await createPrivateStorage(development).health(), false);
});

test('private storage boundary: driver required, areas confined, writes immutable and private', async t => {
  const root = join(tmpRoot, 'boundary');
  const { config, driver, storage } = storageFor(root);
  t.after(async () => { await rm(resolve(projectRoot, root), { recursive: true, force: true }); });

  assert.equal(await createPrivateStorage(config).health(), false);
  await assert.rejects(createPrivateStorage(config).get('quarantine', 'x'), { code: 'STORAGE_UNAVAILABLE' });
  assert.equal(await storage.health(), true);

  for (const area of ['incoming', 'quarantine', 'review', 'release', 'serving']) {
    const bytes = Buffer.from(`content-${area}`);
    const key = await storage.put(area, 'object-1', bytes);
    assert.equal(key, `production/${area}/object-1`);
    assert.deepEqual(await storage.get(area, 'object-1'), bytes);
    await storage.put(area, 'object-1', bytes); // idempotent retry
    await assert.rejects(storage.put(area, 'object-1', Buffer.from('changed'))); // immutable
  }
  await assert.rejects(storage.get('public', 'object-1'));
  for (const id of ['../secret', '/absolute', 'a/b', 'a\\b', '%2e%2e', '']) {
    await assert.rejects(storage.get('quarantine', id));
  }

  // No public write, no conditional overwrite, no bucket from object storage.
  for (const args of [
    { key: 'production/quarantine/x', bytes: Buffer.from('x'), visibility: 'public', ifAbsent: true },
    { key: 'production/quarantine/x', bytes: Buffer.from('x'), visibility: 'private', ifAbsent: false },
    { key: 'production/quarantine/x', bytes: Buffer.from('x'), visibility: 'private', ifAbsent: true, bucket: 'games-production' },
  ]) await assert.rejects(driver.put(args));
  for (const key of ['production/public/x', 'test/quarantine/x', 'production/quarantine/../x', 'production/quarantine/a/b']) {
    await assert.rejects(driver.get({ key }));
  }
  await assert.rejects(driver.get({ key: 'production/quarantine/missing' }));
});

test('production local driver refuses symlinks/junctions and forbidden roots', async t => {
  const root = join(tmpRoot, 'links');
  const absRoot = resolve(projectRoot, root);
  t.after(async () => { await rm(absRoot, { recursive: true, force: true }); });
  const { driver, storage } = storageFor(root);
  assert.equal(await storage.health(), true);

  // A Windows junction (reparse point) must be refused even when lstat treats it as a directory.
  const envDir = join(absRoot, 'production');
  const outside = join(absRoot, 'outside');
  await mkdir(outside, { recursive: true });
  await rm(join(envDir, 'incoming'), { recursive: true, force: true });
  let junction = false;
  try { await symlink(outside, join(envDir, 'incoming'), 'junction'); junction = true; } catch { /* platform may refuse */ }
  if (!junction) { t.skip('junction creation unavailable'); return; }
  await assert.rejects(driver.checkPrivate({ driver: 'local', root: loadConfig(productionEnv(root)).storage.root, bucket: null }));
  await assert.rejects(storage.put('incoming', 'x', Buffer.from('x')));
  await rm(join(envDir, 'incoming'), { recursive: true, force: true });
  assert.equal(await storage.health(), true);

  // Runtime guard also rejects a root inside the public static tree.
  assert.throws(() => createProductionLocalStorageDriver({ environment: 'production',
    storage: { driver: 'local', root: join(projectRoot, 'frontend'), endpoint: null, bucket: null } }));
  assert.throws(() => createProductionLocalStorageDriver({ environment: 'development',
    storage: { driver: 'local', root: absRoot, endpoint: null, bucket: null } }));
});

test('production readiness becomes 200 only with the injected driver and a valid schema', async t => {
  const root = join(tmpRoot, 'readiness');
  const { config, storage } = storageFor(root);
  t.after(async () => { await rm(resolve(projectRoot, root), { recursive: true, force: true }); });
  const migrations = await migrationFiles();
  const database = { query: async sql => sql.includes('schema_migrations')
    ? { rows: migrations.map(m => ({ id: m.id, checksum: m.checksum })) }
    : { rows: [{ environment: 'production' }] } };

  const ready = createApp({ config, database, storage, log: () => {} });
  ready.listen(0, '127.0.0.1');
  await once(ready, 'listening');
  t.after(() => new Promise(done => { ready.close(done); ready.closeAllConnections(); }));
  assert.equal((await fetch(`http://127.0.0.1:${ready.address().port}/health/ready`)).status, 200);

  const closed = createApp({ config, database, storage: createPrivateStorage(config), log: () => {} });
  closed.listen(0, '127.0.0.1');
  await once(closed, 'listening');
  t.after(() => new Promise(done => { closed.close(done); closed.closeAllConnections(); }));
  assert.equal((await fetch(`http://127.0.0.1:${closed.address().port}/health/ready`)).status, 503);
});

test('real server entry starts in production local mode and still fails closed without a database', { timeout: 15000 }, async t => {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(done => probe.close(done));
  const root = join(tmpRoot, 'startup');
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
    ...productionEnv(root), PORT: String(port) };
  const child = spawn(process.execPath, ['backend/src/server.mjs'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close');
      child.kill();
      await closed;
    }
    await rm(resolve(projectRoot, root), { recursive: true, force: true });
  });
  await new Promise((done, reject) => {
    let output = '';
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`Server exited before startup: ${code}`)));
    child.stdout.on('data', chunk => { output += chunk; if (output.includes('app.started')) done(); });
  });
  assert.equal((await fetch(`http://127.0.0.1:${port}/health/live`)).status, 200);
  assert.equal((await fetch(`http://127.0.0.1:${port}/health/ready`)).status, 503);
  // Stored works are never reachable as public static files.
  assert.equal((await fetch(`http://127.0.0.1:${port}/production/quarantine/object-1`)).status, 404);
  assert.equal((await fetch(`http://127.0.0.1:${port}/frontend/../production/quarantine/object-1`)).status, 404);
  const layout = await readdir(join(resolve(projectRoot, root), 'production'));
  assert.deepEqual(layout.sort(), ['incoming', 'quarantine', 'release', 'review', 'serving']);
});
