import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWindowsAclProbe, assertStorageAcl, guardPaths } from '../backend/src/platform/acl.mjs';

// REAL Windows ACL integration test. Opt-in only (AGP_REAL_ACL_TESTS=1 on win32).
// READ-ONLY: it never sets, removes, inherits or changes any ACL. It only inspects
// existing directories to verify SID resolution and fail-closed behaviour.
const enabled = process.env.AGP_REAL_ACL_TESTS === '1' && process.platform === 'win32';
const projectRoot = fileURLToPath(new URL('../', import.meta.url));

test('real Windows ACL probe resolves SIDs and fails closed on broad principals',
  { skip: !enabled && 'set AGP_REAL_ACL_TESTS=1 on Windows' }, async () => {
    const probe = createWindowsAclProbe();
    const root = resolve(projectRoot, 'data');
    const paths = guardPaths(root);
    const info = probe.inspect(paths, null);
    assert.match(info.identitySid, /^S-1-\d+(?:-\d+)+$/);
    assert.equal(info.results.length, paths.length);

    const data = info.results.find(entry => entry.path.toLowerCase() === root.toLowerCase());
    assert.ok(data, 'data directory must be observable');
    assert.ok(data.aces.some(ace => ace.sid === 'S-1-5-18'), 'SYSTEM must resolve to its SID');
    assert.ok(data.aces.every(ace => !['S-1-5-11', 'S-1-1-0', 'S-1-5-32-545'].includes(ace.sid)),
      'a correctly hardened directory has no broad principals');

    // On this host the parent chain (volume root) still carries an Authenticated
    // Users ACE, so the full assertion must refuse. This is the expected blocker
    // for production enablement, not a test failure.
    assert.throws(() => assertStorageAcl({
      root, paths, account: info.identitySid, accountSid: null, extraSids: [], probe,
    }), /ACL/);
  });
