import { acceptMessage } from './signals.mjs';
const origins = ['http://127.0.0.2:4311', 'http://127.0.0.3:4312'];
localStorage.setItem('phase0-main-only', 'synthetic-main-value');
const results = window.phase0 = { reports: {}, accepted: 0, rejected: 0, interactions: 0 };
const contexts = [];
function render() {
  document.querySelector('#report').textContent = JSON.stringify(results, null, 2);
  document.querySelector('#status').textContent = Object.keys(results.reports).length === 2 ? '检查已返回，详见结果' : '正在验证';
}
for (const [i, origin] of origins.entries()) {
  const frame = document.createElement('iframe');
  frame.title = `隔离作品 ${i === 0 ? 'A' : 'B'}`;
  frame.sandbox = 'allow-scripts allow-same-origin';
  const session = crypto.randomUUID();
  frame.src = `${origin}/#${session}`;
  document.querySelector('#frames').append(frame);
  contexts.push({ frame, origin, source: frame.contentWindow, session, seq: -1, lastAt: -Infinity, minIntervalMs: 50 });
}
window.addEventListener('message', event => {
  const ctx = contexts.find(c => c.source === event.source && c.origin === event.origin);
  // Probe-only diagnostics channel; never used to authorize or count a play.
  if (ctx && event.data?.type === 'probe' && event.data.session === ctx.session) {
    results.reports[ctx.origin] = event.data.report;
  } else if (ctx && acceptMessage(event, ctx, performance.now())) {
    results.accepted++;
    if (event.data.type === 'interaction') results.interactions++;
  } else results.rejected++;
  render();
});
document.querySelector('#reload').addEventListener('click', () => {
  results.reports = {};
  for (const ctx of contexts) {
    ctx.session = crypto.randomUUID(); ctx.seq = -1; ctx.lastAt = -Infinity;
    ctx.frame.src = `${ctx.origin}/?reload=${Date.now()}#${ctx.session}`;
  }
  render();
});
