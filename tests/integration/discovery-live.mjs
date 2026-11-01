// Local acceptance harness: real database, scanner, identity, uploads and HTTP.
// Never imported by the application. Synthetic accounts only.
import pg from 'pg';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {createIdentityService} from '../../src/modules/identity/service.mjs';
import {totp,unseal} from '../../src/modules/identity/crypto.mjs';
import {createUploadService} from '../../src/modules/uploads/service.mjs';
import {createScanner} from '../../src/modules/uploads/scanner.mjs';
import {createLocalStorage} from '../../src/platform/local-storage.mjs';
import {createDiscoveryService} from '../../src/modules/discovery/service.mjs';
import {createGameHttp} from '../../src/modules/uploads/http.mjs';
import {createApp} from '../../src/app.mjs';
import {zipFixture} from '../zip-fixture.mjs';
const state=JSON.parse(await readFile(process.argv[2],'utf8'));
const dbUrl=new URL(state.database);assert.equal(dbUrl.hostname,'127.0.0.1');assert.equal(dbUrl.pathname,'/ai_games_test');
const database=new pg.Pool({connectionString:state.database});
const config={mainOrigin:'http://127.0.0.1:4344',gameOrigin:'http://127.0.0.2:4345',environment:'test',localGames:true};
const secret='synthetic-phase4-acceptance-key-at-least-32',mail=[];let now=Date.now();
const identity=createIdentityService({database,secret,mail:async m=>mail.push(m),clock:()=>now});
const context=token=>({sessionToken:token,requestId:randomUUID(),address:'phase4-test'});
const password='Synthetic phase four password 123';
async function account(){const email=randomUUID()+'@example.test';await identity.run('register',{email,password},context());await identity.run('verify',{token:mail.at(-1).token},context());return identity.run('login',{email,password},context());}
const owner=await account(),admin=await account();
await database.query("UPDATE platform.accounts SET roles=ARRAY['admin'] WHERE id=$1",[admin.user.id]);
await identity.run('mfa/setup',{password},context(admin.sessionToken));
const pending=(await database.query('SELECT mfa_pending FROM platform.accounts WHERE id=$1',[admin.user.id])).rows[0].mfa_pending;
const otp=unseal(pending,secret,admin.user.id);
await identity.run('mfa/enable',{code:totp(otp,now)},context(admin.sessionToken));now+=31000;
const signed=await identity.run('login',{email:admin.user.email,password,code:totp(otp,now)},context());
const storage=createLocalStorage('tmp/phase4-live-storage/'+randomUUID(),'test');
const uploads=createUploadService({database,identity,storage,scan:createScanner(),clock:()=>now});
const discovery=createDiscoveryService({database,identity});
const games=createGameHttp({config,uploads,storage});
const app=createApp({config,database,identity,discovery,storage,log:()=>{},games:async(req,res,id)=>{
  if(req.url==='/__test/author'||req.url==='/__test/admin'){
    assert.equal(req.socket.remoteAddress,'127.0.0.1');
    res.setHeader('Set-Cookie','session='+(req.url.endsWith('admin')?signed.sessionToken:owner.sessionToken)+'; Path=/; HttpOnly; SameSite=Strict');return {route:'test-session',data:'{}'};
  }
  if(req.url==='/__test/revoke'&&req.method==='POST'&&req.headers.origin===config.mainOrigin){
    now+=31000;const proof=(await identity.run('revalidate',{password,code:totp(otp,now),action:'admin.dangerous',resourceId:workId,confirmed:true},context(signed.sessionToken))).proof;
    await uploads.run('revoke',{workId,versionId,proof,confirmed:true,reason:'Acceptance revoke'},context(signed.sessionToken));
    await assert.rejects(discovery.detail(workId),{code:'NOT_FOUND'});
    await assert.rejects(uploads.published(workId),{code:'NOT_FOUND'});
    assert.equal((await fetch(ticket.src)).status,404);
    return {route:'test-revoke',data:'{}'};
  }
  return games.main(req,res,id);
}});
await new Promise(r=>app.listen(4344,'127.0.0.1',r));await new Promise(r=>games.game.listen(4345,'127.0.0.2',r));
async function request(path,input,token=owner.sessionToken,bytes){const response=await fetch(config.mainOrigin+path,{method:input||bytes?'POST':'GET',headers:{origin:config.mainOrigin,cookie:'session='+token,...(input||bytes?{'Content-Type':bytes?'application/zip':'application/json'}:{})},body:bytes??(input?JSON.stringify(input):undefined)});const data=await response.json();assert.equal(response.status,200,JSON.stringify(data));return data;}
const {id:workId}=await request('/api/games/create',{title:'联调小游戏'});
await request('/api/discovery/edit',{workId,title:'联调小游戏',summary:'上传审核后在详情中试玩。',instructions:'点击按钮保存进度。',category:'益智',tags:['联调']});
assert.equal((await request('/api/discovery/list?q=联调小游戏')).items.some(w=>w.id===workId),false);
const metadata={licensed:true,orientation:'landscape',saveVersion:'v1',domains:[]};
const zip=zipFixture([['index.html','<!doctype html><html lang="zh-CN"><h1>联调游戏</h1><button onclick="PlatformGame.save({score:42})">保存42</button></html>']]);
const {id:versionId,scan}=await request('/api/games/upload?workId='+workId+'&metadata='+encodeURIComponent(JSON.stringify(metadata)),null,owner.sessionToken,zip);assert.equal(scan,'clean');
await request('/api/games/claim',{workId,versionId},signed.sessionToken);
await request('/api/games/decide',{workId,versionId,status:'approved',reason:'Reviewed',findingsReviewed:true},signed.sessionToken);
assert.equal((await request('/api/discovery/list?q=联调小游戏')).items[0].id,workId);
const ticket=await request('/api/games/play?work='+workId);assert.equal((await fetch(ticket.src)).status,200);
await writeFile('tmp/phase4-live.json',JSON.stringify({workId,versionId}));
console.log('PASS real HTTP create/edit/upload/ClamAV/review/publish/search/game asset; browser ready: '+config.mainOrigin+'/work?id='+workId);
process.on('SIGINT',async()=>{app.close();app.closeAllConnections();games.game.close();games.game.closeAllConnections();await database.end();});
