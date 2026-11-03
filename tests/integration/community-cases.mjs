import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createCommunityService,deletionParticipant} from '../../backend/src/modules/community/service.mjs';
import {createIdentityService} from '../../backend/src/modules/identity/service.mjs';
import {newToken,digest} from '../../backend/src/modules/identity/crypto.mjs';
export async function communityCases(db){
 let now=Date.now();const identity=createIdentityService({database:db,secret:'test-community-identity-secret',mail:async()=>{},clock:()=>now});
 async function actor(admin=false){const id=randomUUID(),token=newToken();await db.query("INSERT INTO platform.accounts(id,status,nickname,roles,mfa_secret) VALUES($1,'active','测试玩家',$2,$3)",[id,admin?['admin']:[],admin?'test-factor':null]);await db.query("INSERT INTO platform.sessions(token_hash,account_id,expires_at,last_seen) VALUES($1,$2,$3,$4)",[digest(token),id,new Date(now+86400000),new Date(now)]);return {id,sessionToken:token,visitor:randomUUID(),requestId:randomUUID()};}
 const owner=await actor(),other=await actor(),admin=await actor(true),guest={visitor:randomUUID(),requestId:randomUUID()};
 const workId=randomUUID(),version=randomUUID();await db.query("INSERT INTO platform.works(id,owner_id,title) VALUES($1,$2,'社区测试作品')",[workId,owner.id]);
 await db.query("INSERT INTO platform.game_versions(id,work_id,status,digest,metadata,findings,scan_status) VALUES($1,$2,'approved','test','{}','[]','clean')",[version,workId]);await db.query('UPDATE platform.works SET published_version=$2 WHERE id=$1',[workId,version]);
 await db.query("INSERT INTO platform.work_profiles(work_id,title,summary,instructions,category) VALUES($1,'社区测试作品','玩家社区测试','点击游戏后退出','益智')",[workId]);
 const service=createCommunityService({database:db,identity,secret:'test-community-secret',clock:()=>now});const run=(a,i={},u=owner)=>service.run(a,{workId,...i},u);
 await assert.rejects(run('like',{active:true},guest),{code:'AUTH_REQUIRED'});
 await Promise.all(Array.from({length:12},()=>run('like',{active:true})));assert.equal(Number((await run('state')).likes),1);
 await run('like',{active:false});await run('like',{active:true});assert.equal(Number((await run('state')).likes),1);
 await run('favorite',{active:true});await run('favorite',{active:true});assert.equal((await run('favorites')).items.length,1);assert.equal((await run('favorites',{},other)).items.length,0);
 let parent=null;for(let j=0;j<10;j++)parent=(await run('comment',{body:'层级 '+j,parentId:parent})).id;
 await assert.rejects(run('comment',{body:'第11条'}),{code:'COMMENT_LIMIT'});now+=60001;const child=(await run('comment',{body:'深层回复',parentId:parent})).id;
 await assert.rejects(run('delete-comment',{id:child},other),{code:'FORBIDDEN'});await run('delete-comment',{id:parent},admin);assert.equal((await run('comments',{parentId:parent})).items[0].body,'深层回复');
 await run('words',{words:['禁词']},admin);await assert.rejects(run('comment',{body:'有禁词'}),{code:'COMMENT_FILTERED'});
 async function play(who,fail=false){const {token}=await run('start',{},who);for(let n=1;n<=7;n++){now+=2000;await run('signal',{token,sequence:n,kind:n===7?(fail?'error':'end'):'tick',foreground:true,healthy:true,interacted:true},who);}return token;}
 await play(guest,true);assert.equal(Number((await run('state')).plays),0);await play(guest);await play(guest);assert.equal(Number((await run('state')).plays),1);
 await play(owner);assert.equal(Number((await run('state')).plays),2);await run('merge',{}, {...owner,visitor:guest.visitor});assert.equal(Number((await run('state')).plays),1);
 const {token}=await run('start',{},other);await assert.rejects(run('signal',{token,sequence:1,kind:'tick',foreground:true,healthy:true,interacted:true},guest),{code:'INVALID_SESSION'});
 assert.equal((await run('signal',{token,sequence:9,kind:'tick',foreground:true,healthy:true,interacted:true},other)).rejected,true);
 await assert.rejects(run('risks',{},owner),{code:'FORBIDDEN'});assert.ok((await run('risks',{},admin)).items.length);
 await deletionParticipant.finalize(db,owner.id);assert.equal((await run('favorites')).items.length,0);
 now+=32*86400000;await service.cleanup();assert.equal((await db.query('SELECT count(*)::int AS n FROM platform.play_sessions')).rows[0].n,0);assert.equal(Number((await db.query('SELECT plays FROM platform.discovery_metrics WHERE work_id=$1',[workId])).rows[0].plays),1);
 console.log('PASS: community concurrency, rate limit, deep replies, moderation, favorites, timing, merge, replay, privacy and retention');return {workId};
}
