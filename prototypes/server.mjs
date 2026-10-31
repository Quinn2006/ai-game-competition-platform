import http from 'node:http';
import { readFile } from 'node:fs/promises';
const main = 'http://127.0.0.1:4310';
const games = ['http://127.0.0.2:4311', 'http://127.0.0.3:4312'];
const html = (body, script) => `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>阶段 0 隔离实验</title><link rel="stylesheet" href="/style.css"><body>${body}<script type="module" src="/${script}"></script></body></html>`;
for (const [index, origin] of [main, ...games].entries()) {
  const url = new URL(origin);
  const server = http.createServer(async (req, res) => {
    if (req.headers.host !== url.host) { res.writeHead(403).end(); return; }
    const isMain = index === 0;
    res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; worker-src 'none'; frame-src ${isMain ? games.join(' ') : "'none'"}; frame-ancestors ${isMain ? "'none'" : main}`);
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    if (isMain) res.setHeader('Set-Cookie', 'phase0_test_credential=synthetic-only; HttpOnly; SameSite=Strict; Path=/');
    const path = new URL(req.url, origin).pathname;
    if (path === '/') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(isMain ? html('<main><h1>阶段 0 · 隔离实验</h1><p>合成数据；浏览器验证原型，不连接正式服务。</p><button id="reload">重新加载作品（保留实验存档）</button><p id="status" role="status">正在验证</p><section id="frames"></section><pre id="report"></pre></main>', 'host.mjs') : html(`<main><h2>作品 ${index === 1 ? 'A' : 'B'}</h2><button id="interact">进行一次交互</button><p id="save"></p></main>`, 'game.mjs'));
    } else if (['/host.mjs', '/game.mjs', '/signals.mjs', '/style.css'].includes(path)) {
      res.setHeader('Content-Type', path.endsWith('.css') ? 'text/css' : 'text/javascript');
      try { res.end(await readFile(new URL(`.${path}`, import.meta.url))); } catch { res.writeHead(404).end(); }
    } else { res.writeHead(404).end(); }
  });
  server.listen(Number(url.port), url.hostname, () => console.log(`Prototype listening ${origin}`));
}
