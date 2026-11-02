import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createOperationsService} from '../../src/modules/operations/service.mjs';
import {createIdentityService} from '../../src/modules/identity/service.mjs';
import {newToken,digest} from '../../src/modules/identity/crypto.mjs';
import {competitionNotifier} from '../../src/modules/operations/competition-events.mjs';
import {competitionCases} from './competition-cases.mjs';
export async function supportLifecycleCases(db){
 const identity=createIdentityService({database:db,secret:'local-support-test-secret',mail:async()=>{}});
 async function actor(admin=false){const id=randomUUID(),token=newToken();await db.query("INSERT INTO platform.accounts(id,status,nickname,roles,mfa_secret) VALUES($1,'active','生命周期测试',$2,$3)",[id,admin?['admin']:[],admin?'fixture':null]);await db.query("INSERT INTO platform.sessions(token_hash,account_id,expires_at) VALUES($1,$2,CURRENT_TIMESTAMP+interval '1 hour')",[digest(token),id]);return {requestId:randomUUID(),sessionToken:token,id};}
 const user=await actor(),other=await actor(),admin=await actor(true);let failed=true;const deleted=[];
 const service=createOperationsService({database:db,identity,ai:{privacy:{training:false,retentionDays:90},answer:async()=> '仅公开帮助',delete:async({requestId})=>{if(failed)throw Error('synthetic provider offline');deleted.push(requestId);}}});
 assert.throws(()=>createOperationsService({database:db,identity,ai:{answer:async()=>''}}),/privacy contract/);
 const run=(a,i={},u=user)=>service.run(a,i,u),chat=await run('chat',{question:'测试对话'});
 await assert.rejects(run('complaint',{id:chat.id,reason:'投诉'},other),{code:'NOT_FOUND'});
 const complaint=await run('complaint',{id:chat.id,reason:'正式投诉测试'});
 await run('chat-delete');assert.equal((await run('chat-history')).items.length,0);assert.equal((await run('my-complaints')).items.length,1);
 await service.tick();assert.ok((await db.query('SELECT attempts FROM platform.support_deletions WHERE provider_key=$1',[chat.id])).rows[0].attempts>0);
 failed=false;await db.query('UPDATE platform.support_deletions SET next_attempt=CURRENT_TIMESTAMP');await service.tick();assert.ok(deleted.includes(chat.id));
 await assert.rejects(run('complaint-close',{id:complaint.id,resolution:'结案'},other),{code:'FORBIDDEN'});
 await run('complaint-close',{id:complaint.id,resolution:'已核实'},admin);await db.query("UPDATE platform.support_complaints SET closed_at=CURRENT_TIMESTAMP-interval '1 year 1 day' WHERE id=$1",[complaint.id]);await service.tick();assert.equal((await run('my-complaints')).items.length,0);
 const expired=await run('chat',{question:'到期测试'});await db.query("UPDATE platform.support_chats SET ended_at=CURRENT_TIMESTAMP-interval '91 days' WHERE id=$1",[expired.id]);await service.tick();assert.ok(deleted.includes(expired.id));
 let finish,entered;const started=new Promise(resolve=>entered=resolve);
 const delayed=createOperationsService({database:db,identity,ai:{privacy:{training:false,retentionDays:90},answer:async()=>{entered();return new Promise(resolve=>finish=resolve);},delete:async()=>{}}});
 const request=delayed.run('chat',{question:'发送中删除测试'},user);await started;await run('chat-delete');finish('不应重新保存的回答');const erased=await request;
 assert.equal(erased.answer,'对话已被清空。');assert.equal((await db.query('SELECT count(*) FROM platform.support_chats WHERE id=$1',[erased.id])).rows[0].count,'0');assert.ok((await db.query('SELECT provider_key FROM platform.support_deletions WHERE provider_key=$1',[erased.id])).rowCount);
 const result=await competitionCases(db,competitionNotifier(service));
 const archive=(await db.query('SELECT * FROM platform.notification_archives WHERE contest_id=$1',[result.contestId])).rows;assert.ok(archive.length>0);assert.ok(archive.some(r=>r.title==='比赛成绩已发布'));assert.ok(archive.every(r=>!r.body.includes('学号')));
 const counts=await run('dashboard',{},admin);assert.ok(Number(counts.totals.competitions)>0);assert.ok(Object.hasOwn((await run('todos',{},admin)).competition,'appeals'));
 // Idempotent delivery and atomic rollback: no notification may survive an aborted event transaction.
 const c=await db.connect();const event={id:randomUUID(),contest:result.contestId,action:'publish'};
 try{await c.query('BEGIN');await competitionNotifier(service)(c,event);await c.query('ROLLBACK');assert.equal((await db.query('SELECT count(*) FROM platform.notifications WHERE event_key=$1',['contest-event:'+event.id])).rows[0].count,'0');}finally{c.release();}
 console.log('PASS: local privacy lifecycle, complaint isolation/one-year expiry, 90-day and requested erasure, provider deletion retry; phase6/7 notifications, archives, dashboard and atomic rollback');
}
