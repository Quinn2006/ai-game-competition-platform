import pg from 'pg';

export function createDatabase(config, log) {
  if (!config.databaseUrl) return null;
  const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 5,
    connectionTimeoutMillis: 3000, idleTimeoutMillis: 10000,
    statement_timeout: 5000, query_timeout: 6000,
    ssl: config.databaseTls === 'verify-full' ? { rejectUnauthorized: true } : false });
  pool.on('error', () => log('database.error', { code: 'DATABASE_UNAVAILABLE' }));
  return pool;
}
