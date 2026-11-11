import { loadConfig } from './config.mjs';
import { createLogger } from './platform/logger.mjs';
import { createDatabase } from './platform/database.mjs';
import { createPrivateStorage } from './platform/storage.mjs';
import { createApp } from './app.mjs';
import { createIdentityService } from './modules/identity/service.mjs';
import { createLocalStorage } from './platform/local-storage.mjs';
import { createProductionLocalStorageDriver } from './platform/production-local-storage.mjs';
import { createScanner } from './modules/uploads/scanner.mjs';
import { createUploadService, deletionParticipant } from './modules/uploads/service.mjs';
import { createGameHttp } from './modules/uploads/http.mjs';
import { createDiscoveryService, deletionParticipant as discoveryDeletion } from './modules/discovery/service.mjs';

import { createCommunityService, deletionParticipant as communityDeletion } from './modules/community/service.mjs';
import { createOperationsService, deletionParticipant as operationsDeletion } from './modules/operations/service.mjs';
import { createCompetitionService, deletionParticipant as competitionDeletion } from './modules/competition/service.mjs';
import {competitionNotifier} from './modules/operations/competition-events.mjs';
import { pathToFileURL } from 'node:url';
import { databaseReady } from './platform/migrations.mjs';
import { dependenciesReady } from './platform/health.mjs';

// Importing the entry point does not listen or read local credentials. Tests can
// exercise the same assembly with disposable dependencies and real HTTP sockets.
export async function startServer({ config = loadConfig(), log = createLogger(), database, storage, scan, scannerReady } = {}) {
  let app, games, cleanup, cleaning = null, stopping = null;
  const close = server => new Promise(resolve => {
    if (!server) return resolve();
    server.close(() => resolve());
    server.closeIdleConnections();
  });
  const stop = () => {
    if (stopping) return stopping;
    stopping = (async () => {
      clearInterval(cleanup);
      const timeout = setTimeout(() => {
        app?.closeAllConnections();games?.game.closeAllConnections();
      }, 10000);
      timeout.unref();
      try {
        await Promise.all([close(app),close(games?.game)]);
        games?.dispose();
        await cleaning;
        await database?.end();
        log('app.stopped');
      } finally { clearTimeout(timeout); }
    })();
    return stopping;
  };
  const listen = (server, port, host) => new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve(); });
  });
  try {
    const mailbox = undefined;
    // An ACL refusal happens before creating a pool or opening either listener.
    storage ??= config.localGames ? createLocalStorage(config.submissionsRoot,config.environment)
      : config.storage.driver === 'local' ? createPrivateStorage(config, createProductionLocalStorageDriver(config))
      : createPrivateStorage(config);
    database ??= createDatabase(config, log);
    const identity = database && config.sessionSecret ? createIdentityService({ database, localAccounts:true, secret: config.sessionSecret, deletionParticipants:[deletionParticipant,discoveryDeletion,communityDeletion,competitionDeletion,operationsDeletion],
      mail: async () => { throw Error("Mail disabled for local accounts"); } }) : undefined;
    const gamesEnabled = config.localGames || config.environment === 'production';
    scan ??= createScanner({port:config.scannerPort});
    const probeScan = createScanner({port:config.scannerPort,timeout:1500});
    scannerReady ??= async () => (await probeScan(Buffer.from('platform readiness probe'))).status === 'clean';
    const readinessChecks = config.environment === 'production' ? [scannerReady] : [];
    if (config.environment === 'production' && !await dependenciesReady([
      () => databaseReady(database,config.environment), () => storage.health(), ...readinessChecks,
    ], 10000)) throw new Error('Production dependencies not ready');
    const uploads = gamesEnabled && identity ? createUploadService({database,identity,storage,scan,limits:config.uploadLimits,deadline:config.submissionDeadline}) : null;
    const operations = database ? createOperationsService({database,identity,apiSecret:config.sessionSecret,contactEmail:process.env.SUPPORT_EMAIL??''}) : null;
    const competition = database && identity ? createCompetitionService({database,identity,onEvent:competitionNotifier(operations)}) : null;
    games = createGameHttp({config,uploads,storage,competition,limits:config.uploadLimits,loadTimeout:config.gameLoadTimeout});
    const discovery = database ? createDiscoveryService({ database, identity, storage:gamesEnabled?storage:undefined }) : null;
    const community = database && identity ? createCommunityService({database,identity,secret:config.sessionSecret}) : null;
    app = createApp({ config, database, storage, log, identity, mailbox, games:games.main, discovery, community, operations, competition,
      readinessChecks:[...readinessChecks,...(gamesEnabled?[() => games.game.listening]:[])] });
    if(gamesEnabled) {
      const origin=new URL(config.gameListenOrigin);
      await listen(games.game,Number(origin.port),origin.hostname);
    }
    await listen(app,config.port,config.host);
    const failed = () => {
      log('app.failed',{code:'SERVER_ERROR'});
      process.exitCode=1;
      stop().catch(() => log('app.failed',{code:'SHUTDOWN_ERROR'}));
    };
    app.on('error',failed);games.game.on('error',failed);
    cleanup = identity ? setInterval(() => {
      if (cleaning) return;
      cleaning = (async () => {
        try { await competition?.daily(); await competition?.cleanup(); await identity.cleanup(); await discovery?.cleanup(); await community?.cleanup(); await operations?.tick(); }
        catch { log('identity.cleanup_failed', { code: 'CLEANUP_FAILED' }); }
        finally { cleaning = null; }
      })();
    }, 60000) : null;
    cleanup?.unref();
    log('app.started', { environment: config.environment });
    return {app,games,stop};
  } catch(error) { await stop(); throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const log = createLogger();
  try {
    const runtime = await startServer({log});
    let stopping = false;
    const stop = () => {
      if(stopping)return;
      stopping=true;
      const timeout=setTimeout(()=>process.exit(1),15000);timeout.unref();
      runtime.stop().catch(()=>{log('app.failed',{code:'SHUTDOWN_ERROR'});process.exitCode=1;})
        .finally(()=>clearTimeout(timeout));
    };
    process.on('SIGINT',stop);process.on('SIGTERM',stop);
  } catch {
    log('app.failed', { code: 'CONFIGURATION_ERROR' });
    process.exitCode = 1;
  }
}
