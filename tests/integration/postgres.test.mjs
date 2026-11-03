import { collectionCases } from './collection-cases.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../../backend/src/config.mjs';
import { createDatabase } from '../../backend/src/platform/database.mjs';
import { migrate, databaseReady } from '../../backend/src/platform/migrations.mjs';
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
  try {
    const existing = await database.query("SELECT to_regnamespace('platform') AS schema");
    assert.equal(existing.rows[0].schema, null, 'Use a fresh test database; existing data is never erased by setup');
    await Promise.all([migrate(database, 'test', 'up'), migrate(database, 'test', 'up')]);
    assert.equal(await databaseReady(database, 'test'), true);
    // Identity cases are run after rollback checks because they intentionally retain audit data.
    assert.equal(await databaseReady(database, 'development'), false);
    await assert.rejects(migrate(database, 'development', 'up'), /environment mismatch/);
    await migrate(database, 'test', 'down'); // support lifecycle
    await migrate(database, 'test', 'down'); // phase 7
    await migrate(database, 'test', 'down'); // phase 6
    await migrate(database, 'test', 'down'); // phase 5
    await migrate(database, 'test', 'down'); // phase 4
    await migrate(database, 'test', 'down'); // phase 3, empty upload tables
    await migrate(database, 'test', 'down');
    await migrate(database, 'test', 'down');
    assert.equal(await databaseReady(database, 'test'), false);
    await migrate(database, 'test', 'down');
    assert.equal(await databaseReady(database, 'test'), false);
    await migrate(database, 'test', 'down');
    await migrate(database, 'test', 'up');
    const event = { action: 'system.error', requestId: randomUUID(), outcome: 'failure' };
    const id = await appendAudit(database, event);
    const result = await database.query('SELECT * FROM platform.audit_events WHERE id = $1', [id]);
    assert.equal(result.rows[0].request_id, event.requestId);
    assert.equal(result.rows[0].retention_class, 'general_error_30d');
    assert.ok(result.rows[0].expires_at > result.rows[0].occurred_at);
    await migrate(database, 'test', 'down'); // support lifecycle
    await migrate(database, 'test', 'down'); // phase 7
    await migrate(database, 'test', 'down'); // phase 6
    await migrate(database, 'test', 'down'); // phase 5
    await migrate(database, 'test', 'down'); // phase 4
    await migrate(database, 'test', 'down'); // phase 3
    await migrate(database, 'test', 'down');
    await migrate(database, 'test', 'down');
    await migrate(database, 'test', 'down');
    await assert.rejects(migrate(database, 'test', 'down'), /audit history is not empty/);
    await migrate(database, 'test', 'up');
    const securityId = await appendSecurityAudit(database, { action: 'access.denied', requestId: randomUUID(),
      actorId: randomUUID(), outcome: 'failure', permission: 'admin.access' });
    const security = (await database.query('SELECT *, expires_at = occurred_at + interval \'6 months\' AS correct_expiry FROM platform.security_events WHERE id = $1', [securityId])).rows[0];
    assert.equal(security.retention_class, 'security_6m');
    assert.equal(security.correct_expiry, true);
    await assert.rejects(database.query("INSERT INTO platform.security_events (id, action, request_id, outcome) VALUES ($1, 'access.granted', $2, 'failure')", [randomUUID(), randomUUID()]));
    await migrate(database, 'test', 'down'); // support lifecycle
    await migrate(database, 'test', 'down'); // phase 7
    await migrate(database, 'test', 'down'); // phase 6
    await migrate(database, 'test', 'down'); // phase 5
    await migrate(database, 'test', 'down'); // phase 4
    await migrate(database, 'test', 'down'); // phase 3
    await migrate(database, 'test', 'down');
    await migrate(database, 'test', 'down');
    await assert.rejects(migrate(database, 'test', 'down'), /security audit history is not empty/);
    await migrate(database, 'test', 'up');
    assert.equal(await databaseReady(database, 'test'), true);
    await identityCases(database);
    await migrate(database, 'test', 'down'); // support lifecycle
    await migrate(database, 'test', 'down'); // phase 7
    await migrate(database, 'test', 'down'); // phase 6
    await migrate(database, 'test', 'down'); // phase 5
    await migrate(database, 'test', 'down'); // phase 4
    await migrate(database, 'test', 'down'); // phase 3 remains empty
    await migrate(database, 'test', 'down');
    await assert.rejects(migrate(database, 'test', 'down'), /identity data is not empty/);
    await migrate(database, 'test', 'up');
    await uploadCases(database);
    await migrate(database, 'test', 'down'); // support lifecycle
    await migrate(database, 'test', 'down'); // phase 7
    await migrate(database, 'test', 'down'); // phase 6
    await migrate(database, 'test', 'down');
    await migrate(database, 'test', 'down');
    await assert.rejects(migrate(database, 'test', 'down'), /Upload history is not empty/);
    await migrate(database, 'test', 'up');
    await communityCases(database);
    await migrate(database, 'test', 'down'); // support lifecycle
    await migrate(database, 'test', 'down'); // phase 7
    await assert.rejects(migrate(database, 'test', 'down'), /Competition history is not empty/);
    await migrate(database, 'test', 'up');
    await operationsCases(database);
    await localIdentityCases(database);
    await collectionCases(database);
    await database.query("UPDATE public.schema_migrations SET checksum = 'tampered' WHERE id = '001_foundation'");
    await assert.rejects(migrate(database, 'test', 'up'), /history mismatch/);
    await assert.rejects(databaseReady(database, 'test'), /history mismatch/);
    // Leave evidence in the disposable database. CI destroys its isolated service.
  } finally {
    await database.end();
  }
});
