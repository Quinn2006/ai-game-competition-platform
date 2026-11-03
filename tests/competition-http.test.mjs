import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {request} from 'node:http';
import {createApp} from '../backend/src/app.mjs';
test('competition HTTP: public projection, method/Host/origin/size checks and session cookie ambiguity',async()=>{
 const seen=[],competition={publicList:async()=>({items:[]}),publicResults:async()=>({result:null}),run:async(a,i,c)=>{seen.push({a,i,c});return {ok:true};}};
 const config={mainOrigin:'http://127.0.0.1',environment:'test'},app=createApp({config,competition,log:()=>{}});app.listen(0,'127.0.0.1');await once(app,'listening');config.mainOrigin='http://127.0.0.1:'+app.address().port;
 const call=(path,options={})=>fetch(config.mainOrigin+path,options);
 try{
  assert.equal((await call('/competitions')).status,200);assert.deepEqual(await (await call('/api/competition/list')).json(),{items:[]});
  assert.equal((await call('/api/competition/register')).status,405);
  assert.equal(await new Promise((resolve,reject)=>{const req=request(config.mainOrigin+'/api/competition/list',{headers:{Host:'evil.example'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end();}),403);
  assert.equal((await call('/api/competition/register',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://evil.example'},body:'{}'})).status,403);
  assert.equal((await call('/api/competition/register',{method:'POST',headers:{'Content-Type':'application/json',Origin:config.mainOrigin},body:'x'.repeat(65537)})).status,413);
  const r=await call('/api/competition/register',{method:'POST',headers:{'Content-Type':'application/json',Origin:config.mainOrigin,Cookie:'session=one; session=two'},body:'{}'});assert.equal(r.status,200);assert.equal(seen.at(-1).c.sessionToken,undefined);
  assert.equal((await call('/api/competition/unknown')).status,404);
 }finally{app.close();app.closeAllConnections();await once(app,'close');}
});
