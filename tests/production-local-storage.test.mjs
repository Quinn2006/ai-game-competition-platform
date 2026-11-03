import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { mkdir, readdir, readFile, rename, rm, symlink, writeFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../backend/src/config.mjs';
import { createApp } from '../backend/src/app.mjs';
import { createPrivateStorage } from '../backend/src/platform/storage.mjs';
import { createProductionLocalStorageDriver } from '../backend/src/platform/production-local-storage.mjs';
import { migrationFiles } from '../backend/src/platform/migrations.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const tmpRoot = join('tmp', `production-storage-${randomUUID()}`);
const SID = 'S-1-5-21-1123157113-573781608-2536295357-1001';
const SYSTEM = 'S-1-5-18';
const ADMINS = 'S-1-5-32-544';
const FULL = 2032127; // FileSystemRights FullControl
const READ_ONLY = 1 | 128 | 131072; // ReadData | ReadAttributes | ReadControl
const DELETE = 65536;
const areas = ['incoming', 'quarantine', 'review', 'release', 'serving'];

const delay = ms => new Promise(done => setTimeout(done, ms));
const norm = path => resolve(projectRoot, path).toLowerCase();

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

const ace = (sid, extra = {}) => ({ sid, allow: true, inherited: false, rights: FULL, ...extra });
const cleanInfo = paths => ({
  identitySid: SID, accountSid: SID,
  results: paths.map(path => ({ path, protected: true, owner: SID, aces: [ace(SID), ace(SYSTEM), ace(ADMINS)] })),
});

// Injectable ACL probe. `mutate(path, entry)` simulates any ACL state per path;
// `fail` simulates an unavailable probe. All matching is by SID, never by name.
function aclProbe({ identity = SID, account = SID, mutate = null, fail = false } = {}) {
  const result = paths => ({
    identitySid: identity, accountSid: account,
    results: paths.map(path => {
      const entry = { path, protected: true, owner: identity, aces: [ace(identity), ace(SYSTEM), ace(ADMINS)] };
      return mutate ? mutate(path, entry) : entry;
    }),
  });
  return {
    inspect(paths) {
      if (fail) throw new Error('ACL probe failed');
      return result(paths);
    },
    async inspectAsync(paths) {
      if (fail) throw new Error('ACL probe failed');
      return result(paths);
    },
  };
}

function makeStorage(root, { probe = aclProbe(), hooks = {}, env = {}, deps = {} } = {}) {
  const config = loadConfig(productionEnv(root, env));
  const driver = createProductionLocalStorageDriver(config, { aclProbe: probe, hooks, ...deps });
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
  assert.equal(config.storage.trustRoot, null);
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
    ['object config with trust root', { ...productionEnv(root), PRIVATE_STORAGE_DRIVER: 'object', PRIVATE_STORAGE_ROOT: '', OBJECT_STORAGE_ENDPOINT: 'https://storage.example', OBJECT_STORAGE_BUCKET: 'games-production', PRIVATE_STORAGE_TRUST_ROOT: root }],
    ['trust root not an ancestor of the root', { ...productionEnv(root), PRIVATE_STORAGE_TRUST_ROOT: join(tmpRoot, 'elsewhere') }],
    ['trust root is a volume root', { ...productionEnv(root), PRIVATE_STORAGE_TRUST_ROOT: '/' }],
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
  const trusted = loadConfig(productionEnv(root, { PRIVATE_STORAGE_TRUST_ROOT: tmpRoot }));
  assert.equal(trusted.storage.trustRoot, resolve(projectRoot, tmpRoot));

  const objectConfig = loadConfig({ APP_ENV: 'production',
    DATABASE_URL: 'postgres://app_production:synthetic@db/ai_games_production',
    MAIN_ORIGIN: 'https://platform.example', GAME_ORIGIN: 'https://games.example.net',
    OBJECT_STORAGE_ENDPOINT: 'https://storage.example', OBJECT_STORAGE_BUCKET: 'games-production',
    SESSION_SECRET: 'x'.repeat(32) });
  assert.equal(objectConfig.storage.driver, 'object');
  assert.equal(objectConfig.storage.root, null);
  assert.equal(objectConfig.storage.trustRoot, null);
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
  const broad = sid => ace(sid);
  const cases = [
    ['Authenticated Users', { mutate: (p, e) => ({ ...e, aces: [...e.aces, broad('S-1-5-11')] }) }],
    ['BUILTIN Users', { mutate: (p, e) => ({ ...e, aces: [...e.aces, broad('S-1-5-32-545')] }) }],
    ['Everyone', { mutate: (p, e) => ({ ...e, aces: [...e.aces, broad('S-1-1-0')] }) }],
    ['unresolved allow principal', { mutate: (p, e) => ({ ...e, aces: [...e.aces, broad('UNRESOLVED')] }) }],
    ['unresolved deny principal', { mutate: (p, e) => ({ ...e, aces: [...e.aces, ace('UNRESOLVED', { allow: false, rights: 131072 })] }) }],
    ['unknown SID', { mutate: (p, e) => ({ ...e, aces: [...e.aces, broad('S-1-5-21-77-77-77-1001')] }) }],
    ['untrusted owner', { mutate: (p, e) => ({ ...e, owner: 'S-1-5-21-77-77-77-1234' }) }],
    ['unresolved owner', { mutate: (p, e) => ({ ...e, owner: 'UNRESOLVED' }) }],
    ['deny strips a required right from the service account', { mutate: (p, e) => ({ ...e, aces: [...e.aces, ace(SID, { allow: false, rights: DELETE })] }) }],
    ['service account rights insufficient on the root', { mutate: (p, e) => p === resolve(projectRoot, root) ? { ...e, aces: [ace(SID, { rights: READ_ONLY }), ace(SYSTEM), ace(ADMINS)] } : e }],
    ['service account missing on root', { mutate: (p, e) => p === resolve(projectRoot, root) ? { ...e, aces: [ace(SYSTEM), ace(ADMINS)] } : e }],
    ['inheritance enabled', { mutate: (p, e) => e.path === resolve(projectRoot, root) ? { ...e, protected: false } : e }],
    ['broad ACE on a parent directory', { mutate: (p, e) => p !== resolve(projectRoot, root) ? { ...e, aces: [...e.aces, broad('S-1-5-11')] } : e }],
    ['identity mismatch', { identity: 'S-1-5-21-88-88-88-1001' }],
    ['probe failure', { fail: true }],
  ];
  for (const [name, options] of cases) {
    assert.throws(() => createProductionLocalStorageDriver(config, { aclProbe: aclProbe(options) }), /ACL|private/i, name);
  }
  // A declared extra SID is accepted, including a grant of its own ACE.
  const ok = createProductionLocalStorageDriver(loadConfig(productionEnv(root, { PRIVATE_STORAGE_EXTRA_SIDS: 'S-1-5-21-9-9-9-1002' })),
    { aclProbe: aclProbe({ mutate: (p, e) => ({ ...e, aces: [...e.aces, ace('S-1-5-21-9-9-9-1002')] }) }) });
  assert.equal(typeof ok.put, 'function');
});

test('ACL: a trust boundary stops the guard chain at a hardened boundary directory', async t => {
  const root = withRoot(t, 'trust-chain');
  const boundary = resolve(projectRoot, tmpRoot);
  const seen = [];
  const probe = {
    inspect(paths) { seen.push(...paths); return cleanInfo(paths); },
    async inspectAsync(paths) { seen.push(...paths); return cleanInfo(paths); },
  };
  const { storage } = makeStorage(root, { probe, env: { PRIVATE_STORAGE_TRUST_ROOT: tmpRoot },
    deps: { aclRefreshIntervalMs: 0, aclMinIntervalMs: 0 } });
  assert.equal(await storage.health(), true);
  // The boundary and everything below it (root, areas) are guarded...
  assert.ok(seen.some(p => norm(p) === norm(boundary)), 'the boundary itself is guarded');
  assert.ok(seen.some(p => norm(p) === norm(resolve(projectRoot, root))), 'the storage root is guarded');
  assert.ok(seen.some(p => norm(p) === norm(join(resolve(projectRoot, root), 'production', 'release'))), 'area directories are guarded');
  // ...while nothing above the boundary (project root, volume root) is inspected.
  assert.ok(seen.every(p => norm(p) !== norm(dirname(boundary))), 'ancestors above the boundary are not probed');
  assert.ok(seen.every(p => !norm(p).match(/^[a-z]:\\$|^[a-z]:$/)), 'no volume root is probed');
});

test('ACL: an unhardened trust boundary itself fails closed', async t => {
  const root = withRoot(t, 'trust-guard');
  const boundary = norm(resolve(projectRoot, tmpRoot));
  const isBoundary = p => norm(p) === boundary;
  for (const [name, mutate] of [
    ['broad principal on the boundary', (p, e) => isBoundary(p) ? { ...e, aces: [...e.aces, ace('S-1-5-11')] } : e],
    ['inheritance enabled on the boundary', (p, e) => isBoundary(p) ? { ...e, protected: false } : e],
    ['untrusted owner on the boundary', (p, e) => isBoundary(p) ? { ...e, owner: 'S-1-5-21-77-77-77-1234' } : e],
    ['deny strips a required right on the boundary', (p, e) => isBoundary(p) ? { ...e, aces: [...e.aces, ace(SID, { allow: false, rights: DELETE })] } : e],
  ]) assert.throws(() => makeStorage(root, { probe: aclProbe({ mutate }), env: { PRIVATE_STORAGE_TRUST_ROOT: tmpRoot } }), /ACL|private/i, name);
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

  // The ACL becomes broad between startup and the readiness observation; the
  // async, rate-limited re-check must observe it and fail readiness.
  const widened = { inspect: paths => cleanInfo(paths), inspectAsync: async () => { throw new Error('ACL probe failed'); } };
  const flapping = createProductionLocalStorageDriver(config, { aclProbe: widened, aclRefreshIntervalMs: 0, aclMinIntervalMs: 0 });
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

test('readiness ACL re-check is asynchronous, non-blocking, and recovers', async t => {
  const root = withRoot(t, 'async-acl');
  const config = loadConfig(productionEnv(root));
  let verdict = 'ok';
  let inspectCalls = 0;
  const probe = {
    inspect(paths) {
      inspectCalls += 1;
      if (inspectCalls > 1) throw new Error('synchronous probe must not be used at readiness');
      return cleanInfo(paths);
    },
    async inspectAsync(paths) {
      await delay(50); // pending probe: the event loop must stay responsive
      if (verdict === 'bad') throw new Error('ACL probe failed');
      return cleanInfo(paths);
    },
  };
  const storage = createPrivateStorage(config, createProductionLocalStorageDriver(config,
    { aclProbe: probe, aclRefreshIntervalMs: 0, aclMinIntervalMs: 0 }));
  assert.equal(await storage.health(), true);
  // While the async probe is in flight, a timer still fires: readiness never
  // blocks the event loop, and the synchronous probe is never reused.
  const pending = storage.health();
  let loopAlive = false;
  await delay(10).then(() => { loopAlive = true; });
  assert.equal(await pending, true);
  assert.ok(loopAlive, 'event loop stayed responsive during the in-flight probe');
  assert.equal(inspectCalls, 1, 'only the startup assertion used the synchronous probe');
  // A widened ACL is observed (readiness refusal, i.e. 503) and later recovery
  // is not masked by the cached verdict.
  verdict = 'bad';
  await assert.rejects(storage.health(), /Private storage ACL refused/);
  verdict = 'ok';
  assert.equal(await storage.health(), true);
});

test('readiness ACL re-check is rate limited: bursts do not cause a probe storm', async t => {
  const root = withRoot(t, 'acl-rate');
  const config = loadConfig(productionEnv(root));
  let calls = 0;
  const probe = {
    inspect: paths => cleanInfo(paths),
    async inspectAsync(paths) { calls += 1; return cleanInfo(paths); },
  };
  const storage = createPrivateStorage(config, createProductionLocalStorageDriver(config,
    { aclProbe: probe, aclRefreshIntervalMs: 0 })); // aclMinIntervalMs defaults to 5000
  for (let i = 0; i < 5; i += 1) assert.equal(await storage.health(), true);
  await Promise.all(Array.from({ length: 5 }, () => storage.health()));
  assert.equal(calls, 1, 'one refresh serves the whole burst');
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
  // A malformed database expectation is refused instead of being ignored.
  await assert.rejects(storage.get('quarantine', 'object-1', { digest: 'not-a-digest' }), { code: 'INVALID_OBJECT' });
  await assert.rejects(storage.get('quarantine', 'object-1', { size: -1 }), { code: 'INVALID_OBJECT' });
  await assert.rejects(storage.get('quarantine', 'object-1', 'nope'), { code: 'INVALID_OBJECT' });
  await assert.rejects(driver.get({ key: 'production/quarantine/object-1', expectedDigest: 'zzz' }));
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

test('metadata stores the stable relative object key and recovers under a different root', async t => {
  const origin = join(tmpRoot, 'relocate-origin');
  const relocated = join(tmpRoot, 'relocate-moved');
  t.after(async () => {
    await rm(resolve(projectRoot, origin), { recursive: true, force: true });
    await rm(resolve(projectRoot, relocated), { recursive: true, force: true });
  });
  const bytes = Buffer.from('relocatable payload');
  const { storage } = makeStorage(origin);
  await storage.put('release', 'obj', bytes);
  const metaFile = join(resolve(projectRoot, origin), 'production', 'release', '.obj.meta');
  const meta = JSON.parse(await readFile(metaFile, 'utf8'));
  assert.equal(meta.key, 'production/release/obj', 'metadata key is the stable object key');
  assert.ok(!String(meta.key).includes(resolve(projectRoot, origin)), 'no absolute path in metadata');

  // The whole store moves to a different root directory; the relative key keeps
  // the object readable without any manual repair.
  await rename(resolve(projectRoot, origin), resolve(projectRoot, relocated));
  const moved = makeStorage(relocated);
  assert.deepEqual(await moved.storage.get('release', 'obj'), bytes);
  await assert.equal(await moved.storage.put('release', 'obj', bytes), 'production/release/obj');
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
  // Legacy absolute-path metadata is refused by the relative-key validation.
  await writeFile(meta, JSON.stringify({ v: 1, key: final, size: bytes.length, sha256: '0'.repeat(64) }));
  await assert.rejects(storage.get('release', 'obj'));
  // A well-formed relative key with a wrong digest is refused as well.
  await writeFile(meta, JSON.stringify({ v: 1, key: 'production/release/obj', size: bytes.length, sha256: '0'.repeat(64) }));
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

test('incomplete object/meta pairs are quarantined, never published', async t => {
  const root = withRoot(t, 'pairs');
  const absRoot = resolve(projectRoot, root);
  const { storage } = makeStorage(root);
  const dir = join(absRoot, 'production', 'release');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'lone'), Buffer.from('object without meta'));
  await writeFile(join(dir, '.ghost.meta'), JSON.stringify({ v: 1, key: 'production/release/ghost', size: 1, sha256: 'a'.repeat(64) }));
  await writeFile(join(dir, 'broken'), Buffer.from('pair with corrupt meta'));
  await writeFile(join(dir, '.broken.meta'), '{ not json');
  await writeFile(join(dir, 'wrongkey'), Buffer.from('pair with foreign meta'));
  await writeFile(join(dir, '.wrongkey.meta'), JSON.stringify({ v: 1, key: 'production/release/elsewhere', size: 1, sha256: 'a'.repeat(64) }));
  assert.equal(await storage.health(), true);
  assert.deepEqual((await readdir(dir)).sort(), [], 'the area directory no longer serves unpaired files');
  const orphans = await readdir(join(absRoot, '_orphans'), { recursive: true }).then(list => list.map(String));
  for (const quarantined of ['release-lone', 'release-.ghost.meta', 'release-broken', 'release-.broken.meta', 'release-wrongkey', 'release-.wrongkey.meta'])
    assert.ok(orphans.some(name => name.includes(quarantined)), `${quarantined} is quarantined`);
  for (const id of ['lone', 'ghost', 'broken', 'wrongkey']) await assert.rejects(storage.get('release', id));

  // A valid pair survives repeated readiness scans untouched.
  await storage.put('release', 'fine', Buffer.from('fine'));
  assert.equal(await storage.health(), true);
  assert.deepEqual(await storage.get('release', 'fine'), Buffer.from('fine'));
});
