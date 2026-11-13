import pg from 'pg';
import { readFileSync } from 'node:fs';

export function createDatabase(config, log) {
  if (!config.databaseUrl) return null;
  const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 5,
    connectionTimeoutMillis: 3000, idleTimeoutMillis: 10000,
    statement_timeout: 5000, query_timeout: 6000,
    ssl: config.databaseTls === 'verify-full' ? { rejectUnauthorized: true,
      ...(config.databaseCaFile ? { ca: readFileSync(config.databaseCaFile, 'utf8') } : {}) } : false });
  pool.on('error', () => log('database.error', { code: 'DATABASE_UNAVAILABLE' }));
  return pool;
}

export async function assertApplicationRole(pool) {
  const {rows:[role]} = await pool.query(`SELECT r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls
    OR pg_has_role(current_user,d.datdba,'MEMBER') OR has_schema_privilege(current_user,'platform','CREATE')
    OR has_table_privilege(current_user,'public.schema_migrations','INSERT,UPDATE,DELETE,TRUNCATE')
    OR has_table_privilege(current_user,'platform.environment_identity','INSERT,UPDATE,DELETE,TRUNCATE') AS unsafe
    FROM pg_roles r JOIN pg_database d ON d.datname=current_database() WHERE r.rolname=current_user`);
  if (!role || role.unsafe) throw Error('Production application role has management privileges');
}
