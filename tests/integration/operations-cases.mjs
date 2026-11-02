import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createOperationsService} from '../../src/modules/operations/service.mjs';
import {createIdentityService} from '../../src/modules/identity/service.mjs';
import {newToken,digest,hashPassword,seal,totp} from '../../src/modules/identity/crypto.mjs';
import {createApp} from '../../src/app.mjs';
import {once} from 'node:events';
export async function operationsCases(db){
 let now=Date.now();const secret='operations-integration-secret-32',password='Synthetic operations password 123',mfa=Buffer.alloc(20,7),adminId=randomUUID(),userId=randomUUID(),otherId=randomUUID(),adminToken=newToken(),userToken=newToken(),otherToken=newToken();
 await db.query("INSERT INTO platform.accounts(id,email,password_hash,status,nickname,roles,mfa_secret) VALUES($1,'operations-admin@example.test',$2,'active','管理员',ARRAY['admin'],$3)",[adminId,await hashPassword(password),seal(mfa,secret,adminId)]);
 for(const[id,token]of [[adminId,adminToken],[userId,userToken],[otherId,otherToken]]){if(id!==adminId)await db.query("INSERT INTO platform.accounts(id,email,status,nickname) VALUES($1,$2,'active','普通玩家')",[id,id+'@example.test']);await db.query("INSERT INTO platform.sessions(token_hash,account_id,expires_at) VALUES($1,$2,$3)",[digest(token),id,new Date(now+86400000)]);}
 const identity=createIdentityService({database:db,secret,mail:async()=>{},clock:()=>now}),context=t=>({sessionToken:t,requestId:randomUUID()}),ctx=context(adminToken),sent=[];let mailFails=true,providerInput;
 const service=createOperationsService({database:db,identity,siteOnly:false,clock:()=>now,contactEmail:'support@example.test',mail:async m=>{if(mailFails)throw Error('synthetic');sent.push(m);},ai:{privacy:{training:false,retentionDays:90},delete:async()=>{},answer:async input=>{providerInput=input;return '请在创作台上传';}}});
 const run=(a,i={},token=adminToken)=>service.run(a,i,context(token));
 async function proof(resourceId){now+=31000;return (await identity.run('revalidate',{resourceId,action:'admin.dangerous',password,code:totp(mfa,now),confirmed:true},ctx)).proof;}
 async function danger(a,i){const resourceId=i.resourceId||randomUUID();return run(a,{...i,resourceId,confirmed:true,proof:await proof(resourceId)});}
 await assert.rejects(run('dashboard',{},userToken),{code:'FORBIDDEN'});await assert.rejects(run('notifications',{},null),{code:'AUTHENTICATION_REQUIRED'});
 const id=randomUUID();await danger('announcement-save',{resourceId:id,title:'公告',body:'重要内容',importance:'urgent',publishAt:new Date(now+60000).toISOString()});assert.equal((await service.announcements()).items.length,0);now+=120000;await service.tick();await service.tick();assert.equal((await service.announcements()).items.length,1);
 assert.equal((await run('notifications',{},userToken)).items.length,1);assert.equal(sent.length,0);assert.ok(Number((await db.query('SELECT sum(attempts) AS n FROM platform.notification_mail')).rows[0].n)>0);
 mailFails=false;await db.query("UPDATE platform.notification_mail SET next_attempt=CURRENT_TIMESTAMP-interval '1 minute'");await service.tick();assert.ok(sent.length>=3);
 await danger('announcement-save',{resourceId:id,title:'修订',body:'修订内容',importance:'urgent'});await service.tick();assert.equal((await run('notifications',{},userToken)).items.length,1);
 await danger('announcement-save',{resourceId:id,title:'再次修订',body:'补发内容',importance:'urgent',resend:true});await service.tick();assert.equal((await run('notifications',{},userToken)).items.length,2);
 const note=(await run('notifications',{},userToken)).items[0];await run('read',{id:note.id},otherToken);assert.equal((await run('notifications',{},userToken)).items[0].read_at,null);await run('read',{id:note.id},userToken);assert.ok((await run('notifications',{},userToken)).items[0].read_at);
 await danger('announcement-action',{resourceId:id,operation:'withdraw'});assert.equal((await service.announcements()).items.length,0);
 const exp=randomUUID();await danger('announcement-save',{resourceId:exp,title:'限时',body:'限时内容',importance:'normal',expiresAt:new Date(now+120000).toISOString()});await service.tick();now+=130000;await service.tick();assert.equal((await service.announcements()).items.length,0);
 const fb=await run('feedback',{body:'反馈测试'},userToken);await run('feedback-reply',{id:fb.id,reply:'已处理'});assert.equal((await run('my-feedback',{},userToken)).items[0].reply,'已处理');await assert.rejects(run('feedback-reply',{id:fb.id,reply:'不允许'},userToken),{code:'FORBIDDEN'});
 assert.equal((await run('chat',{question:'如何上传？'},userToken)).available,true);assert.deepEqual(Object.keys(providerInput).sort(),['knowledge','question','requestId','signal']);
 const work=randomUUID(),version=randomUUID();await db.query("INSERT INTO platform.works(id,owner_id,title) VALUES($1,$2,'测试作品')",[work,userId]);await db.query("INSERT INTO platform.game_versions(id,work_id,status,digest,metadata,findings,scan_status) VALUES($1,$2,'approved','test','{}','[]','clean')",[version,work]);await db.query('UPDATE platform.works SET published_version=$2 WHERE id=$1',[work,version]);
 await assert.rejects(run('batch',{ids:[work],operation:'hide'}),{code:'CONFIRMATION_REQUIRED'});
 await danger('batch',{ids:[work],operation:'hide'});assert.equal((await db.query('SELECT published_version FROM platform.works WHERE id=$1',[work])).rows[0].published_version,null);await assert.rejects(db.query('UPDATE platform.works SET published_version=$2 WHERE id=$1',[work,version]),/hidden/);
 await danger('batch',{ids:[work],operation:'restore'});assert.equal((await db.query('SELECT published_version FROM platform.works WHERE id=$1',[work])).rows[0].published_version,version);
 await assert.rejects(danger('batch',{ids:[work,randomUUID()],operation:'hide'}),{code:'NOT_FOUND'});assert.equal((await db.query('SELECT published_version FROM platform.works WHERE id=$1',[work])).rows[0].published_version,version);
 const resourceId=randomUUID(),p=await proof(resourceId);await run('settings',{resourceId,proof:p,confirmed:true,days:90});await assert.rejects(run('settings',{resourceId,proof:p,confirmed:true,days:180}),{code:'FORBIDDEN'});
 await service.notifyBusiness({recipients:[userId],key:'result:1',title:'成绩',body:'档案',important:true,archive:true});await db.query("UPDATE platform.notifications SET created_at=CURRENT_TIMESTAMP-interval '181 days'");await service.tick();assert.equal((await run('notifications',{},userToken)).items.length,0);assert.equal((await db.query('SELECT count(*) FROM platform.notification_archives')).rows[0].count,'1');
 const report=await run('dashboard');assert.ok(report.days.length);for(const format of ['csv','xml']){const e=await run('export',{kind:'users',format});assert.ok(e.content);assert.doesNotMatch(e.content,/@example.test|password_hash|mfa_secret/);}
 const config={environment:'test',mainOrigin:'http://127.0.0.1:1'},app=createApp({config,database:db,identity,operations:service,log:()=>{}});app.listen(0,'127.0.0.1');await once(app,'listening');config.mainOrigin='http://127.0.0.1:'+app.address().port;
 try{const get=(action,token)=>fetch(config.mainOrigin+'/api/operations/'+action,{headers:token?{cookie:'session='+token}:{}});assert.equal((await get('dashboard',userToken)).status,403);assert.equal((await get('dashboard',adminToken)).status,200);assert.equal((await get('notifications')).status,401);assert.equal((await get('status')).status,200);assert.equal((await get('announcements')).status,200);}finally{await new Promise(resolve=>app.close(resolve));}
 await db.query("INSERT INTO platform.notifications(id,account_id,event_key,title,body) SELECT gen_random_uuid(),$1,'paging:'||n,'分页测试','历史' FROM generate_series(1,101) n",[userId]);
 assert.equal((await run('notifications',{},userToken)).nextOffset,100);assert.equal((await run('notifications',{offset:100},userToken)).items.length,1);
 await assert.rejects(run('notifications',{offset:-1},userToken),{code:'INVALID_OFFSET'});
 console.log('PASS: operations real PostgreSQL and MFA; authorization, scheduling, resend, mail retry, retention/archive, feedback, AI isolation, batch rollback, notification paging and export privacy');
 return {db,identity,service,adminToken,userToken};
}
