import {providerCases} from './provider-cases.mjs';
import { collectionCases } from './collection-cases.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../../backend/src/config.mjs';
import { createDatabase } from '../../backend/src/platform/database.mjs';
import { migrate, databaseReady, migrationFiles } from '../../backend/src/platform/migrations.mjs';
import { appendAudit } from '../../backend/src/modules/audit/repository.mjs';
import { appendSecurityAudit } from '../../backend/src/modules/audit/security.mjs';
import { identityCases } from './identity-cases.mjs';
import { communityCases } from './community-cases.mjs';
import { uploadCases } from './upload-cases.mjs';
import { operationsCases } from './operations-cases.mjs';
import { localIdentityCases } from './local-identity-cases.mjs';

test('PostgreSQL: concurrent migration, empty rollback, reapply, audit persistence, nonempty rollback refusal', async () => {
  const config = loadConfig();
  assert.equal(config.environment, 'test', 'Only a dedicated disposable test database is allowed');
  assert.ok(config.databaseUrl, 'DATABASE_URL is required; this suite must not silently skip');
  assert.equal(process.env.CONFIRM_DISPOSABLE_DATABASE, 'ai_games_test', 'Explicit disposable database acknowledgement required');
  const database = createDatabase(config, () => {});
  const migrations = await migrationFiles();
  async function rollbackTo(id) {
    let rows = await migrate(database, 'test', 'status');
    assert.ok(id === null || rows.some(row => row.id === id), 'Rollback target must be applied');
    while (rows.length && rows.at(-1).id !== id) rows = await migrate(database, 'test', 'down');
    assert.equal(rows.at(-1)?.id ?? null, id);
  }
  // Once deletion evidence exists, migration 012 correctly blocks all rollback.
  // Exercise earlier data guards directly in an always-rolled-back transaction,
  // preserving the ledger and the complete current schema for business tests.
  async function earlierRollbackRefuses(id, message) {
    const migration = migrations.find(item => item.id === id);
    assert.ok(migration);
    const client = await database.connect();
    try {
      await client.query('BEGIN');
      await assert.rejects(client.query(migration.down), message);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  }
  try {
    const existing = await database.query("SELECT to_regnamespace('platform') AS schema");
    assert.equal(existing.rows[0].schema, null, 'Use a fresh test database; existing data is never erased by setup');
    await Promise.all([migrate(database, 'test', 'up'), migrate(database, 'test', 'up')]);
    assert.equal(await databaseReady(database, 'test'), true);
    // Identity cases are run after rollback checks because they intentionally retain audit data.
    assert.equal(await databaseReady(database, 'development'), false);
    await assert.rejects(migrate(database, 'development', 'up'), /environment mismatch/);
    await rollbackTo('002_security_audit');
    assert.equal(await databaseReady(database, 'test'), false);
    await rollbackTo(null);
    assert.equal((await database.query("SELECT to_regnamespace('platform') AS schema")).rows[0].schema, null);
    await migrate(database, 'test', 'up');
    const event = { action: 'system.error', requestId: randomUUID(), outcome: 'failure' };
    const id = await appendAudit(database, event);
    const result = await database.query('SELECT * FROM platform.audit_events WHERE id = $1', [id]);
    assert.equal(result.rows[0].request_id, event.requestId);
    assert.equal(result.rows[0].retention_class, 'general_error_30d');
    assert.ok(result.rows[0].expires_at > result.rows[0].occurred_at);
    await rollbackTo('001_foundation');
    await assert.rejects(migrate(database, 'test', 'down'), /audit history is not empty/);
    await migrate(database, 'test', 'up');
    const securityId = await appendSecurityAudit(database, { action: 'access.denied', requestId: randomUUID(),
      actorId: randomUUID(), outcome: 'failure', permission: 'admin.access' });
    const security = (await database.query('SELECT *, expires_at = occurred_at + interval \'6 months\' AS correct_expiry FROM platform.security_events WHERE id = $1', [securityId])).rows[0];
    assert.equal(security.retention_class, 'security_6m');
    assert.equal(security.correct_expiry, true);
    await assert.rejects(database.query("INSERT INTO platform.security_events (id, action, request_id, outcome) VALUES ($1, 'access.granted', $2, 'failure')", [randomUUID(), randomUUID()]));
    await rollbackTo('002_security_audit');
    await assert.rejects(migrate(database, 'test', 'down'), /security audit history is not empty/);
    await migrate(database, 'test', 'up');
    assert.equal(await databaseReady(database, 'test'), true);
    await identityCases(database);
    const ledger = (await database.query('SELECT * FROM platform.recovery_ledger ORDER BY kind,id')).rows;
    assert.ok(ledger.some(row => row.kind === 'account'));
    await assert.rejects(migrate(database, 'test', 'down'), /Recovery evidence cannot be discarded/);
    assert.deepEqual((await database.query('SELECT * FROM platform.recovery_ledger ORDER BY kind,id')).rows, ledger);
    assert.equal(await databaseReady(database, 'test'), true);
    await earlierRollbackRefuses('003_identity', /identity data is not empty/);
    await uploadCases(database);
    await earlierRollbackRefuses('006_discovery', /discovery data is not empty/);
    await communityCases(database);
    await earlierRollbackRefuses('008_competition', /Competition history is not empty/);
    await operationsCases(database);
    await localIdentityCases(database);
    await collectionCases(database);
    await providerCases(database);
    await database.query("UPDATE public.schema_migrations SET checksum = 'tampered' WHERE id = '001_foundation'");
    await assert.rejects(migrate(database, 'test', 'up'), /history mismatch/);
    await assert.rejects(databaseReady(database, 'test'), /history mismatch/);
    // Leave evidence in the disposable database. CI destroys its isolated service.
  } finally {
    await database.end();
  }
});
