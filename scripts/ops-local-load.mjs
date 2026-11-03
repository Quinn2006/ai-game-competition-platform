import { once } from 'node:events';
import { createApp } from '../backend/src/app.mjs';
import { loadConfig } from '../backend/src/config.mjs';
import { createPrivateStorage } from '../backend/src/platform/storage.mjs';
import { loadProbe } from './ops-probe.mjs';

const config = { ...loadConfig({ APP_ENV:'test' }) };
const app = createApp({ config, database:null, storage:createPrivateStorage(config), log:()=>{} });
app.listen(0,'127.0.0.1');
await once(app,'listening');
config.mainOrigin = `http://127.0.0.1:${app.address().port}`;
try {
  const base = `http://127.0.0.1:${app.address().port}`;
  for (const path of ['/health/live','/discover','/account']) {
    const report = await loadProbe(base + path);
    console.log(JSON.stringify({ path, scope:'local HTTP smoke; not business capacity acceptance', ...report }));
    if (report.errors) process.exitCode=1;
  }
} finally { await new Promise(resolve => { app.close(resolve); app.closeAllConnections(); }); }
