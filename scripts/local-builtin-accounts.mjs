import { loadConfig } from '../backend/src/config.mjs';
import { createDatabase } from '../backend/src/platform/database.mjs';
import { seedBuiltinAccounts } from '../backend/src/modules/identity/builtin-accounts.mjs';

let database;
try {
  const config = loadConfig();
  if (config.environment !== 'development' || !config.databaseUrl) throw new Error('Local development required');
  database = createDatabase(config, () => {});
  const { created } = await seedBuiltinAccounts(database, config);
  console.log(`本地内置账号：新建 ${created} 个；已有账号保持不变。Admin06 / Judge1—Judge5。`);
} catch {
  console.error('内置账号初始化失败：请检查本机开发库、迁移及数据库权限。');
  process.exitCode = 1;
} finally { await database?.end(); }
