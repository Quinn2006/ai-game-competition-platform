import { readFile } from 'node:fs/promises';
import { AppError } from '../../platform/errors.mjs';

const assets = new Map([['/account', ['account.html','text/html']], ['/account/app.mjs', ['account.mjs','text/javascript']], ['/account/style.css', ['account.css','text/css']]]);
const postActions = new Set(['register','resend','verify','login','logout','forgot','reset','profile','mfa/setup','mfa/enable','revalidate','admin/profile','admin/roles','delete','cancel']);
const cookieName = config => config.environment === 'production' ? '__Host-session' : 'session';
function cookie(req, name) {
  const matches = (req.headers.cookie ?? '').split(';').map(x => x.trim()).filter(x => x.startsWith(`${name}=`));
  return matches.length === 1 ? matches[0].slice(name.length + 1) : undefined;
}
async function body(req) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw new AppError('CONTENT_TYPE', 415, '需要 JSON 请求');
  let length = 0;
  const parts = [];
  for await (const part of req) {
    length += part.length;
    if (length > 16384) throw new AppError('BODY_TOO_LARGE', 413, '请求内容过大');
    parts.push(part);
  }
  try {
    const value = JSON.parse(Buffer.concat(parts).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new AppError('INVALID_JSON', 400, '请求内容无效'); }
}

export function createIdentityHttp({ config, identity, mailbox }) {
  return async (req, res, requestId) => {
    const path = req.url?.split('?')[0];
    if (!assets.has(path) && !path.startsWith('/api/identity/') && path !== '/dev/mail') return null;
    // Prevent DNS rebinding to the local mailbox and enforce a single trusted origin.
    if (req.headers.host !== new URL(config.mainOrigin).host) throw new AppError('INVALID_HOST', 403, '请求来源无效');
    const asset = assets.get(path);
    if (asset) {
      if (!['GET','HEAD'].includes(req.method)) throw new AppError('METHOD_NOT_ALLOWED', 405, '不支持的请求方法');
      res.setHeader('Content-Type', `${asset[1]}; charset=utf-8`);
      res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
      res.setHeader('Referrer-Policy', 'no-referrer');
      return { route: path, data: req.method === 'HEAD' ? '' : await readFile(new URL(`../../web/${asset[0]}`, import.meta.url)) };
    }
    if (path === '/dev/mail') {
      if (config.environment !== 'development' || !mailbox || !['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) throw new AppError('NOT_FOUND', 404, '接口不存在');
      if (req.method !== 'GET') throw new AppError('METHOD_NOT_ALLOWED', 405, '不支持的请求方法');
      if (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin') throw new AppError('FORBIDDEN', 403, '请求来源无效');
      return { route: '/dev/mail', data: JSON.stringify({ messages: mailbox }) };
    }
    if (!identity) throw new AppError('IDENTITY_UNAVAILABLE', 503, '账号服务尚未配置，请联系管理员');
    let action = path.slice('/api/identity/'.length);
    if (action.startsWith('public/')) {
      if (req.method !== 'GET') throw new AppError('METHOD_NOT_ALLOWED', 405, '不支持的请求方法');
      return { route: '/api/identity/public/:id', data: JSON.stringify(await identity.publicProfile(action.slice(7))) };
    }
    if (action !== 'me' && !postActions.has(action)) throw new AppError('NOT_FOUND', 404, '接口不存在');
    if (req.method !== (action === 'me' ? 'GET' : 'POST')) throw new AppError('METHOD_NOT_ALLOWED', 405, '不支持的请求方法');
    if (req.method === 'POST' && (req.headers.origin !== config.mainOrigin ||
        (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin'))) throw new AppError('CSRF_REJECTED', 403, '请从本站页面执行操作');
    const input = req.method === 'POST' ? await body(req) : {};
    const result = await identity.run(action, input, { requestId, address: req.socket.remoteAddress,
      sessionToken: cookie(req, cookieName(config)) });
    if (result.sessionToken || result.clearSession) {
      res.setHeader('Set-Cookie', `${cookieName(config)}=${result.sessionToken ?? ''}; Path=/; HttpOnly; SameSite=Strict${config.environment === 'production' ? '; Secure' : ''}${result.clearSession ? '; Max-Age=0' : ''}`);
    }
    const { sessionToken: _secret, clearSession: _clear, ...data } = result;
    return { route: `/api/identity/${action}`, data: JSON.stringify(data) };
  };
}
