import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { AppError, publicError } from './platform/errors.mjs';
import { databaseReady } from './platform/migrations.mjs';
import { createIdentityHttp } from './modules/identity/http.mjs';

export function createApp({ config, database, storage, log, identity, mailbox }) {
  const identityHttp = createIdentityHttp({ config, identity, mailbox });
  return createServer({ requestTimeout: 10000, headersTimeout: 5000, maxHeaderSize: 16384 }, async (req, res) => {
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
      const response = await identityHttp(req, res, requestId);
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
        const results = await Promise.allSettled([databaseReady(database, config.environment), storage.health()]);
        if (results.some(result => result.status !== 'fulfilled' || result.value !== true)) {
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
      res.writeHead(status);
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify(result.body));
    } finally {
      log('http.request', { requestId, method: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'].includes(req.method) ? req.method : 'OTHER',
        route, status, code, durationMs: Math.round(performance.now() - start) });
    }
  });
}
