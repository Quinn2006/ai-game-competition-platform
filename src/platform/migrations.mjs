import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

export async function migrationFiles() {
  // Git may check out CRLF on Windows; checksums must match Linux releases.
  return Promise.all(['001_foundation', '002_security_audit', '003_identity', '004_audit_retention', '005_uploads', '006_discovery', '007_community', '008_competition', '009_operations', '010_support_lifecycle'].map(async id => {
    const up = (await readFile(new URL(`../../migrations/${id}.up.sql`, import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
    const down = (await readFile(new URL(`../../migrations/${id}.down.sql`, import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
    return { id, up, down, checksum: createHash('sha256').update(up).update('\0').update(down).digest('hex') };
  }));
}

function validateHistory(rows, migrations) {
  if (rows.length > migrations.length || rows.some((row, index) =>
    row.id !== migrations[index].id || row.checksum !== migrations[index].checksum)) {
    throw new Error('Migration history mismatch');
  }
}

export async function databaseReady(pool, environment) {
  if (!pool) return false;
  const { rows } = await pool.query('SELECT id, checksum FROM public.schema_migrations ORDER BY id');
  const migrations = await migrationFiles();
  validateHistory(rows, migrations);
  if (rows.length !== migrations.length) return false;
  const identity = await pool.query('SELECT environment FROM platform.environment_identity WHERE singleton = true');
  return identity.rows[0]?.environment === environment;
}

export async function migrate(pool, environment, direction) {
  if (!['up', 'down', 'status'].includes(direction)) throw new Error('Invalid migration direction');
  if (!['development', 'test'].includes(environment)) throw new Error('Production migration requires a separate approved release procedure');
  const migrations = await migrationFiles();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query('SELECT pg_advisory_xact_lock(432001)');
    const exists = await client.query("SELECT to_regclass('public.schema_migrations') AS name");
    if (!exists.rows[0].name) {
      if (direction !== 'up') { await client.query('COMMIT'); return []; }
      await client.query(`CREATE TABLE public.schema_migrations (
        id text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
      await client.query('REVOKE ALL ON public.schema_migrations FROM PUBLIC');
    }
    const { rows } = await client.query('SELECT id, checksum FROM public.schema_migrations ORDER BY id');
    validateHistory(rows, migrations);
    if (rows.length) {
      const identity = await client.query('SELECT environment FROM platform.environment_identity WHERE singleton = true');
      if (identity.rows[0]?.environment !== environment) throw new Error('Database environment mismatch');
    }
    if (direction === 'up') {
      for (const migration of migrations.slice(rows.length)) {
        await client.query(migration.up);
        if (migration.id === '001_foundation') {
          await client.query('INSERT INTO platform.environment_identity (environment) VALUES ($1)', [environment]);
        }
        await client.query('INSERT INTO public.schema_migrations (id, checksum) VALUES ($1, $2)', [migration.id, migration.checksum]);
      }
    } else if (direction === 'down' && rows.length) {
      const migration = migrations[rows.length - 1];
      await client.query(migration.down);
      await client.query('DELETE FROM public.schema_migrations WHERE id = $1', [migration.id]);
    }
    const result = await client.query('SELECT id, checksum FROM public.schema_migrations ORDER BY id');
    await client.query('COMMIT');
    return result.rows;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
