// Use a transaction client. Holds are record-specific and remain effective until
// explicitly released; an overdue review date must never silently erase evidence.
import { randomUUID } from 'node:crypto';

const tables = ['audit_events','security_events','identity_events'];
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
// Internal administrative adapter; caller must authorize and supply a transaction.
export async function placeAuditHold(client, { table, eventId, reason, approvedBy, reviewAt }) {
  if (!tables.includes(table) || !uuid(eventId) || !uuid(approvedBy) ||
      !['appeal','security_incident','required_retention'].includes(reason) || !(reviewAt instanceof Date) || !Number.isFinite(+reviewAt)) throw new Error('Invalid retention hold');
  await client.query('SELECT pg_advisory_xact_lock(432002)');
  const event = await client.query(`SELECT id FROM platform.${table} WHERE id=$1 FOR UPDATE`,[eventId]);
  if (!event.rowCount) throw new Error('Audit event not found');
  const id=randomUUID();
  await client.query('INSERT INTO platform.audit_holds (id,event_table,event_id,reason,approved_by,review_at) VALUES ($1,$2,$3,$4,$5,$6)',[id,table,eventId,reason,approvedBy,reviewAt]);
  return id;
}

export async function cleanupAudit(client, now = new Date()) {
  await client.query('SELECT pg_advisory_xact_lock(432002)');
  let deleted = 0;
  for (const table of tables) {
    const result = await client.query(`DELETE FROM platform.${table} WHERE id IN (
      SELECT event.id FROM platform.${table} event WHERE event.expires_at <= $1
      AND NOT EXISTS (SELECT 1 FROM platform.audit_holds hold WHERE hold.event_table=$2 AND hold.event_id=event.id AND hold.released_at IS NULL)
      ORDER BY event.expires_at LIMIT 500 FOR UPDATE SKIP LOCKED)`, [now, table]);
    deleted += result.rowCount;
  }
  return deleted;
}
