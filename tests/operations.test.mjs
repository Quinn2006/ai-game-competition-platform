import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {csv,excelXml,dateRange,textField} from '../src/modules/operations/policy.mjs';
import {createApp} from '../src/app.mjs';
test('operations export escapes formula injection, quotes and XML; dates reject malformed inputs',()=>{
 const rows=[{name:' =HYPERLINK("evil")'},{name:'<script>&'},{name:'中\n文'}];
 assert.match(csv(rows,['name']),/' =HYPERLINK\(""evil""\)/);assert.match(excelXml(rows,['name']),/&lt;script&gt;&amp;/);assert.doesNotMatch(excelXml(rows,['name']),/ss:Formula/);
 for(const from of ['bad','2026-02-30','2026-99-99'])assert.throws(()=>dateRange({from}),{code:'INVALID_DATE'});
 assert.throws(()=>dateRange({from:'2026-01-01',to:'2025-01-01'}));assert.throws(()=>textField('a'.repeat(101),100));
 assert.equal((dateRange({from:'2026-01-01',to:'2026-01-01'})[1]-dateRange({from:'2026-01-01',to:'2026-01-01'})[0])/86400000,1);
});
test('operations HTTP enforces origin, method, body and duplicate-cookie boundary',async t=>{
 const config={environment:'test',mainOrigin:'http://127.0.0.1:1'};let context;
 const app=createApp({config,log:()=>{},operations:{run:async(a,i,c)=>{context=c;return {ok:true};}}});app.listen(0,'127.0.0.1');await once(app,'listening');t.after(()=>app.close());config.mainOrigin='http://127.0.0.1:'+app.address().port;
 const request=(path,options={})=>fetch(config.mainOrigin+path,options);
 assert.equal((await request('/admin')).status,200);
 assert.equal((await request('/api/operations/batch',{method:'POST',headers:{origin:'https://evil.test','content-type':'application/json'},body:'{}'})).status,403);
 assert.equal((await request('/api/operations/batch')).status,405);
 assert.equal((await request('/api/operations/feedback',{method:'POST',headers:{origin:config.mainOrigin,'content-type':'application/json'},body:'[]'})).status,400);
 assert.equal((await request('/api/operations/notifications',{headers:{cookie:'session=a; session=b'}})).status,200);assert.equal(context.sessionToken,undefined);
 assert.equal((await request('/api/operations/nope')).status,404);
});
