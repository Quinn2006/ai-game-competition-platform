import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createWindowsAclProbe, assertStorageAcl, guardPaths } from '../backend/src/platform/acl.mjs';
import { loadConfig } from '../backend/src/config.mjs';
import { createPrivateStorage } from '../backend/src/platform/storage.mjs';
import { createProductionLocalStorageDriver } from '../backend/src/platform/production-local-storage.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));

// REAL Windows ACL integration test. Opt-in only (AGP_REAL_ACL_TESTS=1 on win32).
// READ-ONLY: it never sets, removes, inherits or changes any ACL. It only inspects
// existing directories to verify SID resolution and fail-closed behaviour.
const enabled = process.env.AGP_REAL_ACL_TESTS === '1' && process.platform === 'win32';

test('real Windows ACL probe resolves SIDs and fails closed on broad principals',
  { skip: !enabled && 'set AGP_REAL_ACL_TESTS=1 on Windows' }, async () => {
    const probe = createWindowsAclProbe();
    const root = resolve(projectRoot, 'data');
    const paths = guardPaths(root);
    const info = probe.inspect(paths, null);
    assert.match(info.identitySid, /^S-1-\d+(?:-\d+)+$/);
    assert.equal(info.results.length, paths.length);
    for (const entry of info.results) {
      assert.ok(Array.isArray(entry.aces), 'every guarded path reports its ACE list');
      for (const ace of entry.aces) assert.ok(Number.isInteger(ace.rights), 'rights are numeric');
    }

    const data = info.results.find(entry => entry.path.toLowerCase() === root.toLowerCase());
    assert.ok(data, 'data directory must be observable');
    assert.ok(data.aces.some(ace => ace.sid === 'S-1-5-18'), 'SYSTEM must resolve to its SID');
    assert.ok(data.aces.every(ace => !['S-1-5-11', 'S-1-1-0', 'S-1-5-32-545'].includes(ace.sid)),
      'a correctly hardened directory has no broad principals');

    // On this host the parent chain (volume root) still carries an Authenticated
    // Users ACE, so the full assertion must refuse. This is the expected blocker
    // for production enablement without a trust boundary, not a test failure.
    assert.throws(() => assertStorageAcl({
      root, paths, account: info.identitySid, accountSid: null, extraSids: [], probe,
    }), /ACL/);
  });

// REAL Windows positive acceptance, opt-in only (AGP_ACL_POSITIVE=1 on win32).
// It creates a throwaway directory under the OS temp directory, hardens THAT
// directory's own ACL (icacls on a directory the test itself just created —
// no existing or system directory is touched, no service account is created),
// proves the full startup + readiness + read/write path passes with the real
// PowerShell probe, then deletes the directory. See
// docs/windows-acl-acceptance-plan-2026-11-03.md for the operator-level plan;
// anything beyond this scratch directory (real service account, real data
// directory ACLs) requires explicit operator approval.
const positiveEnabled = process.env.AGP_ACL_POSITIVE === '1' && process.platform === 'win32';

test('real Windows ACL positive acceptance: hardened scratch store passes startup, readiness and reads',
  { skip: !positiveEnabled && 'set AGP_ACL_POSITIVE=1 on Windows (self-contained: hardens only its own throwaway temp directory)' }, async t => {
    const probe = createWindowsAclProbe();
    const root = join(tmpdir(), `agp-acl-positive-${randomUUID()}`);
    await mkdir(root, { recursive: true });
    t.after(async () => { await rm(root, { recursive: true, force: true }); });

    const identitySid = probe.inspect([root]).identitySid;
    const icacls = args => {
      const result = spawnSync('icacls', [root, ...args], { encoding: 'utf8' });
      if (result.status !== 0) throw new Error(`icacls failed with status ${result.status}`);
    };
    icacls(['/inheritance:r']);
    icacls(['/grant:r', `*${identitySid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F']);

    const config = loadConfig({
      APP_ENV: 'production', HOST: '127.0.0.1',
      MAIN_ORIGIN: 'https://platform.example', GAME_ORIGIN: 'https://games.example.net',
      DATABASE_URL: 'postgres://app_production:synthetic@127.0.0.1:1/ai_games_production',
      DATABASE_TLS: 'verify-full', SESSION_SECRET: 'x'.repeat(32),
      PRIVATE_STORAGE_DRIVER: 'local', PRIVATE_STORAGE_ROOT: root, PRIVATE_STORAGE_TRUST_ROOT: root,
      PRIVATE_STORAGE_ACCOUNT: identitySid,
    });
    // Construction runs the real startup assertion; readiness runs the real
    // asynchronous probe. The trust boundary is the scratch root itself, so the
    // broad ACL of the OS temp directory above it is intentionally out of scope.
    // Zero refresh interval forces every health() call through inspectAsync.
    const driver = createProductionLocalStorageDriver(config,
      { aclRefreshIntervalMs: 0, aclMinIntervalMs: 0 });
    const storage = createPrivateStorage(config, driver);
    assert.equal(await storage.health(), true);
    const bytes = Buffer.from('positive acceptance payload');
    assert.equal(await storage.put('release', 'obj', bytes), 'production/release/obj');
    assert.deepEqual(await storage.get('release', 'obj'), bytes);
    assert.equal(await storage.health(), true, 'second readiness pass re-runs the async probe');
  });
