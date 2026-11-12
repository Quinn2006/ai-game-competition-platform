import { createServer, request } from 'node:http';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { AppError } from './errors.mjs';

// Separate per-service keys, protected by the installer ACLs. Neither key is a
// database credential or a session secret. Responses bind the request nonce.
const mac = (key, text) => createHmac('sha256', key).update(text).digest('hex');
const equal = (a, b) => typeof a === 'string' && /^[a-f0-9]{64}$/.test(a) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const unavailable = () => new AppError('SERVICE_UNAVAILABLE', 503, '内部服务暂不可用');
export function checkChannel({ pipe, key, service }) {
  if (!/^\\\\\.\\pipe\\agp-[a-z0-9-]{8,100}$/.test(pipe) || !/^[a-f0-9]{64}$/.test(key) || !/^[a-z-]{3,30}$/.test(service)) throw Error('Invalid service channel');
}
async function body(stream) {
  const chunks = []; let size = 0;
  for await (const chunk of stream) { size += chunk.length; if (size > 262144) throw unavailable(); chunks.push(chunk); }
  return Buffer.concat(chunks).toString('utf8');
}
export async function serveChannel(options, handle) {
  checkChannel(options);
  const { pipe, key, service } = options, seen = new Map(), sockets = new Set();
  let active = 0;
  const server = createServer({ requestTimeout: 5000, headersTimeout: 5000, maxHeaderSize: 4096 }, async (req, res) => {
    let counted = false;
    try {
      if (req.method !== 'POST' || req.url !== '/' || active >= 32) throw unavailable();
      active++; counted = true;
      const raw = await body(req), auth = req.headers['x-service-mac'];
      if (!equal(auth, mac(key, `${service}:request:${raw}`))) throw unavailable();
      const envelope = JSON.parse(raw), now = Date.now();
      for (const [nonce, expires] of seen) if (expires < now) seen.delete(nonce);
      if (!/^[a-f0-9]{48}$/.test(envelope.nonce) || !Number.isSafeInteger(envelope.time) || Math.abs(now - envelope.time) > 30000 || seen.has(envelope.nonce) || seen.size >= 4096) throw unavailable();
      seen.set(envelope.nonce, now + 60000);
      let result;
      try { result = { ok: true, value: await handle(envelope.value) }; }
      catch (error) { result = { ok: false, status: error instanceof AppError ? error.status : 503 }; }
      const reply = JSON.stringify({ nonce: envelope.nonce, ...result });
      if (Buffer.byteLength(reply) > 262144) throw unavailable();
      res.setHeader('x-service-mac', mac(key, `${service}:response:${reply}`));
      res.end(reply);
    } catch { res.writeHead(503); res.end(); }
    finally { if (counted) active--; }
  });
  server.maxConnections = 64;
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.setTimeout(125000, () => socket.destroy()); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(pipe, () => { server.off('error', reject); resolve(); }); });
  return { server, close: () => new Promise(resolve => { server.close(resolve); for (const socket of sockets) socket.destroy(); }) };
}
export function callChannel(options, value, timeout = 5000) {
  checkChannel(options);
  const { pipe, key, service } = options;
  const nonce = randomBytes(24).toString('hex'), raw = JSON.stringify({ nonce, time: Date.now(), value });
  return new Promise((resolve, reject) => {
    if (Buffer.byteLength(raw) > 262144) return reject(unavailable());
    const req = request({ socketPath: pipe, method: 'POST', path: '/', agent: false,
      headers: { 'Content-Length': Buffer.byteLength(raw), 'x-service-mac': mac(key, `${service}:request:${raw}`) } }, async res => {
      try {
        const reply = await body(res);
        if (res.statusCode !== 200 || !equal(res.headers['x-service-mac'], mac(key, `${service}:response:${reply}`))) throw unavailable();
        const result = JSON.parse(reply);
        if (result.nonce !== nonce) throw unavailable();
        if (!result.ok) throw new AppError('SERVICE_REFUSED', [400,401,403,404,409,429,503].includes(result.status) ? result.status : 503, '请求无法完成');
        resolve(result.value);
      } catch (error) { reject(error); }
      finally { clearTimeout(timer); }
    });
    const timer = setTimeout(() => req.destroy(unavailable()), timeout);
    req.on('error', () => { clearTimeout(timer); reject(unavailable()); });
    req.end(raw);
  });
}
