import { randomUUID } from 'node:crypto';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Only infrastructure events in phase 1. Business actions and retention rules
// must be registered when their owning module is implemented.
export async function appendAudit(client, event) {
  if (Object.keys(event).some(key => !['action', 'requestId', 'outcome'].includes(key)) ||
      event.action !== 'system.error' || !uuid.test(event.requestId) ||
      event.outcome !== 'failure') throw new Error('Invalid audit event');
  const id = randomUUID();
  await client.query(`INSERT INTO platform.audit_events
    (id, action, request_id, outcome) VALUES ($1, $2, $3, $4)`,
  [id, event.action, event.requestId, event.outcome]);
  return id;
}
