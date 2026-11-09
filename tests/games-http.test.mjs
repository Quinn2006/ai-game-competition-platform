import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import { createHash,randomUUID } from 'node:crypto';
import { createApp } from '../backend/src/app.mjs';
import { createGameHttp } from '../backend/src/modules/uploads/http.mjs';
import { AppError } from '../backend/src/platform/errors.mjs';
import { createLocalStorage } from '../backend/src/platform/local-storage.mjs';
import { zipFixture } from './zip-fixture.mjs';
test('game HTTP enforces capabilities, Host, CSRF, published version checks, CSP, MIME, QR and integrity',async t=>{
  const bytes=zipFixture([['index.html','<h1>Fixture</h1>'],['game.js','console.log(1)']]);
  const version={id:randomUUID(),work_id:randomUUID(),title:'Game',digest:createHash('sha256').update(bytes).digest('hex'),metadata:{domains:[],saveVersion:'v1',orientation:'landscape'}};
  let available=true;
  const uploads={published:async()=>{if(!available)throw new AppError('NOT_FOUND',404,'Not found');return version;},run:async()=>{throw new AppError('AUTHENTICATION_REQUIRED',401,'Login required');}};
  const config={environment:'test',mainOrigin:'http://127.0.0.1:1',gameOrigin:'http://127.0.0.2:1'};
  const storage={health:async()=>true,get:async()=>bytes};
  const games=createGameHttp({config,uploads,storage});const app=createApp({config,storage,games:games.main,log:()=>{}});
  app.listen(0,'127.0.0.1');games.game.listen(0,'127.0.0.2');await Promise.all([once(app,'listening'),once(games.game,'listening')]);
  config.mainOrigin='http://127.0.0.1:'+app.address().port;config.gameOrigin='http://127.0.0.2:'+games.game.address().port;
  t.after(()=>{app.close();app.closeAllConnections();games.game.close();games.game.closeAllConnections();});
  const page=await fetch(config.mainOrigin+'/play');assert.equal(page.status,200);assert.match(page.headers.get('content-security-policy'),/frame-src http:\/\/127.0.0.2/);
  assert.deepEqual(await (await fetch(config.mainOrigin+'/api/games/limits')).json(),{compressed:100000000,expanded:300000000,files:500});
  assert.equal((await fetch(config.mainOrigin+'/api/games/limits',{method:'POST'})).status,405);
  const api=await fetch(config.mainOrigin+'/api/games/play?work='+version.work_id);const ticket=await api.json();
  const entry=await fetch(ticket.src);assert.equal(entry.status,200);assert.match(entry.headers.get('content-security-policy'),/sandbox allow-scripts;/);assert.ok(!entry.headers.get('content-security-policy').includes('allow-same-origin'));assert.match(await entry.text(),/__platform_bridge/);
  const script=await fetch(ticket.src.replace('index.html','game.js'));assert.match(script.headers.get('content-type'),/text\/javascript/);
  assert.equal((await fetch(config.gameOrigin+'/g/'+'0'.repeat(64)+'/index.html')).status,404);
  const hostStatus=await new Promise((resolve,reject)=>{const req=request(ticket.src,{headers:{Host:'attacker.test'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end();});
  assert.equal(hostStatus,403);
  assert.equal((await fetch(config.mainOrigin+'/api/games/list',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,403);
  assert.equal((await fetch(config.mainOrigin+'/api/games/list',{method:'POST',headers:{Origin:config.mainOrigin,'Content-Type':'application/json'},body:'{}'})).status,401);
  const qr=await fetch(config.mainOrigin+'/api/games/qr?work='+version.work_id);assert.equal(qr.status,200);assert.match(await qr.text(),/<svg/);
  available=false;assert.equal((await fetch(ticket.src)).status,404);
  available=true;version.digest='bad';assert.equal((await fetch(ticket.src)).status,503);
});
test('ZIP upload accepts a slow connection beyond ten seconds without losing bytes', {timeout:20000}, async t=>{
  const bytes=zipFixture([['index.html','<h1>Slow upload</h1>']]),calls=[];
  const config={environment:'test',mainOrigin:'http://127.0.0.1:1',gameOrigin:'http://127.0.0.2:1'};
  const uploads={async run(action,input,context,body){calls.push(action);if(action==='upload')assert.deepEqual(body,bytes);return {ok:true};}};
  const games=createGameHttp({config,uploads,storage:{}});
  const app=createApp({config,games:games.main,log:()=>{}});
  app.connectionsCheckingInterval=50;
  t.after(()=>{app.closeAllConnections();app.close();});
  app.listen(0,'127.0.0.1');await once(app,'listening');config.mainOrigin='http://127.0.0.1:'+app.address().port;
  const result=await new Promise((resolve,reject)=>{
    let timer;
    const req=request(config.mainOrigin+'/api/games/upload?workId='+randomUUID()+'&metadata=%7B%7D',{
      method:'POST',headers:{Origin:config.mainOrigin,'Content-Type':'application/zip','Content-Length':bytes.length},
    },res=>{const chunks=[];res.on('data',part=>chunks.push(part));res.on('end',()=>resolve({status:res.statusCode,body:Buffer.concat(chunks).toString()}));});
    req.on('error',reject);req.on('close',()=>clearTimeout(timer));
    req.write(bytes.subarray(0,20));timer=setTimeout(()=>req.end(bytes.subarray(20)),11000);
  });
  assert.equal(result.status,200,result.body);assert.deepEqual(calls,['detail','upload']);
});
test('local private storage refuses traversal/overwrite, supports idempotent retries and rejects production',async()=>{
  const storage=createLocalStorage('tmp/storage-tests/'+randomUUID(),'test');assert.equal(await storage.health(),true);
  await storage.put('quarantine','a',Buffer.from('first'));await storage.put('quarantine','a',Buffer.from('first'));
  await assert.rejects(storage.put('quarantine','a',Buffer.from('other')));assert.equal((await storage.get('quarantine','a')).toString(),'first');
  await assert.rejects(storage.get('release','../x'));assert.throws(()=>createLocalStorage('tmp/invalid','production'));
});
