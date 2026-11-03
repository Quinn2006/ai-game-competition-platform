import assert from 'node:assert/strict';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../backend/src/app.mjs';
import { migrate } from '../../backend/src/platform/migrations.mjs';
import { createIdentityService } from '../../backend/src/modules/identity/service.mjs';
import { newToken, digest } from '../../backend/src/modules/identity/crypto.mjs';
import { createUploadService } from '../../backend/src/modules/uploads/service.mjs';
import { createGameHttp } from '../../backend/src/modules/uploads/http.mjs';
import { createDiscoveryService } from '../../backend/src/modules/discovery/service.mjs';
import { createCommunityService } from '../../backend/src/modules/community/service.mjs';
import { zipFixture } from '../zip-fixture.mjs';

const url=new URL(process.env.DATABASE_URL??'http://invalid');
if(url.hostname!=='127.0.0.1'||url.pathname!=='/ai_games_test'||process.env.CONFIRM_DISPOSABLE_DATABASE!=='ai_games_test')throw Error('Fresh disposable local database required');
const db=new pg.Pool({connectionString:url.href});
const config={mainOrigin:'http://127.0.0.1:4341',gameOrigin:'http://127.0.0.2:4342',environment:'test',localGames:true,sessionSecret:'synthetic-phase5-flow-secret-32-characters',gameLoadTimeout:30000,uploadLimits:{compressed:100000000,expanded:300000000,files:500}};
const identity=createIdentityService({database:db,secret:config.sessionSecret,mail:async()=>{}});
const data=new Map();
const storage={health:async()=>true,async put(bucket,id,bytes){const key=bucket+'/'+id;if(data.has(key)&&!data.get(key).equals(bytes))throw Error('immutable storage');data.set(key,bytes);},async get(bucket,id){const bytes=data.get(bucket+'/'+id);if(!bytes)throw Error('missing object');return bytes;}};
const uploads=createUploadService({database:db,identity,storage,scan:async()=>({status:'clean',engine:'flow-test-double'}),limits:config.uploadLimits});
const games=createGameHttp({config,uploads,storage,limits:config.uploadLimits});
const app=createApp({config,database:db,storage,log:()=>{},identity,mailbox:[],games:games.main,discovery:createDiscoveryService({database:db,identity}),community:createCommunityService({database:db,identity,secret:config.sessionSecret})});
async function actor(admin=false){
 const id=randomUUID(),token=newToken();
 await db.query("INSERT INTO platform.accounts(id,status,nickname,roles,mfa_secret) VALUES($1,'active',$2,$3,$4)",[id,admin?'核查管理员':'创作玩家',admin?['admin']:[],admin?'synthetic-factor':null]);
 await db.query("INSERT INTO platform.sessions(token_hash,account_id,expires_at) VALUES($1,$2,CURRENT_TIMESTAMP+interval '1 hour')",[digest(token),id]);
 return {id,cookie:'session='+token};
}
async function request(path,{method='GET',body,cookie,origin=true}={}){
 const headers={...(cookie?{cookie}:{}),...(origin&&method!=='GET'?{origin:config.mainOrigin}:{}),...(body===undefined?{}:{'content-type':Buffer.isBuffer(body)?'application/zip':'application/json'})};
 const response=await fetch(config.mainOrigin+path,{method,headers,body:body===undefined?undefined:Buffer.isBuffer(body)?body:JSON.stringify(body)});
 const type=response.headers.get('content-type')??'';const value=type.includes('json')?await response.json():await response.text();
 return {status:response.status,value,headers:response.headers};
}
function ok(r){assert.equal(r.status,200,JSON.stringify(r.value));return r.value;}
try{
 assert.equal((await db.query("SELECT to_regnamespace('platform') AS name")).rows[0].name,null);
 await migrate(db,'test','up');
 const author=await actor(),admin=await actor(true),other=await actor();
 await new Promise(resolve=>app.listen(4341,'127.0.0.1',resolve));await new Promise(resolve=>games.game.listen(4342,'127.0.0.2',resolve));
 const work=ok(await request('/api/games/create',{method:'POST',cookie:author.cookie,body:{title:'联调游戏'}}));
 assert.equal((await request('/api/discovery/detail?id='+work.id)).status,404);
 const bytes=zipFixture([['index.html',`<!doctype html><html><h1>联调游戏</h1><button onclick="this.textContent='已交互'">点击试玩</button></html>`]]);
 const metadata={licensed:true,orientation:'landscape',saveVersion:'v1',domains:[]};
 const v=ok(await request('/api/games/upload?workId='+work.id+'&metadata='+encodeURIComponent(JSON.stringify(metadata)),{method:'POST',cookie:author.cookie,body:bytes}));
 assert.equal(v.scan,'clean');assert.equal((await request('/api/games/play?work='+work.id)).status,404);
 assert.equal((await request('/api/games/claim',{method:'POST',cookie:author.cookie,body:{workId:work.id,versionId:v.id}})).status,403);
 ok(await request('/api/games/claim',{method:'POST',cookie:admin.cookie,body:{workId:work.id,versionId:v.id}}));
 ok(await request('/api/games/decide',{method:'POST',cookie:admin.cookie,body:{workId:work.id,versionId:v.id,status:'approved',reason:'合成包检查',findingsReviewed:true}}));
 assert.equal((await request('/api/discovery/detail?id='+work.id)).status,404,'missing public profile must stay hidden');
 ok(await request('/api/discovery/edit',{method:'POST',cookie:author.cookie,body:{workId:work.id,title:'联调游戏',summary:'从上传到试玩',instructions:'点击按钮',category:'益智',tags:['联调'],cover:''}}));
 const publicWork=ok(await request('/api/discovery/detail?id='+work.id));assert.equal(publicWork.title,'联调游戏');
 assert.ok(ok(await request('/api/discovery/list?q=联调')).items.some(x=>x.id===work.id));
 assert.equal((await request('/api/discovery/edit',{method:'POST',cookie:other.cookie,body:{workId:work.id,title:'越权',summary:'不能改',instructions:'无',category:'益智',tags:[]}})).status,403);
 const ticket=ok(await request('/api/games/play?work='+work.id));assert.equal((await fetch(ticket.src)).status,200);
 const embedded=await request('/play?embed=1&work='+work.id);assert.equal(embedded.status,200);assert.match(embedded.headers.get('content-security-policy'),/frame-ancestors 'self'/);
 const guest=await request('/api/community/state?workId='+work.id),visitorCookie=guest.headers.get('set-cookie').split(';')[0];
 let session=ok(await request('/api/community/start',{method:'POST',cookie:visitorCookie,body:{workId:work.id}}));
 for(let n=1;n<=8;n++){await new Promise(resolve=>setTimeout(resolve,1850));const result=ok(await request('/api/community/signal',{method:'POST',cookie:visitorCookie,body:{token:session.token,sequence:n,kind:n===8?'end':'tick',foreground:true,interacted:true,healthy:true}}));if(n===8)assert.equal(result.counted,true);}
 assert.equal(Number(ok(await request('/api/community/state?workId='+work.id)).plays),1);
 ok(await request('/api/community/like',{method:'POST',cookie:author.cookie,body:{workId:work.id,active:true}}));
 ok(await request('/api/community/favorite',{method:'POST',cookie:author.cookie,body:{workId:work.id,active:true}}));
 ok(await request('/api/community/comment',{method:'POST',cookie:author.cookie,body:{workId:work.id,body:'完整链路评论'}}));
 assert.equal(Number(ok(await request('/api/community/state?workId='+work.id)).likes),1);
 assert.equal(ok(await request('/api/community/comments?workId='+work.id)).items[0].body,'完整链路评论');
 assert.equal(ok(await request('/api/community/favorites',{cookie:author.cookie})).items[0].id,work.id);
 assert.equal(ok(await request('/api/discovery/list?sort=duration')).items[0].id,work.id);
 const proof=newToken();await db.query("INSERT INTO platform.identity_tokens(token_hash,account_id,purpose,action,resource_id,session_hash,expires_at) VALUES($1,$2,'revalidate','admin.dangerous',$3,$4,CURRENT_TIMESTAMP+interval '5 minutes')",[digest(proof),admin.id,work.id,digest(admin.cookie.slice(8))]);
 ok(await request('/api/games/revoke',{method:'POST',cookie:admin.cookie,body:{workId:work.id,versionId:v.id,proof,confirmed:true,reason:'联调下架'}}));
 for(const path of ['/api/discovery/detail?id='+work.id,'/api/community/state?workId='+work.id,'/api/games/play?work='+work.id])assert.equal((await request(path)).status,404);
 assert.equal((await fetch(ticket.src)).status,404,'existing game ticket must become unreadable');
 console.log('PASS: HTTP upload → admin review → public profile/search → sandbox asset → guest valid play → like/favorite/comment/metric → revoke hides all');
}finally{
 await new Promise(resolve=>games.game.close(resolve));await new Promise(resolve=>app.close(resolve));await db.end();
}
