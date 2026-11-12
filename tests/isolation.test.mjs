import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHmac } from 'node:crypto';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { mkdir, writeFile, readFile, symlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { serveChannel, callChannel } from '../backend/src/platform/service-channel.mjs';
import { sha256, readBound, promoteResources } from '../backend/src/platform/serving-store.mjs';
import { resourcePermit } from '../backend/src/platform/isolated-runtime.mjs';
import { createGameListener } from '../backend/src/modules/uploads/game-listener.mjs';
import { startGameServer } from '../backend/src/game-server.mjs';

const channel=()=>({pipe:'\\\\.\\pipe\\agp-test-'+randomUUID(),key:randomBytes(32).toString('hex'),service:'auth'});
test('authenticated pipe binds both directions, rejects wrong identities, replays and missing service', {skip:process.platform!=='win32'},async t=>{
  const options=channel();let calls=0;
  const server=await serveChannel(options,async value=>{calls++;return value;});t.after(()=>server.close());
  assert.deepEqual(await callChannel(options,{ok:1}),{ok:1});
  await assert.rejects(callChannel({...options,key:randomBytes(32).toString('hex')},{ok:2}),{status:503});
  const raw=JSON.stringify({nonce:randomBytes(24).toString('hex'),time:Date.now(),value:'first'});
  const signature=createHmac('sha256',options.key).update('auth:request:'+raw).digest('hex');
  const send=()=>new Promise((resolve,reject)=>{
    const req=request({socketPath:options.pipe,path:'/',method:'POST',headers:{'x-service-mac':signature}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end(raw);
  });
  assert.equal(await send(),200);assert.equal(await send(),503);assert.equal(calls,2);
  await server.close();await assert.rejects(callChannel(options,{},100),{status:503});
});
test('derived resource manifest is bound to DB metadata; bytes, sidecar substitution and traversal fail closed',async()=>{
  const root=resolve('tmp','isolation-store-'+randomUUID()),stageRoot=join(root,'stage'),servingRoot=join(root,'serving'),id=randomUUID();
  await mkdir(join(stageRoot,id),{recursive:true});await mkdir(servingRoot);
  const bytes=Buffer.from('<h1>isolated</h1>'),digest=sha256(bytes),archive='a'.repeat(64);
  const manifest={archive,files:[{path:'index.html',digest,size:bytes.length}]};
  await writeFile(join(stageRoot,id,digest),bytes);
  const serving=await promoteResources({stageRoot,servingRoot,id,manifest,limits:{files:5,expanded:1000}});
  const runtime={servingRoot},version={id,digest:archive,metadata:{serving,domains:[]}};
  const permit=await resourcePermit(runtime,version,'index.html',{files:5,expanded:1000});
  assert.equal((await readBound(join(servingRoot,id),permit.entry.digest,permit.entry.digest,permit.entry.size)).toString(),bytes.toString());
  await assert.rejects(resourcePermit(runtime,version,'../private',{files:5,expanded:1000}),{status:404});
  await writeFile(join(servingRoot,id,digest),Buffer.alloc(bytes.length));
  await assert.rejects(readBound(join(servingRoot,id),digest,digest,bytes.length),{status:503});
  await writeFile(join(servingRoot,id,serving.digest),Buffer.alloc(serving.size));
  await assert.rejects(resourcePermit(runtime,version,'index.html',{files:5,expanded:1000}),{status:503});
  await assert.rejects(promoteResources({stageRoot,servingRoot,id,manifest,limits:{files:5,expanded:1000}}));
  await assert.rejects(readBound(servingRoot,'../private',digest,1),{status:503});
  const linked=join(root,'linked');await symlink(servingRoot,linked,'junction');
  await assert.rejects(readBound(join(linked,id),digest,digest,bytes.length));
});
test('game HTTP checks authorization for HEAD, bridge and every file, with bounded concurrent work',async t=>{
  let allowed=true,checks=0;
  const config={gameOrigin:'https://game.example.net',mainOrigin:'https://main.example.com'};
  const game=createGameListener({config,authorize:async()=>{checks++;if(!allowed)throw Error('closed');return {metadata:{domains:[]}};},readAsset:async()=>Buffer.from('<h1>game</h1>')});
  await new Promise(resolve=>game.listen(0,'127.0.0.2',resolve));t.after(()=>new Promise(resolve=>{game.close(resolve);game.closeAllConnections();}));
  const call=(file,method='GET',host='game.example.net')=>new Promise((resolve,reject)=>{
    const req=request({host:'127.0.0.2',port:game.address().port,path:'/g/'+'a'.repeat(64)+'/'+file,method,headers:{Host:host}},res=>{res.resume();res.on('end',()=>resolve(res));});req.on('error',reject);req.end();
  });
  for(const file of ['index.html','__platform_bridge.mjs'])for(const method of ['GET','HEAD'])assert.equal((await call(file,method)).statusCode,200);
  assert.equal(checks,4);allowed=false;assert.equal((await call('index.html')).statusCode,500);
  assert.equal((await call('index.html','GET','evil.example')).statusCode,403);
  const source=await readFile(new URL('../backend/src/game-server.mjs',import.meta.url),'utf8');
  assert.doesNotMatch(source,/loadConfig|createDatabase|inspectZip|SESSION_SECRET/);
});
test('independent game refuses when its authenticated authorization channel is lost', {skip:process.platform!=='win32'},async t=>{
  const auth=channel(),control={...channel(),service:'control'};
  const server=await serveChannel(auth,async()=>({metadata:{domains:[]}}));
  const runtime=await startGameServer({auth,control,mainOrigin:'https://main.example.com',gameOrigin:'https://game.example.net',gameListenOrigin:'http://127.0.0.2:0'});
  t.after(async()=>{await runtime.stop();await server.close();});
  const call=()=>new Promise((resolve,reject)=>{
    const req=request({host:'127.0.0.2',port:runtime.game.address().port,path:'/g/'+'a'.repeat(64)+'/__platform_bridge.mjs',headers:{Host:'game.example.net'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end();
  });
  assert.equal(await call(),200);await server.close();assert.equal(await call(),503);
});
test('game partial startup releases its HTTP port when the control pipe is occupied', {skip:process.platform!=='win32'},async t=>{
  const control={...channel(),service:'control'},occupied=await serveChannel(control,async()=>({}));t.after(()=>occupied.close());
  const probe=createServer();probe.listen(0,'127.0.0.2');await once(probe,'listening');
  const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  await assert.rejects(startGameServer({auth:channel(),control,mainOrigin:'https://main.example.com',gameOrigin:'https://game.example.net',gameListenOrigin:'http://127.0.0.2:'+port}));
  probe.listen(port,'127.0.0.2');await once(probe,'listening');await new Promise(resolve=>probe.close(resolve));
});
