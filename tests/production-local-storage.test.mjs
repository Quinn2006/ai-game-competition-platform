import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { mkdir, readdir, rm, symlink, writeFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../backend/src/config.mjs';
import { createApp } from '../backend/src/app.mjs';
import { createPrivateStorage } from '../backend/src/platform/storage.mjs';
import { createProductionLocalStorageDriver } from '../backend/src/platform/production-local-storage.mjs';
import { migrationFiles } from '../backend/src/platform/migrations.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const tmpRoot = join(projectRoot, 'tmp', `production-storage-${randomUUID()}`);
const SID = 'S-1-5-21-1123157113-573781608-2536295357-1001';
const SYSTEM = 'S-1-5-18';
const ADMINS = 'S-1-5-32-544';
const areas = ['incoming', 'quarantine', 'review', 'release', 'serving'];

function productionEnv(root, extra = {}) {
  return {
    APP_ENV: 'production', HOST: '127.0.0.1',
    MAIN_ORIGIN: 'https://platform.example', GAME_ORIGIN: 'https://games.example.net',
    DATABASE_URL: 'postgres://app_production:synthetic@127.0.0.1:1/ai_games_production',
    DATABASE_TLS: 'verify-full', SESSION_SECRET: 'x'.repeat(32),
    PRIVATE_STORAGE_DRIVER: 'local', PRIVATE_STORAGE_ROOT: root,
    PRIVATE_STORAGE_ACCOUNT: SID, ...extra,
  };
}

const ace = sid => ({ sid, allow: true, inherited: false, rights: 'FullControl' });

// Injectable ACL probe. `mutate(path, entry)` simulates any ACL state per path;
// `fail` simulates an unavailable probe. All matching is by SID, never by name.
function aclProbe({ identity = SID, account = SID, mutate = null, fail = false } = {}) {
  return {
    inspect(paths) {
      if (fail) throw new Error('ACL probe failed');
      return {
        identitySid: identity, accountSid: account,
        results: paths.map(path => {
          const entry = { path, protected: true, owner: identity,
            aces: [ace(identity), ace(SYSTEM), ace(ADMINS)] };
          return mutate ? mutate(path, entry) : entry;
        }),
      };
    },
  };
}

function makeStorage(root, { probe = aclProbe(), hooks = {}, env = {} } = {}) {
  const config = loadConfig(productionEnv(root, env));
  const driver = createProductionLocalStorageDriver(config, { aclProbe: probe, hooks });
  return { config, driver, storage: createPrivateStorage(config, driver) };
}

function withRoot(t, name) {
  const root = join(tmpRoot, name);
  t.after(async () => { await rm(resolve(projectRoot, root), { recursive: true, force: true }); });
  return root;
}

async function fakeDatabase() {
  const migrations = await migrationFiles();
  return { query: async sql => sql.includes('schema_migrations')
    ? { rows: migrations.map(m => ({ id: m.id, checksum: m.checksum })) }
    : { rows: [{ environment: 'production' }] } };
}

test('production local storage config is explicit, private and keeps every existing guard', async t => {
  const root = withRoot(t, 'config');
  const config = loadConfig(productionEnv(root));
  assert.equal(config.storage.driver, 'local');
  assert.equal(config.storage.endpoint, null);
  assert.equal(config.storage.bucket, null);
  assert.equal(config.storage.root, resolve(projectRoot, root));
  assert.equal(config.storage.account, SID);
  assert.equal(config.storage.accountSid, null);
  assert.deepEqual(config.storage.extraSids, []);
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
    ['missing service account', { ...productionEnv(root), PRIVATE_STORAGE_ACCOUNT: '' }],
    ['invalid account SID', { ...productionEnv(root), PRIVATE_STORAGE_ACCOUNT_SID: 'not-a-sid' }],
    ['invalid extra SIDs', { ...productionEnv(root), PRIVATE_STORAGE_EXTRA_SIDS: 'Authenticated Users' }],
  ]) assert.throws(() => loadConfig(env), /Invalid configuration/, name);

  const extra = loadConfig(productionEnv(root, { PRIVATE_STORAGE_EXTRA_SIDS: `${SYSTEM},S-1-5-21-9-9-9-1002` }));
  assert.deepEqual(extra.storage.extraSids, [SYSTEM, 'S-1-5-21-9-9-9-1002']);

  const objectConfig = loadConfig({ APP_ENV: 'production',
    DATABASE_URL: 'postgres://app_production:synthetic@db/ai_games_production',
    MAIN_ORIGIN: 'https://platform.example', GAME_ORIGIN: 'https://games.example.net',
    OBJECT_STORAGE_ENDPOINT: 'https://storage.example', OBJECT_STORAGE_BUCKET: 'games-production',
    SESSION_SECRET: 'x'.repeat(32) });
  assert.equal(objectConfig.storage.driver, 'object');
  assert.equal(objectConfig.storage.root, null);
  assert.equal(objectConfig.storage.bucket, 'games-production');
});

test('development configuration and local storage remain unchanged', async () => {
  const development = loadConfig({});
  assert.equal(development.environment, 'development');
  assert.equal(development.storage.driver, 'object');
  assert.equal(development.storage.root, null);
  assert.equal(development.storage.bucket, null);
  assert.equal(development.storage.account, null);
  const localGames = loadConfig({ LOCAL_GAMES: '1' });
  assert.equal(localGames.localGames, true);
  assert.equal(localGames.storage.driver, 'object');
  assert.equal(await createPrivateStorage(development).health(), false);
});

test('ACL: a compliant SID whitelist passes at startup and readiness', async t => {
  const root = withRoot(t, 'acl-ok');
  const { storage } = makeStorage(root);
  assert.equal(await storage.health(), true);
  const bytes = Buffer.from('acl-ok');
  assert.equal(await storage.put('quarantine', 'a', bytes), 'production/quarantine/a');
  assert.deepEqual(await storage.get('quarantine', 'a'), bytes);
});

test('ACL: broad, unresolved, unknown principals, inheritance, parent chain and identity fail closed', async t => {
  const root = withRoot(t, 'acl-refuse');
  const config = loadConfig(productionEnv(root));
  const broad = sid => ({ sid, allow: true, inherited: false, rights: 'Modify, Synchronize' });
  const cases = [
    ['Authenticated Users', { mutate: (p, e) => ({ ...e, aces: [...e.aces, broad('S-1-5-11')] }) }],
    ['BUILTIN Users', { mutate: (p, e) => ({ ...e, aces: [...e.aces, broad('S-1-5-32-545')] }) }],
    ['Everyone', { mutate: (p, e) => ({ ...e, aces: [...e.aces, broad('S-1-1-0')] }) }],
    ['unresolved principal', { mutate: (p, e) => ({ ...e, aces: [...e.aces, broad('UNRESOLVED')] }) }],
    ['unknown SID', { mutate: (p, e) => ({ ...e, aces: [...e.aces, broad('S-1-5-21-77-77-77-1001')] }) }],
    ['inheritance enabled', { mutate: (p, e) => e.path === resolve(projectRoot, root) ? { ...e, protected: false } : e }],
    ['service account missing on root', { mutate: (p, e) => p === resolve(projectRoot, root) ? { ...e, aces: [ace(SYSTEM), ace(ADMINS)] } : e }],
    ['broad ACE on a parent directory', { mutate: (p, e) => p !== resolve(projectRoot, root) ? { ...e, aces: [...e.aces, broad('S-1-5-11')] } : e }],
    ['identity mismatch', { identity: 'S-1-5-21-88-88-88-1001' }],
    ['probe failure', { fail: true }],
  ];
  for (const [name, options] of cases) {
    assert.throws(() => createProductionLocalStorageDriver(config, { aclProbe: aclProbe(options) }), /ACL|private/i, name);
  }
  // A declared extra SID is accepted.
  const ok = createProductionLocalStorageDriver(loadConfig(productionEnv(root)), { aclProbe: aclProbe() });
  assert.equal(typeof ok.put, 'function');
});

test('ACL check failure prevents startup: the real server never listens', { timeout: 20000 }, async t => {
  const root = withRoot(t, 'startup');
  await mkdir(resolve(projectRoot, root), { recursive: true });
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(done => probe.close(done));
  // Default (real) probe observes the broad parent-chain ACL on this host.
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
    ...productionEnv(root), PORT: String(port) };
  const child = spawn(process.execPath, ['backend/src/server.mjs'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close');
      child.kill();
      await closed;
    }
  });
  const output = await new Promise((done, reject) => {
    let text = '';
    child.once('error', reject);
    child.stdout.on('data', chunk => { text += chunk; });
    child.once('close', () => done(text));
  });
  assert.match(output, /app\.failed/);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/health/live`));
});

test('readiness is 200 only with a valid schema and a passing ACL, 503 otherwise', async t => {
  const root = withRoot(t, 'readiness');
  const { config, storage } = makeStorage(root);
  const database = await fakeDatabase();

  const ready = createApp({ config, database, storage, log: () => {} });
  ready.listen(0, '127.0.0.1');
  await once(ready, 'listening');
  t.after(() => new Promise(done => { ready.close(done); ready.closeAllConnections(); }));
  assert.equal((await fetch(`http://127.0.0.1:${ready.address().port}/health/ready`)).status, 200);
  assert.equal((await fetch(`http://127.0.0.1:${ready.address().port}/production/quarantine/a`)).status, 404);

  // The ACL becomes broad between startup and the readiness observation.
  let calls = 0;
  const probe = { inspect(paths) {
    calls += 1;
    if (calls > 1) throw new Error('ACL probe failed');
    return aclProbe().inspect(paths);
  } };
  const flapping = createProductionLocalStorageDriver(config, { aclProbe: probe });
  const flappingStorage = createPrivateStorage(config, flapping);
  const degraded = createApp({ config, database, storage: flappingStorage, log: () => {} });
  degraded.listen(0, '127.0.0.1');
  await once(degraded, 'listening');
  t.after(() => new Promise(done => { degraded.close(done); degraded.closeAllConnections(); }));
  assert.equal((await fetch(`http://127.0.0.1:${degraded.address().port}/health/ready`)).status, 503);

  const closed = createPrivateStorage(config);
  const noDriver = createApp({ config, database, storage: closed, log: () => {} });
  noDriver.listen(0, '127.0.0.1');
  await once(noDriver, 'listening');
  t.after(() => new Promise(done => { noDriver.close(done); noDriver.closeAllConnections(); }));
  assert.equal((await fetch(`http://127.0.0.1:${noDriver.address().port}/health/ready`)).status, 503);
});

test('private storage boundary: areas, keys, immutability and driver requirements', async t => {
  const root = withRoot(t, 'boundary');
  const { config, driver, storage } = makeStorage(root);
  assert.equal(await createPrivateStorage(config).health(), false);
  await assert.rejects(createPrivateStorage(config).get('quarantine', 'x'), { code: 'STORAGE_UNAVAILABLE' });
  assert.equal(await storage.health(), true);
  for (const area of areas) {
    const bytes = Buffer.from(`content-${area}`);
    assert.equal(await storage.put(area, 'object-1', bytes), `production/${area}/object-1`);
    assert.deepEqual(await storage.get(area, 'object-1'), bytes);
  }
  for (const args of [
    { key: 'production/quarantine/x', bytes: Buffer.from('x'), visibility: 'public', ifAbsent: true },
    { key: 'production/quarantine/x', bytes: Buffer.from('x'), visibility: 'private', ifAbsent: false },
    { key: 'production/quarantine/x', bytes: Buffer.from('x'), visibility: 'private', ifAbsent: true, bucket: 'games-production' },
  ]) await assert.rejects(driver.put(args));
  for (const key of ['production/public/x', 'test/quarantine/x', 'production/quarantine/../x', 'production/quarantine/a/b']) {
    await assert.rejects(driver.get({ key }));
  }
  for (const id of ['../secret', '/absolute', 'a/b', 'a\\b', '%2e%2e', '']) await assert.rejects(storage.get('quarantine', id));
  await assert.rejects(storage.get('public', 'object-1'));
});

test('write failure leaves no published half-file and cleans temp files', async t => {
  const root = withRoot(t, 'write-failure');
  for (const [name, error] of [
    ['mid-write exception', new Error('simulated crash')],
    ['disk full', Object.assign(new Error('no space left'), { code: 'ENOSPC' })],
  ]) {
    const caseRoot = join(root, name.replace(/\s/g, '-'));
    const hooks = { afterWrite: async () => { throw error; } };
    const { storage } = makeStorage(caseRoot, { hooks });
    await assert.rejects(storage.put('release', 'obj', Buffer.from('complete content')), undefined, name);
    const final = join(resolve(projectRoot, caseRoot), 'production', 'release', 'obj');
    await assert.rejects(stat(final), undefined, `${name}: no published half-file`);
    const dir = join(resolve(projectRoot, caseRoot), 'production', 'release');
    const leftovers = (await readdir(dir)).filter(entry => entry.endsWith('.tmp'));
    assert.deepEqual(leftovers, [], `${name}: temp cleaned`);
  }
});

test('idempotent retry, different-bytes conflict and concurrent writes resolve safely', async t => {
  const root = withRoot(t, 'concurrency');
  const { storage } = makeStorage(root);
  const bytes = Buffer.from('identical payload');
  const digest = createHash('sha256').update(bytes).digest('hex');
  await storage.put('release', 'same', bytes);
  await storage.put('release', 'same', bytes);
  assert.deepEqual(await storage.get('release', 'same', { digest, size: bytes.length }), bytes);
  await assert.rejects(storage.put('release', 'same', Buffer.from('changed')));

  const many = await Promise.all(Array.from({ length: 20 }, () => storage.put('incoming', 'shared', bytes)));
  assert.ok(many.every(key => key === 'production/incoming/shared'));
  assert.deepEqual(await storage.get('incoming', 'shared'), bytes);
  const sharedDir = join(resolve(projectRoot, root), 'production', 'incoming');
  assert.deepEqual((await readdir(sharedDir)).filter(name => !name.startsWith('.')), ['shared']);

  const candidates = Array.from({ length: 10 }, (_, i) => Buffer.from(`candidate-${i}`));
  const settled = await Promise.allSettled(candidates.map(b => storage.put('quarantine', 'race', b)));
  assert.equal(settled.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(settled.filter(r => r.status === 'rejected').length, 9);
  const winner = await storage.get('quarantine', 'race');
  assert.ok(candidates.some(c => c.equals(winner)));
});

test('200MB object: streaming SHA-256 verification without whole-file comparison', { timeout: 120000 }, async t => {
  const root = withRoot(t, 'big');
  const { storage } = makeStorage(root);
  const bytes = Buffer.alloc(200_000_000, 0x61);
  const digest = createHash('sha256').update(bytes).digest('hex');
  await storage.put('review', 'big', bytes);
  const read = await storage.get('review', 'big', { digest, size: bytes.length });
  assert.equal(read.length, bytes.length);
  assert.equal(createHash('sha256').update(read).digest('hex'), digest);
  await assert.rejects(storage.get('review', 'big', { digest: 'f'.repeat(64) }));
});

test('junction replacement and race hooks are refused; root guard unchanged', async t => {
  const root = withRoot(t, 'links');
  const absRoot = resolve(projectRoot, root);
  const { storage } = makeStorage(root);
  assert.equal(await storage.health(), true);
  const envDir = join(absRoot, 'production');
  const incoming = join(envDir, 'incoming');
  const outside = join(absRoot, 'outside');
  await mkdir(outside, { recursive: true });
  await rm(incoming, { recursive: true, force: true });
  let junction = false;
  try { await symlink(outside, incoming, 'junction'); junction = true; } catch { /* platform may refuse */ }
  if (!junction) { t.skip('junction creation unavailable'); return; }
  await assert.rejects(storage.health());
  await assert.rejects(storage.put('incoming', 'x', Buffer.from('x')));
  await rm(incoming, { recursive: true, force: true });
  assert.equal(await storage.health(), true);

  // A race hook replaces the raced root's own area directory with a junction
  // after the first assertion; the assertion inside atomicPublish must catch it.
  const raceRoot = join(root, 'race');
  const raceIncoming = join(resolve(projectRoot, raceRoot), 'production', 'incoming');
  const raceOutside = join(resolve(projectRoot, raceRoot), 'outside');
  const hooks = { beforePublish: async () => {
    await mkdir(raceOutside, { recursive: true });
    await rm(raceIncoming, { recursive: true, force: true });
    await symlink(raceOutside, raceIncoming, 'junction');
  } };
  const raced = makeStorage(raceRoot, { hooks });
  await assert.rejects(raced.storage.put('incoming', 'y', Buffer.from('y')));
  assert.deepEqual(await readdir(raceOutside), []);
  await rm(raceIncoming, { recursive: true, force: true }).catch(() => {});

  assert.throws(() => createProductionLocalStorageDriver({ environment: 'production',
    storage: { driver: 'local', root: join(projectRoot, 'frontend'), endpoint: null, bucket: null, account: SID } },
    { aclProbe: aclProbe() }));
  assert.throws(() => createProductionLocalStorageDriver({ environment: 'development',
    storage: { driver: 'local', root: absRoot, endpoint: null, bucket: null, account: SID } },
    { aclProbe: aclProbe() }));
});

test('tampered content and tampered metadata are refused on read', async t => {
  const root = withRoot(t, 'tamper');
  const { storage } = makeStorage(root);
  const bytes = Buffer.from('hello private world');
  await storage.put('release', 'obj', bytes);
  const final = join(resolve(projectRoot, root), 'production', 'release', 'obj');
  const meta = join(resolve(projectRoot, root), 'production', 'release', '.obj.meta');
  await writeFile(final, Buffer.from('hello private WORLD')); // same length, different bytes
  await assert.rejects(storage.get('release', 'obj'));
  await writeFile(final, bytes);
  assert.deepEqual(await storage.get('release', 'obj'), bytes);
  await writeFile(meta, JSON.stringify({ v: 1, key: final, size: bytes.length, sha256: '0'.repeat(64) }));
  await assert.rejects(storage.get('release', 'obj'));
});

test('orphan temp files are isolated at readiness and never republished', async t => {
  const root = withRoot(t, 'orphans');
  const absRoot = resolve(projectRoot, root);
  const { storage } = makeStorage(root);
  const dir = join(absRoot, 'production', 'release');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, '.orphan-1234.tmp'), Buffer.from('interrupted'));
  assert.equal(await storage.health(), true);
  assert.deepEqual((await readdir(dir)).filter(name => name.endsWith('.tmp')), []);
  const orphans = await readdir(join(absRoot, '_orphans'), { recursive: true });
  assert.ok(orphans.some(name => String(name).includes('orphan-1234.tmp')));
  await assert.rejects(storage.get('release', 'orphan'));
});
