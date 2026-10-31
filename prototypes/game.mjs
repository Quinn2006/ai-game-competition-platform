const main = 'http://127.0.0.1:4310';
const session = location.hash.slice(1);
let seq = 0;
const send = type => parent.postMessage({v: 1, type, session, seq: seq++}, main);
const report = {};
for (const [key, read] of Object.entries({
  parentStorage: () => parent.localStorage.getItem('phase0-main-only'),
  parentCookie: () => parent.document.cookie,
  siblingStorage: () => parent.frames[location.hostname === '127.0.0.2' ? 1 : 0].localStorage.getItem('save'),
})) {
  try { read(); report[key] = 'UNEXPECTED_ACCESS'; } catch (e) { report[key] = e.name; }
}
report.ownCookie = document.cookie;
try {
  const old = JSON.parse(localStorage.getItem('save') || 'null');
  report.previousOwner = old?.owner ?? null;
  report.visits = (old?.visits ?? 0) + 1;
  localStorage.setItem('save', JSON.stringify({owner: location.origin, visits: report.visits}));
  report.saveOwner = JSON.parse(localStorage.getItem('save')).owner;
  document.querySelector('#save').textContent = `本地存档加载次数：${report.visits}`;
} catch (e) { report.storageError = e.name; }
try { await fetch(`${main}/private-api`, {credentials: 'include'}); report.fetch = 'UNEXPECTED_ACCESS'; }
catch (e) { report.fetch = e.name; }
try { await fetch('http://127.0.0.4:4313/blocked'); report.externalFetch = 'UNEXPECTED_ACCESS'; }
catch (e) { report.externalFetch = e.name; }
parent.postMessage({type: 'probe', session, report}, main);
send('ready');
parent.postMessage({v: 1, type: 'ready', session: 'wrong-session', seq: 999}, main);
parent.postMessage({v: 1, type: 'unknown', session, seq: 1000}, main);
setInterval(() => send('heartbeat'), 1000);
document.querySelector('#interact').addEventListener('click', e => { if (e.isTrusted) send('interaction'); });
