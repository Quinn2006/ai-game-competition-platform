import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {get as httpGet} from 'node:http';
import {createApp} from '../src/app.mjs';
import {categories,profileOf,termOf,publicWork,createDiscoveryService} from '../src/modules/discovery/service.mjs';
import {recent,readHistory,saveHistory} from '../src/web/search-history.mjs';
test('discovery: editorial unicode bounds, raster-only covers and search normalization',()=>{
  const p={title:'名字',summary:'简介',instructions:'说明',category:categories[0],tags:['a']};
  assert.equal(profileOf({...p,title:'😀'.repeat(100)}).title.length,200);
  for(const bad of [{title:'a'.repeat(101)},{summary:''},{instructions:'a'.repeat(5001)},{category:'未知'},{tags:Array(11).fill('a')},{tags:['a'.repeat(31)]},{cover:'https://tracker.example/p.png'},{cover:'data:image/png;base64,YWJj'}])assert.throws(()=>profileOf({...p,...bad}));
  assert.equal(termOf('  ＡＢＣ   游戏  '),'abc 游戏');assert.throws(()=>termOf('a'.repeat(101)));
});
test('discovery: guest histories expire, deduplicate, bound to ten and tolerate denied storage',()=>{
  const now=Date.now(),map=new Map(),storage={getItem:k=>map.get(k),setItem:(k,v)=>map.set(k,v)};
  for(let i=0;i<15;i++)saveHistory(storage,'term'+i,now+i);
  saveHistory(storage,'term10',now+20);const rows=readHistory(storage,now+30);assert.equal(rows.length,10);assert.equal(rows[0].term,'term10');
  assert.deepEqual(recent([{term:'old',time:now-90*86400000},{term:'future',time:now+1}],now),[]);
  assert.deepEqual(readHistory({getItem(){throw Error();}}),[]);
});
test('discovery: public projection never leaks future or private columns',()=>{
  const p=publicWork({id:'id',tags:[],author_id:'author',author_name:'nick',likes:null,plays:null,email:'private',student_number:'private',metadata:{secret:true}});
  assert.equal(JSON.stringify(p).includes('private'),false);assert.deepEqual(Object.keys(p.author),['id','nickname']);assert.equal(p.likes,null);
});
test('discovery: parameterized five-field search, publication gates and stable paging',async()=>{
  const calls=[],database={async query(sql,args){calls.push({sql,args});return {rows:sql.includes('discovery_settings')?[{batch_size:12}]:[]};}};
  const s=createDiscoveryService({database});await s.list({q:"%_' OR 1=1",category:'益智'});
  const c=calls.at(-1);assert.equal(c.sql.includes("OR 1=1"),false);assert.equal((c.sql.match(/ILIKE/g)||[]).length,5);assert.match(c.sql,/v.id=w.published_version AND v.work_id=w.id/);assert.match(c.sql,/NOT v.revoked/);assert.match(c.sql,/NOT v.withdrawn/);assert.match(c.sql,/scan_status='clean'/);assert.equal(c.args[0],"%\\%\\_' or 1=1%");assert.deepEqual(c.args.slice(-2),[13,0]);
  await s.list({sort:'duration'});assert.match(calls.at(-1).sql,/NULLIF\(m.plays,0\)/);await assert.rejects(s.list({sort:'__proto__'}));await assert.rejects(s.list({offset:-1}));
});
test('discovery HTTP: pages, methods, origin/host checks, session scope and search flood limit',async t=>{
  const config={mainOrigin:'http://127.0.0.1',environment:'test'},seen=[];
  const app=createApp({config,log:()=>{},discovery:{list:async()=>({items:[]}),record:async()=>({ok:true}),history:async c=>{seen.push(c);return {terms:[]};}}});app.listen(0,'127.0.0.1');await once(app,'listening');config.mainOrigin=`http://127.0.0.1:${app.address().port}`;t.after(()=>new Promise(r=>{app.close(r);app.closeAllConnections();}));
  const get=(p,o)=>fetch(config.mainOrigin+p,o);
  assert.equal((await get('/')).status,200);assert.equal((await get('/api/discovery/list')).status,200);
  assert.equal((await get('/api/discovery/list',{method:'POST'})).status,405);
  const hostStatus=await new Promise((resolve,reject)=>httpGet(config.mainOrigin+'/api/discovery/list',{headers:{host:'evil.example'}},r=>{r.resume();resolve(r.statusCode);}).on('error',reject));assert.equal(hostStatus,403);
  assert.equal((await get('/api/discovery/record',{method:'POST'})).status,403);
  await get('/api/discovery/history?accountId=someone-else',{headers:{cookie:'session=mine'}});assert.equal(seen[0].sessionToken,'mine');assert.equal(seen[0].accountId,undefined);
  for(let i=0;i<21;i++){const r=await get('/api/discovery/record',{method:'POST',headers:{origin:config.mainOrigin,'Content-Type':'application/json'},body:'{"term":"test"}'});assert.equal(r.status,i<20?200:429);}
});
