import { loadConfig } from '../src/config.mjs';
import { createLogger } from '../src/platform/logger.mjs';
import { createDatabase } from '../src/platform/database.mjs';
import { migrate } from '../src/platform/migrations.mjs';

const log = createLogger();
let database;
try {
  const config = loadConfig();
  if (!config.databaseUrl) throw new Error('Database unavailable');
  if (process.argv[2] === 'down' && process.env.CONFIRM_EMPTY_ROLLBACK !== config.environment) {
    throw new Error('Explicit empty rollback confirmation required');
  }
  database = createDatabase(config, log);
  const rows = await migrate(database, config.environment, process.argv[2]);
  process.stdout.write(`${JSON.stringify({ migrations: rows.map(row => row.id) })}\n`);
  log('migration.finished', { environment: config.environment });
} catch {
  log('app.failed', { code: 'MIGRATION_FAILED' });
  process.stderr.write('迁移未完成：检查配置、实例连通性、迁移校验和与空库回退确认。未打印连接信息。\n');
  process.exitCode = 1;
} finally {
  await database?.end();
}
