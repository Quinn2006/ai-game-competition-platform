import { loadConfig } from './config.mjs';
import { createLogger } from './platform/logger.mjs';
import { createDatabase } from './platform/database.mjs';
import { createPrivateStorage } from './platform/storage.mjs';
import { createApp } from './app.mjs';
import { createIdentityService } from './modules/identity/service.mjs';
import { createLocalStorage } from './platform/local-storage.mjs';
import { createScanner } from './modules/uploads/scanner.mjs';
import { createUploadService, deletionParticipant } from './modules/uploads/service.mjs';
import { createGameHttp } from './modules/uploads/http.mjs';
import { createDiscoveryService, deletionParticipant as discoveryDeletion } from './modules/discovery/service.mjs';

import { createCommunityService, deletionParticipant as communityDeletion } from './modules/community/service.mjs';
import { createOperationsService, deletionParticipant as operationsDeletion } from './modules/operations/service.mjs';

const log = createLogger();
try {
  const config = loadConfig();
  const database = createDatabase(config, log);
  const mailbox = config.localMailPreview ? [] : undefined;
  const identity = database && config.sessionSecret && mailbox ? createIdentityService({ database, secret: config.sessionSecret, deletionParticipants:[deletionParticipant,discoveryDeletion,communityDeletion,operationsDeletion],
    mail: async message => { mailbox.push(message); if (mailbox.length > 50) mailbox.shift(); } }) : undefined;
  const storage = config.localGames ? createLocalStorage('tmp/private-games',config.environment) : createPrivateStorage(config);
  const uploads = config.localGames && identity ? createUploadService({database,identity,storage,scan:createScanner({port:config.scannerPort}),limits:config.uploadLimits,deadline:config.submissionDeadline}) : null;
  const games = createGameHttp({config,uploads,storage,limits:config.uploadLimits,loadTimeout:config.gameLoadTimeout});
  const discovery = database ? createDiscoveryService({ database, identity }) : null;
  const community = database && identity ? createCommunityService({database,identity,secret:config.sessionSecret}) : null;
  const operations = database ? createOperationsService({database,identity,contactEmail:process.env.SUPPORT_EMAIL??''}) : null;
  const app = createApp({ config, database, storage, log, identity, mailbox, games:games.main, discovery, community, operations });
  if(config.localGames) {
    games.game.on('error',()=>{log('app.failed',{code:'GAME_SERVER_ERROR'});app.close();process.exitCode=1;});
    const origin=new URL(config.gameOrigin);games.game.listen(Number(origin.port),origin.hostname);
  }
  let cleaning = false;
  const cleanup = identity ? setInterval(async () => {
    if (cleaning) return;
    cleaning = true;
    try { await identity.cleanup(); await discovery?.cleanup(); await community?.cleanup(); await operations?.tick(); } catch { log('identity.cleanup_failed', { code: 'CLEANUP_FAILED' }); }
    finally { cleaning = false; }
  }, 60000) : null;
  cleanup?.unref();
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
    clearInterval(cleanup);
    games.game.close();games.game.closeAllConnections();
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
