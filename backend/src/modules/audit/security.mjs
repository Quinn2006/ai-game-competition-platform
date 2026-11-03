import { randomUUID } from 'node:crypto';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const permissions = new Set(['public.read', 'interaction.create', 'profile.readSelf', 'profile.updateSelf',
  'work.manage', 'work.submit', 'team.read', 'team.manage', 'review.score',
  'admin.access', 'admin.sensitive', 'admin.dangerous']);

export async function appendSecurityAudit(client, event) {
  const outcomes = { 'access.granted': 'success', 'access.denied': 'failure', 'auth.login_failed': 'failure' };
  if (Object.keys(event).some(key => !['action', 'requestId', 'actorId', 'outcome', 'permission', 'resourceId'].includes(key)) ||
      !Object.hasOwn(outcomes, event.action) || outcomes[event.action] !== event.outcome || !uuid.test(event.requestId) ||
      (event.actorId != null && !uuid.test(event.actorId)) || (event.resourceId != null && !uuid.test(event.resourceId)) ||
      (event.action.startsWith('access.') ? !permissions.has(event.permission) : event.permission != null)) {
    throw new Error('Invalid security audit event');
  }
  const id = randomUUID();
  await client.query(`INSERT INTO platform.security_events
    (id, action, request_id, actor_id, outcome, permission, resource_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7)`,
  [id, event.action, event.requestId, event.actorId ?? null, event.outcome, event.permission ?? null, event.resourceId ?? null]);
  return id;
}
