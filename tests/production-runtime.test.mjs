import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { request } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { startServer } from '../backend/src/server.mjs';
import { loadConfig } from '../backend/src/config.mjs';
import { migrationFiles } from '../backend/src/platform/migrations.mjs';
import { zipFixture } from './zip-fixture.mjs';

function config() {
  return {...loadConfig({APP_ENV:'production',MAIN_ORIGIN:'https://main.example.com',GAME_ORIGIN:'https://game.example.net',
    DATABASE_URL:'postgres://app_production:synthetic@localhost/ai_games_production',SESSION_SECRET:'x'.repeat(32),
    PRIVATE_STORAGE_DRIVER:'local',PRIVATE_STORAGE_ROOT:'tmp/production-runtime',PRIVATE_STORAGE_ACCOUNT:'synthetic-service'}),
  port:0,gameListenOrigin:'http://127.0.0.2:0'};
}
function http(server,path,host,extra={}) {
  return new Promise((resolve,reject)=>{
    const req=request({host:server.address().address,port:server.address().port,path,...extra,headers:{Host:host,...extra.headers}},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks).toString()}));
    });req.on('error',reject);req.end(extra.body);
  });
}
async function fixture() {
  const migrations=await migrationFiles(),bytes=zipFixture([['index.html','<h1>Production fixture</h1>']]);
  const version={id:randomUUID(),work_id:randomUUID(),digest:createHash('sha256').update(bytes).digest('hex'),metadata:{domains:[]}};
  const state={ends:0,available:true,reads:[],environment:'production',storageReady:true,scannerReady:true};
  const database={async query(sql){
    if(['BEGIN','ROLLBACK','COMMIT'].includes(sql))return {rows:[]};
    if(sql.includes('public.schema_migrations'))return {rows:migrations};
    if(sql.includes('environment_identity'))return {rows:[{environment:state.environment}]};
    if(sql.includes('JOIN platform.game_versions'))return {rows:state.available?[version]:[]};
    if(sql.startsWith('INSERT INTO platform.audit_events'))return {rows:[]};
    throw Error('Unexpected fixture query');
  },async connect(){return {query:database.query,release(){}};},async end(){state.ends++;}};
  const storage={health:async()=>state.storageReady,get:async(area,id,expected)=>{state.reads.push({area,id,expected});return bytes;}};
  return {config:config(),log:()=>{},database,storage,scannerReady:async()=>state.scannerReady,state,version};
}

test('production assembly serves uploads and anonymous games with secure origins; revocation and stop close both listeners',async t=>{
  const f=await fixture(),runtime=await startServer(f);t.after(()=>runtime.stop());
  assert.equal((await http(runtime.app,'/health/ready','main.example.com')).status,200);
  assert.equal((await http(runtime.app,'/api/games/limits','main.example.com')).status,200);
  assert.equal((await http(runtime.app,'/api/games/list','main.example.com',{method:'POST',headers:{Origin:f.config.mainOrigin,'Content-Type':'application/json'},body:'{}'})).status,401);
  const ticket=JSON.parse((await http(runtime.app,'/api/games/play?work='+f.version.work_id,'main.example.com')).body);
  assert.ok(ticket.src.startsWith(f.config.gameOrigin));
  const path=new URL(ticket.src).pathname;
  const result=await http(runtime.games.game,path,'game.example.net');
  assert.equal(result.status,200);assert.match(result.body,/Production fixture/);
  assert.match(result.headers['content-security-policy'],/sandbox allow-scripts/);
  assert.deepEqual(f.state.reads,[{area:'release',id:f.version.id,expected:{digest:f.version.digest}}]);
  assert.equal((await http(runtime.games.game,path,'main.example.com')).status,403);
  f.state.available=false;assert.equal((await http(runtime.games.game,path,'game.example.net')).status,404);
  f.state.scannerReady=false;assert.equal((await http(runtime.app,'/health/ready','main.example.com')).status,503);
  f.state.scannerReady=true;f.state.storageReady=false;
  assert.equal((await http(runtime.app,'/health/ready','main.example.com')).status,503);
  f.state.storageReady=true;
  await new Promise(resolve=>runtime.games.game.close(resolve));
  assert.equal((await http(runtime.app,'/health/ready','main.example.com')).status,503);
  await Promise.all([runtime.stop(),runtime.stop()]);
  assert.equal(runtime.app.listening,false);assert.equal(runtime.games.game.listening,false);assert.equal(f.state.ends,1);
});

test('production refuses unready storage, scanner or wrong database environment before listening',async()=>{
  for(const change of [{storageReady:false},{scannerReady:false},{environment:'development'}]) {
    const f=await fixture();Object.assign(f.state,change);
    await assert.rejects(startServer(f),/dependencies not ready/);assert.equal(f.state.ends,1);
  }
});

test('shutdown drains an active HTTP request before closing the database',async t=>{
  const f=await fixture(),query=f.database.query;
  let entered,release;
  const active=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  f.database.query=async sql=>{if(sql.includes('JOIN platform.game_versions')){entered();await gate;}return query(sql);};
  const runtime=await startServer(f);t.after(()=>{release();return runtime.stop();});
  const response=http(runtime.app,'/api/games/play?work='+f.version.work_id,'main.example.com');
  await active;
  const stopped=runtime.stop();
  assert.equal(f.state.ends,0,'database remains available to in-flight work');
  release();assert.equal((await response).status,200);await stopped;
  assert.equal(f.state.ends,1);assert.equal(runtime.app.listening,false);
});

test('partial startup failure releases the game port and database pool',async t=>{
  const occupied=createServer();occupied.listen(0,'127.0.0.1');await once(occupied,'listening');
  t.after(()=>new Promise(resolve=>occupied.close(resolve)));
  const probe=createServer();probe.listen(0,'127.0.0.2');await once(probe,'listening');
  const gamePort=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const f=await fixture();f.config.port=occupied.address().port;f.config.gameListenOrigin=`http://127.0.0.2:${gamePort}`;
  await assert.rejects(startServer(f),{code:'EADDRINUSE'});assert.equal(f.state.ends,1);
  probe.listen(gamePort,'127.0.0.2');await once(probe,'listening');await new Promise(resolve=>probe.close(resolve));
  const f2=await fixture();f2.config.gameListenOrigin=`http://127.0.0.2:${gamePort}`;
  const occupiedGame=createServer();occupiedGame.listen(gamePort,'127.0.0.2');await once(occupiedGame,'listening');
  t.after(()=>new Promise(resolve=>occupiedGame.close(resolve)));
  await assert.rejects(startServer(f2),{code:'EADDRINUSE'});assert.equal(f2.state.ends,1);
});
