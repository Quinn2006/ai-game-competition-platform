import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { AppError, publicError } from './platform/errors.mjs';
import { databaseReady } from './platform/migrations.mjs';
import { createIdentityHttp } from './modules/identity/http.mjs';
import { createCommunityHttp } from './modules/community/http.mjs';
import { createDiscoveryHttp } from './modules/discovery/http.mjs';
import { createCompetitionHttp } from './modules/competition/http.mjs';
import { createOperationsHttp } from './modules/operations/http.mjs';
import { appendAudit } from './modules/audit/repository.mjs';
import { dependenciesReady } from './platform/health.mjs';

export function createApp({ config, database, storage, log, identity, mailbox, games, discovery, community, operations, competition, availability, readinessChecks = [] }) {
  const operationsHttp = createOperationsHttp({config,operations});
  const competitionHttp = createCompetitionHttp({config,competition});
  const communityHttp = createCommunityHttp({config,community});
  const identityHttp = createIdentityHttp({ config, identity, mailbox });
  const discoveryHttp = createDiscoveryHttp({ config, discovery });
  // A 100 MB ZIP needs more than ten seconds on ordinary upload connections.
  // Keep headers bounded; body sizes are still enforced by each route.
  let active = 0;
  const waiters = new Set();
  const server = createServer({ requestTimeout: 300000, headersTimeout: 5000, maxHeaderSize: 16384 }, async (req, res) => {
    active++;
    const requestId = randomUUID();
    const start = performance.now();
    let route = 'unmatched';
    let status = 500;
    let code;
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    try {
      const path = req.url?.split('?')[0];
      if (!['/health/live','/health/ready'].includes(path) && availability && !await availability.permits()) {
        throw new AppError('SERVICE_CLOSED', 503, '服务尚未开启或正在安全停止，请稍后重试');
      }
      const response = await operationsHttp(req,res,requestId) || await competitionHttp(req,res,requestId) || await communityHttp(req,res,requestId) || await games?.(req, res, requestId) || await discoveryHttp(req, res, requestId) || await identityHttp(req, res, requestId);
      if (response) {
        route = response.route;
        status = 200;
        res.writeHead(status);
        res.end(response.data);
        return;
      }
      if (!['/health/live', '/health/ready'].includes(path)) throw new AppError('NOT_FOUND', 404, '接口不存在');
      route = path;
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.setHeader('Allow', 'GET, HEAD');
        throw new AppError('METHOD_NOT_ALLOWED', 405, '不支持的请求方法');
      }
      let data = { status: 'alive', requestId };
      if (route === '/health/ready') {
        if (!await dependenciesReady([() => databaseReady(database, config.environment), () => storage.health(), ...readinessChecks])) {
          throw new AppError('DEPENDENCIES_NOT_READY', 503, '依赖服务尚未就绪');
        }
        data = { status: 'ready', requestId };
      }
      status = 200;
      res.writeHead(status);
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify(data));
    } catch (error) {
      const result = publicError(error, requestId);
      status = result.status;
      code = result.body.error.code;
      if(status>=500 && database && code !== 'SERVICE_CLOSED') {
        // A failed database must not make error reporting wait indefinitely.
        // The request still reaches the independent stdout logger below.
        await dependenciesReady([async () => {
          await appendAudit(database,{action:'system.error',requestId,outcome:'failure'});
          return true;
        }], 250);
      }
      res.writeHead(status);
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify(result.body));
    } finally {
      active--;
      if (!active) { for (const resolve of waiters) resolve(); waiters.clear(); }
      log('http.request', { requestId, method: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'].includes(req.method) ? req.method : 'OTHER',
        route, status, code, durationMs: Math.round(performance.now() - start) });
    }
  });
  // Socket closure does not imply asynchronous handlers have finished.
  server.drainHandlers = () => active ? new Promise(resolve => waiters.add(resolve)) : Promise.resolve();
  return server;
}
