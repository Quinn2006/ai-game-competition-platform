import { loadConfig } from './config.mjs';
import { createLogger } from './platform/logger.mjs';
import { createDatabase, assertApplicationRole } from './platform/database.mjs';
import { createAvailability } from './platform/availability.mjs';
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
import { readRuntimeConfig, validationClient, resourcePermit } from './platform/isolated-runtime.mjs';
import { callChannel, serveChannel } from './platform/service-channel.mjs';
import { dependenciesReady } from './platform/health.mjs';

// Importing the entry point does not listen or read local credentials. Tests can
// exercise the same assembly with disposable dependencies and real HTTP sockets.
export async function startServer({ config = loadConfig(), log = createLogger(), database, storage, scan, scannerReady, isolation, embeddedGames = false, availability = createAvailability() } = {}) {
  let app, games, channel, cleanup, cleaning = null, stopping = null;
  const close = server => new Promise(resolve => {
    if (!server) return resolve();
    server.close(() => resolve());
    server.closeIdleConnections();
  });
  const stop = () => {
    if (stopping) return stopping;
    stopping = (async () => {
      availability.drain();
      clearInterval(cleanup);
      const timeout = setTimeout(() => {
        app?.closeAllConnections();games?.game?.closeAllConnections();
      }, 10000);
      timeout.unref();
      try {
        await Promise.all([close(app),close(games?.game)]);
        await app?.drainHandlers();
        await channel?.close();
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
    if (config.environment === 'production' && !embeddedGames) {
      isolation ??= await readRuntimeConfig(process.env.ISOLATION_CONFIG, 'main');
    }

    // An ACL refusal happens before creating a pool or opening either listener.
    storage ??= config.localGames ? createLocalStorage(config.submissionsRoot,config.environment)
      : config.storage.driver === 'local' ? createPrivateStorage(config, createProductionLocalStorageDriver(config))
      : createPrivateStorage(config);
    const injectedDatabase = Boolean(database);
    database ??= createDatabase(config, log);
    if (config.environment === 'production' && !injectedDatabase) await assertApplicationRole(database);
    const identity = database && config.sessionSecret ? createIdentityService({ database, localAccounts:true, secret: config.sessionSecret, deletionParticipants:[deletionParticipant,discoveryDeletion,communityDeletion,competitionDeletion,operationsDeletion],
      mail: async () => { throw Error("Mail disabled for local accounts"); } }) : undefined;
    const gamesEnabled = config.localGames || config.environment === 'production';
    scan ??= createScanner({port:config.scannerPort});
    const probeScan = createScanner({port:config.scannerPort,timeout:1500});
    scannerReady ??= isolation ? async () => (await callChannel(isolation.validator,{action:'health'})).ready === true : async () => (await probeScan(Buffer.from('platform readiness probe'))).status === 'clean';
    const readinessChecks = config.environment === 'production' ? [scannerReady] : [];
    if (config.environment === 'production' && !await dependenciesReady([
      () => databaseReady(database,config.environment), () => storage.health(), ...readinessChecks,
    ], 10000)) throw new Error('Production dependencies not ready');
    const uploads = gamesEnabled && identity ? createUploadService({database,identity,storage,scan,validate:isolation?validationClient(isolation,config.uploadLimits):undefined,limits:config.uploadLimits,deadline:config.submissionDeadline}) : null;
    const operations = database ? createOperationsService({database,identity,apiSecret:config.sessionSecret,contactEmail:process.env.SUPPORT_EMAIL??''}) : null;
    const competition = database && identity ? createCompetitionService({database,identity,onEvent:competitionNotifier(operations)}) : null;
    games = createGameHttp({config,uploads,storage,competition,isolated:Boolean(isolation),limits:config.uploadLimits,loadTimeout:config.gameLoadTimeout});
    if (isolation) channel = await serveChannel(isolation.auth, async input => {
      if (!await availability.permits()) throw Error('Service closed');
      if (input?.action !== 'authorize' || typeof input.token !== 'string' || !/^[a-f0-9]{64}$/.test(input.token) || typeof input.path !== 'string' || input.path.length > 240) throw Error('Invalid authorization');
      const {version} = await games.authorize(input.token);
      return resourcePermit(isolation,version,input.path,config.uploadLimits);
    });
    const gameReady = isolation ? async () => (await callChannel(isolation.control,{action:'health'})).ready === true : () => games.game.listening;
    const discovery = database ? createDiscoveryService({ database, identity, storage:gamesEnabled?storage:undefined }) : null;
    const community = database && identity ? createCommunityService({database,identity,secret:config.sessionSecret}) : null;
    app = createApp({ config, database, storage, log, identity, mailbox, games:games.main, discovery, community, operations, competition, availability,
      readinessChecks:[...readinessChecks,...(gamesEnabled?[gameReady]:[])] });
    if(gamesEnabled && !isolation) {
      const origin=new URL(config.gameListenOrigin);
      await listen(games.game,Number(origin.port),origin.hostname);
    }
    await listen(app,config.port,config.host);
    const failed = () => {
      log('app.failed',{code:'SERVER_ERROR'});
      process.exitCode=1;
      stop().catch(() => log('app.failed',{code:'SHUTDOWN_ERROR'}));
    };
    app.on('error',failed);games.game?.on('error',failed);
    cleanup = identity ? setInterval(() => {
      if (cleaning || stopping) return;
      cleaning = (async () => {
        try { if (!await availability.permits()) return; await competition?.daily(); await competition?.cleanup(); await identity.cleanup(); await discovery?.cleanup(); await community?.cleanup(); await operations?.tick(); }
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
    const config = loadConfig();
    if (config.environment === 'production' && !process.env.AGP_AVAILABILITY_FILE) throw Error('Managed availability required');
    const availability = createAvailability(process.env.AGP_AVAILABILITY_FILE);
    const runtime = await startServer({log,config,availability});
    let stopping = false;
    const control = process.env.AGP_AVAILABILITY_FILE ? setInterval(async () => {
      if (await availability.state() === 'draining') stop();
    }, 500) : null;
    control?.unref();
    const stop = () => {
      if(stopping)return;
      stopping=true;
      clearInterval(control);
      const timeout=setTimeout(()=>process.exit(1),130000);timeout.unref();
      runtime.stop().catch(()=>{log('app.failed',{code:'SHUTDOWN_ERROR'});process.exitCode=1;})
        .finally(()=>clearTimeout(timeout));
    };
    process.on('SIGINT',stop);process.on('SIGTERM',stop);
  } catch {
    log('app.failed', { code: 'CONFIGURATION_ERROR' });
    process.exitCode = 1;
  }
}
