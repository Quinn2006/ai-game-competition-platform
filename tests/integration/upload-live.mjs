// Manual browser acceptance with real PostgreSQL, ClamAV and local private files.
// Run against a disposable cluster created by scripts/local-identity-db.ps1.
// Never imported by the application and never exposes test-session HTTP routes.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { migrate } from '../../backend/src/platform/migrations.mjs';
import { createApp } from '../../backend/src/app.mjs';
import { createIdentityService } from '../../backend/src/modules/identity/service.mjs';
import { createLocalStorage } from '../../backend/src/platform/local-storage.mjs';
import { createScanner } from '../../backend/src/modules/uploads/scanner.mjs';
import { createUploadService } from '../../backend/src/modules/uploads/service.mjs';
import { createGameHttp } from '../../backend/src/modules/uploads/http.mjs';
import { createDiscoveryService } from '../../backend/src/modules/discovery/service.mjs';
import { createCommunityService } from '../../backend/src/modules/community/service.mjs';

const stateFile=process.argv[2];
const state=JSON.parse(await readFile(stateFile,'utf8'));
const url=new URL(state.databaseTest);
assert.equal(url.hostname,'127.0.0.1');assert.equal(url.pathname,'/ai_games_test');
const database=new pg.Pool({connectionString:url.href});
await migrate(database,'test','up');
const config={environment:'test',mainOrigin:'http://127.0.0.1:4360',gameOrigin:'http://127.0.0.2:4361',localGames:true,sessionSecret:state.sessionSecret};
const identity=createIdentityService({database,secret:config.sessionSecret,localAccounts:true,mail:async()=>{throw Error('Mail disabled');}});
const runId=randomUUID().slice(0,8),password='Synthetic-upload-acceptance-123';
for(const role of ['author','admin']){
  const email=`upload-${role}-${runId}@example.test`;
  await identity.run('register',{email,password},{requestId:randomUUID(),address:'upload-acceptance'});
  if(role==='admin')await database.query("UPDATE platform.accounts SET roles=ARRAY['admin'] WHERE email=$1",[email]);
  console.log(`${role}: ${email}`);
}
console.log('Synthetic fixture password: '+password);
const storage=createLocalStorage(join(dirname(stateFile),'submissions'),'test');
const scan=createScanner();
assert.equal((await scan(Buffer.from('Upload browser acceptance'))).status,'clean','Real ClamAV must be available');
const uploads=createUploadService({database,identity,storage,scan});
const games=createGameHttp({config,uploads,storage});
const app=createApp({config,database,identity,storage,games:games.main,log:()=>{},
  discovery:createDiscoveryService({database,identity,storage}),community:createCommunityService({database,identity,secret:config.sessionSecret})});
await new Promise(resolve=>games.game.listen(4361,'127.0.0.2',resolve));
await new Promise(resolve=>app.listen(4360,'127.0.0.1',resolve));
console.log('Browser acceptance ready: '+config.mainOrigin+'/studio');
let stopping=false;
async function stop(){if(stopping)return;stopping=true;app.closeAllConnections();games.game.closeAllConnections();await Promise.all([new Promise(resolve=>app.close(resolve)),new Promise(resolve=>games.game.close(resolve))]);await database.end();console.log('Acceptance HTTP servers and database pool closed');}
process.on('SIGINT',stop);process.on('SIGTERM',stop);
