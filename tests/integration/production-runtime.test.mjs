import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import pg from 'pg';
import { loadConfig } from '../../backend/src/config.mjs';
import { startServer } from '../../backend/src/server.mjs';
import { migrate } from '../../backend/src/platform/migrations.mjs';
import { createProductionLocalStorageDriver } from '../../backend/src/platform/production-local-storage.mjs';
import { createPrivateStorage } from '../../backend/src/platform/storage.mjs';
import { newToken, digest } from '../../backend/src/modules/identity/crypto.mjs';
import { isolatedFixture } from '../isolation-fixture.mjs';
import { callChannel } from '../../backend/src/platform/service-channel.mjs';
import { readRuntimeConfig } from '../../backend/src/platform/isolated-runtime.mjs';
import { zipFixture } from '../zip-fixture.mjs';

// Only an empty disposable test database is accepted. Production environment
// identity is simulated there; this never provisions or migrates a production DB.
test('production runtime: real PostgreSQL, NTFS objects and ClamAV upload/review/play/revoke',{
  skip:!process.env.DATABASE_URL || process.env.CONFIRM_DISPOSABLE_DATABASE!=='ai_games_test',timeout:process.env.ISOLATION_BROWSER==='1'?600000:120000,
},async()=>{
  const url=new URL(process.env.DATABASE_URL);
  assert.equal(url.hostname,'127.0.0.1');assert.equal(url.pathname,'/ai_games_test');
  const database=new pg.Pool({connectionString:url.href,connectionTimeoutMillis:3000});
  const external=Boolean(process.env.ISOLATION_EXTERNAL_CONFIG);
  const root=external?resolve(process.env.ISOLATION_TEST_PRIVATE_ROOT):resolve('tmp','production-flow-'+randomUUID());await mkdir(root,{recursive:true});
  const sid=external?process.env.ISOLATION_TEST_SID:'S-1-5-21-1123157113-573781608-2536295357-1001';
  const config={...loadConfig({APP_ENV:'production',HOST:'127.0.0.1',MAIN_ORIGIN:'https://main.example.com',GAME_ORIGIN:'https://game.example.net',
    DATABASE_URL:'postgres://app_production:synthetic@localhost/ai_games_production',SESSION_SECRET:'synthetic-production-runtime-secret-32-characters',
    PRIVATE_STORAGE_DRIVER:'local',PRIVATE_STORAGE_ROOT:root,PRIVATE_STORAGE_ACCOUNT:sid,PRIVATE_STORAGE_TRUST_ROOT:root,
    CLAMD_PORT:process.env.CLAMD_PORT||'3310'}),port:0,gameListenOrigin:'http://127.0.0.2:0'};
  if(process.env.ISOLATION_BROWSER==='1')Object.assign(config,{port:4370,mainOrigin:'http://127.0.0.1:4370',gameOrigin:'http://127.0.0.2:4371',gameListenOrigin:'http://127.0.0.2:4371'});
  // The production filesystem driver is real; only ACL inspection is substituted.
  // This test is NOT evidence of service-account or NTFS permission isolation.
  const inspect=paths=>({identitySid:sid,accountSid:sid,results:paths.map(path=>({path,protected:true,owner:sid,
    aces:[sid,'S-1-5-18','S-1-5-32-544'].map(sid=>({sid,allow:true,inherited:false,rights:2032127}))}))});
  const storage=createPrivateStorage(config,createProductionLocalStorageDriver(config,external?{}:{aclProbe:{inspect,inspectAsync:async paths=>inspect(paths)}}));
  let runtime, startupAttempted=false;
  const call=(path,{body,cookie,game=false}={})=>new Promise((resolve,reject)=>{
    const server=game?(remoteGame??runtime.games.game):runtime.app;
    const bytes=body===undefined?undefined:Buffer.isBuffer(body)?body:Buffer.from(JSON.stringify(body));
    const headers={Host:new URL(game?config.gameOrigin:config.mainOrigin).host,...(cookie?{Cookie:cookie}:{}),
      ...(bytes?{Origin:config.mainOrigin,'Content-Type':Buffer.isBuffer(body)?'application/octet-stream':'application/json'}:{})};
    const req=request({host:server.address().address,port:server.address().port,path,method:bytes?'POST':'GET',headers},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>{
        const raw=Buffer.concat(chunks).toString();let value;try{value=JSON.parse(raw);}catch{value=raw;}
        resolve({status:res.statusCode,value,headers:res.headers});
      });
    });req.on('error',reject);req.end(bytes);
  });
  let separate, remoteGame;
  const isolated=process.env.ISOLATED_RUNTIME==='1';
  const ok=result=>{assert.equal(result.status,200,JSON.stringify(result.value));return result.value;};
  async function actor(admin=false){
    const id=randomUUID(),token=newToken();
    await database.query("INSERT INTO platform.accounts(id,status,nickname,roles,mfa_secret) VALUES($1,'active',$2,$3,$4)",[id,admin?'Fixture admin':'Fixture author',admin?['admin']:[],admin?'fixture-factor':null]);
    await database.query("INSERT INTO platform.sessions(token_hash,account_id,expires_at) VALUES($1,$2,CURRENT_TIMESTAMP+interval '1 hour')",[digest(token),id]);
    return {id,token,cookie:'__Host-session='+token};
  }
  try {
    assert.equal((await database.query("SELECT to_regnamespace('platform') AS name")).rows[0].name,null,'requires empty test DB');
    await migrate(database,'test','up');
    await database.query("UPDATE platform.environment_identity SET environment='production'");
    startupAttempted=true;
    if(external){
      separate={runtime:await readRuntimeConfig(process.env.ISOLATION_EXTERNAL_CONFIG,'main'),stop:async()=>{}};
      const validator=await callChannel(separate.runtime.validator,{action:'health'}),game=await callChannel(separate.runtime.control,{action:'health'});
      runtime=await startServer({config,database,storage,isolation:separate.runtime,log:()=>{}});
      remoteGame={address:()=>game.address};
      assert.notEqual(game.pid,process.pid);assert.notEqual(validator.pid,process.pid);assert.notEqual(game.pid,validator.pid);
      console.log('Dedicated-account PIDs main='+process.pid+' validator='+validator.pid+' game='+game.pid);
    }else if(isolated){
      separate=await isolatedFixture(root,config);
      const validator=await separate.launch('validator');
      assert.notEqual(validator.status.pid,process.pid);
      runtime=await startServer({config,database,storage,isolation:separate.runtime,log:()=>{}});
      const game=await separate.launch('game');
      assert.notEqual(game.status.pid,process.pid);assert.notEqual(game.status.pid,validator.status.pid);
      remoteGame={address:()=>game.status.address};
      console.log('Independent PIDs main='+process.pid+' validator='+validator.status.pid+' game='+game.status.pid);
    } else runtime=await startServer({config,database,storage,embeddedGames:true,log:()=>{}});
    assert.equal((await call('/health/ready')).status,200);
    assert.equal(ok(await call('/api/discovery/capabilities')).play,true);
    const author=await actor(),admin=await actor(true);
    const work=ok(await call('/api/games/create',{cookie:author.cookie,body:{title:'Production chain fixture'}}));
    assert.equal((await call('/api/games/list',{cookie:'session='+author.token,body:{}})).status,401,'development cookie is not accepted');
    ok(await call('/api/discovery/edit',{cookie:author.cookie,body:{workId:work.id,title:'Production chain fixture',summary:'Stored summary',instructions:'Click',category:'益智',tags:[],cover:''}}));
    const summaryDigest=createHash('sha256').update('Stored summary').digest('hex');
    assert.equal((await storage.get('review',`${work.id}-summary-${summaryDigest}`,{digest:summaryDigest})).toString(),'Stored summary');
    const bytes=zipFixture([['index.html','<h1>Production chain fixture</h1>'],['game.js','console.log("fixture")']]);
    const transfer=ok(await call('/api/games/upload-start',{cookie:author.cookie,body:{workId:work.id,size:bytes.length,licensed:true,orientation:'landscape',saveVersion:'v1',domains:[]}}));
    for(let offset=0;offset<bytes.length;offset+=100){
      ok(await call(`/api/games/upload-chunk?uploadId=${transfer.uploadId}&offset=${offset}`,{cookie:author.cookie,body:bytes.subarray(offset,offset+100)}));
    }
    const version=ok(await call('/api/games/upload-finish',{cookie:author.cookie,body:{uploadId:transfer.uploadId}}));
    assert.equal(version.scan,'clean');assert.equal((await call('/api/games/play?work='+work.id)).status,404);
    const preview=ok(await call('/api/games/preview',{cookie:author.cookie,body:{workId:work.id,versionId:version.id}}));
    assert.equal((await call(new URL(preview.src).pathname,{game:true})).status,200);
    ok(await call('/api/games/claim',{cookie:admin.cookie,body:{workId:work.id,versionId:version.id}}));
    // Replace both object and sidecar coherently: only the database digest can
    // detect this substitution before approval. Restore only this test fixture.
    const object=join(root,'production','review',version.id),meta=join(root,'production','review',`.${version.id}.meta`);
    const originalMeta=await readFile(meta),altered=zipFixture([['index.html','<h1>Substituted</h1>']]);
    await writeFile(object,altered);await writeFile(meta,JSON.stringify({...JSON.parse(originalMeta),size:altered.length,sha256:createHash('sha256').update(altered).digest('hex')}));
    const decision={cookie:admin.cookie,body:{workId:work.id,versionId:version.id,status:'approved',reason:'Fixture reviewed',findingsReviewed:true}};
    assert.equal((await call('/api/games/decide',decision)).status,500);
    assert.equal((await database.query('SELECT published_version FROM platform.works WHERE id=$1',[work.id])).rows[0].published_version,null);
    await writeFile(object,bytes);await writeFile(meta,originalMeta);
    ok(await call('/api/games/decide',decision));
    assert.equal(ok(await call('/api/discovery/detail?id='+work.id)).title,'Production chain fixture');
    const ticket=ok(await call('/api/games/play?work='+work.id));
    const path=new URL(ticket.src).pathname,result=await call(path,{game:true});
    assert.equal(result.status,200);assert.match(result.value,/Production chain fixture/);
    assert.equal((await call(path.replace('index.html','game.js'),{game:true})).value,'console.log("fixture")');
    if(isolated){
      const metadata=(await database.query('SELECT metadata FROM platform.game_versions WHERE id=$1',[version.id])).rows[0].metadata;
      const manifest=JSON.parse(await readFile(join(separate.runtime.servingRoot,version.id,metadata.serving.digest),'utf8'));
      const entry=manifest.files.find(file=>file.path==='game.js'),asset=join(separate.runtime.servingRoot,version.id,entry.digest),original=await readFile(asset);
      await writeFile(asset,Buffer.alloc(entry.size));
      assert.equal((await call(path.replace('index.html','game.js'),{game:true})).status,503,'no cache conceals resource tampering');
      await writeFile(asset,original);
      assert.equal((await call(path.replace('index.html','game.js'),{game:true})).status,200);
    }
    if(process.env.ISOLATION_BROWSER==='1'){
      await writeFile(resolve('tmp/isolation-browser.json'),JSON.stringify({url:config.mainOrigin+'/play?work='+work.id,game:ticket.src,root}));
      console.log('Browser fixture ready on loopback ports 4370/4371; waiting for fixture continue file');
      for(let i=0;i<540;i++){
        try{await readFile(join(root,'browser-continue'));break;}catch{}
        await new Promise(resolve=>setTimeout(resolve,1000));
      }
    }
    const proof=newToken();
    await database.query("INSERT INTO platform.identity_tokens(token_hash,account_id,purpose,action,resource_id,session_hash,expires_at) VALUES($1,$2,'revalidate','admin.dangerous',$3,$4,CURRENT_TIMESTAMP+interval '5 minutes')",[digest(proof),admin.id,work.id,digest(admin.token)]);
    ok(await call('/api/games/revoke',{cookie:admin.cookie,body:{workId:work.id,versionId:version.id,proof,confirmed:true,reason:'Fixture revocation'}}));
    assert.equal((await call(path,{game:true})).status,404);
    assert.equal((await call('/api/discovery/detail?id='+work.id)).status,404);
    // Revocation also covers the platform bridge, not only package resources.
    assert.equal((await call(path.replace('index.html','__platform_bridge.mjs'),{game:true})).status,404);
    if(isolated){
      // A previously issued author preview is rechecked after withdrawal.
      const next=ok(await call('/api/games/upload-start',{cookie:author.cookie,body:{workId:work.id,size:bytes.length,licensed:true,orientation:'landscape',saveVersion:'v2',domains:[]}}));
      ok(await call(`/api/games/upload-chunk?uploadId=${next.uploadId}&offset=0`,{cookie:author.cookie,body:bytes}));
      const pending=ok(await call('/api/games/upload-finish',{cookie:author.cookie,body:{uploadId:next.uploadId}}));
      const preview=ok(await call('/api/games/preview',{cookie:author.cookie,body:{workId:work.id,versionId:pending.id}}));
      assert.equal((await call(new URL(preview.src).pathname,{game:true})).status,200);
      ok(await call('/api/games/withdraw',{cookie:author.cookie,body:{workId:work.id,versionId:pending.id}}));
      assert.equal((await call(new URL(preview.src).pathname,{game:true})).status,409);
    }
    if(isolated){
      // Worker death does not terminate main; readiness becomes unavailable.
      const game=await callChannel(separate.runtime.control,{action:'health'});
      if(external){
        await writeFile(join(root,'fault-ready.json'),JSON.stringify({phase:'kill-game',gamePid:game.pid}));
        let acknowledged=false;
        for(let i=0;i<200;i++){try{await readFile(join(root,'fault-done'));acknowledged=true;break;}catch{}await new Promise(r=>setTimeout(r,100));}
        assert.equal(acknowledged,true,'privileged harness must terminate only its owned game job');
      }else process.kill(game.pid);
      for(let i=0;i<30;i++){try{await callChannel(separate.runtime.control,{action:'health'},100);}catch{break;}await new Promise(r=>setTimeout(r,50));}
      assert.equal((await call('/health/live')).status,200);
      assert.equal((await call('/health/ready')).status,503);
    }
    await runtime.stop();assert.equal(runtime.app.listening,false);
    if(!isolated)assert.equal(runtime.games.game.listening,false);
    await separate?.stop();
    console.log('PASS: production assembly with real PostgreSQL/storage/ClamAV; ACL probe and seeded sessions are test fixtures; no production DB or public deployment');
  } finally {await separate?.stop();if(runtime)await runtime.stop();else if(!startupAttempted)await database.end();}
});
