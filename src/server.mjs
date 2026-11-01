import { loadConfig } from './config.mjs';
import { createLogger } from './platform/logger.mjs';
import { createDatabase } from './platform/database.mjs';
import { createPrivateStorage } from './platform/storage.mjs';
import { createApp } from './app.mjs';

const log = createLogger();
try {
  const config = loadConfig();
  const database = createDatabase(config, log);
  const app = createApp({ config, database, storage: createPrivateStorage(config), log });
  app.on('error', async () => {
    log('app.failed', { code: 'SERVER_ERROR' });
    await database?.end();
    process.exitCode = 1;
  });
  app.listen(config.port, config.host, () => log('app.started', { environment: config.environment }));
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    const timeout = setTimeout(() => process.exit(1), 10000);
    timeout.unref();
    app.close(async () => {
      await database?.end();
      clearTimeout(timeout);
      log('app.stopped');
    });
    app.closeIdleConnections();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
} catch {
  log('app.failed', { code: 'CONFIGURATION_ERROR' });
  process.exitCode = 1;
}
