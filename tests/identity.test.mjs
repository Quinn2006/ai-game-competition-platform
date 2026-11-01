import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { allowed } from '../src/modules/identity/authorization.mjs';
import { publicProfile, publicTeam, selfProfile } from '../src/modules/identity/profiles.mjs';
import { createAccessGuard } from '../src/modules/identity/access.mjs';
import { appendSecurityAudit } from '../src/modules/audit/security.mjs';

const actor = (roles = []) => ({ id: randomUUID(), status: 'active', roles });

test('seven actor categories: published reads, login boundary, resource scope and no admin ownership bypass', () => {
  const user = actor(), author = actor(), captain = actor(), member = actor(), judge = actor(['judge']), admin = actor(['admin']);
  const principals = [null, user, author, captain, member, judge, admin];
  const personal = { kind: 'personal', ownerId: author.id };
  const team = { kind: 'team', captainId: captain.id, memberIds: [member.id] };
  for (const principal of principals) {
    assert.equal(allowed(principal, 'public.read', { published: true }), true);
    assert.equal(allowed(principal, 'public.read', { published: false }), false);
    assert.equal(allowed(principal, 'interaction.create'), principal !== null);
    assert.equal(allowed(principal, 'work.manage', personal), principal === author);
    assert.equal(allowed(principal, 'work.submit', team), principal === captain);
    assert.equal(allowed(principal, 'team.read', team), principal === captain || principal === member);
    assert.equal(allowed(principal, 'team.manage', team), principal === captain);
    assert.equal(allowed(principal, 'admin.access'), principal === admin);
    assert.equal(allowed(principal, 'unknown'), false);
  }
  assert.equal(allowed({ ...captain, status: 'disabled' }, 'work.submit', team), false);
  assert.equal(allowed(user, 'team.manage', { ...team, captainId: randomUUID() }), false);
  assert.equal(allowed(user, 'work.manage', {}), false);
});

test('judge requires approved assigned unlocked work and cannot score own/team work', () => {
  const judge = actor(['judge']);
  const work = { ownerId: randomUUID(), assignedJudgeIds: [judge.id], technicalStatus: 'approved', submitted: false };
  assert.equal(allowed(judge, 'review.score', work), true);
  for (const patch of [{ assignedJudgeIds: [] }, { technicalStatus: 'pending' }, { submitted: true },
    { submitted: undefined }, { ownerId: judge.id }, { captainId: judge.id }, { memberIds: [judge.id] }]) {
    assert.equal(allowed(judge, 'review.score', { ...work, ...patch }), false);
  }
  assert.equal(allowed({ ...judge, roles: [] }, 'review.score', work), false);
});

test('profile projections omit private and future fields; even admin cannot use self route for another account', () => {
  const owner = actor();
  const record = { id: owner.id, nickname: '作者', avatar: '/avatar', bio: '简介', email: 'private@example.test',
    studentNumber: 'PRIVATE', realName: 'PRIVATE', contact: 'PRIVATE', passwordHash: 'PRIVATE', futureSecret: 'PRIVATE' };
  assert.deepEqual(Object.keys(publicProfile(record)), ['id', 'nickname', 'avatar', 'bio']);
  assert.equal(JSON.stringify(publicProfile(record)).includes('PRIVATE'), false);
  assert.deepEqual(Object.keys(selfProfile(owner, record)), ['id', 'nickname', 'avatar', 'bio', 'email']);
  for (const other of [null, actor(), actor(['admin'])]) assert.throws(() => selfProfile(other, record));
  assert.deepEqual(publicTeam({ id: 'team', name: '队伍', bio: '', email: 'PRIVATE', members: [record] }),
    { id: 'team', name: '队伍', bio: '', members: [{ nickname: '作者' }] });
});

test('access guard audits refusal/success, fails closed on audit failure, and revalidation defaults to deny', async () => {
  const events = [];
  const admin = actor(['admin']);
  const args = { principal: admin, action: 'admin.sensitive', resource: { id: randomUUID() }, requestId: randomUUID(), proof: 'PRIVATE' };
  const guard = createAccessGuard({ audit: async event => events.push(event) });
  await assert.rejects(guard(args), { code: 'FORBIDDEN' });
  await assert.rejects(guard({ ...args, principal: null }), { code: 'AUTHENTICATION_REQUIRED' });
  await guard({ ...args, action: 'admin.access' });
  assert.deepEqual(events.map(e => e.outcome), ['failure', 'failure', 'success']);
  assert.equal(JSON.stringify(events).includes('PRIVATE'), false);
  const brokenAudit = createAccessGuard({ audit: async () => { throw new Error('audit unavailable'); } });
  await assert.rejects(brokenAudit({ ...args, action: 'admin.access' }), /audit unavailable/);
});

test('dangerous operations require confirmation plus server verifier; verifier exceptions audited as denial', async () => {
  const events = [], checks = [];
  const args = { principal: actor(['admin']), action: 'admin.dangerous', resource: { id: randomUUID() }, requestId: randomUUID() };
  const guard = createAccessGuard({ audit: async e => events.push(e), verifyRevalidation: async check => { checks.push(check); return true; } });
  await assert.rejects(guard(args));
  assert.equal(checks.length, 0);
  await guard({ ...args, confirmed: true });
  assert.deepEqual(checks[0], { actorId: args.principal.id, action: args.action, resourceId: args.resource.id, proof: undefined, requirePassword: true });
  await assert.rejects(guard({ ...args, principal: actor(), confirmed: true }));
  assert.equal(checks.length, 1);
  const broken = createAccessGuard({ audit: async e => events.push(e), verifyRevalidation: async () => { throw new Error('PRIVATE'); } });
  await assert.rejects(broken({ ...args, confirmed: true }), { code: 'FORBIDDEN' });
  assert.equal(events.at(-1).action, 'access.denied');
});

test('security audit parameterizes identifiers and forbids arbitrary payloads and wrong outcome pairs', async () => {
  const calls = [];
  const client = { query: async (...args) => calls.push(args) };
  const event = { action: 'access.denied', requestId: randomUUID(), actorId: randomUUID(), outcome: 'failure', permission: 'team.manage', resourceId: randomUUID() };
  await appendSecurityAudit(client, event);
  assert.equal(calls[0][0].includes(event.actorId), false);
  assert.equal(calls[0][1][3], event.actorId);
  for (const patch of [{ email: 'PRIVATE' }, { password: 'PRIVATE' }, { proof: 'PRIVATE' }, { action: 'toString' },
    { outcome: 'success' }, { actorId: "'; DROP TABLE x;" }, { permission: 'unknown' }]) {
    await assert.rejects(appendSecurityAudit(client, { ...event, ...patch }));
  }
  await appendSecurityAudit(client, { action: 'auth.login_failed', requestId: randomUUID(), outcome: 'failure' });
  assert.equal(calls.length, 2);
  assert.equal(calls[1][1][3], null);
  assert.equal(calls[1][1][5], null);
});
