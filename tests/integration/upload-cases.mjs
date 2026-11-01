import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createIdentityService } from '../../src/modules/identity/service.mjs';
import { newToken,digest } from '../../src/modules/identity/crypto.mjs';
import { createUploadService,deletionParticipant } from '../../src/modules/uploads/service.mjs';
import { zipFixture } from '../zip-fixture.mjs';
import { createLocalStorage } from '../../src/platform/local-storage.mjs';

export async function uploadCases(database){
  const storage=createLocalStorage('tmp/upload-tests/'+randomUUID(),'test');
  const identity=createIdentityService({database,secret:'synthetic-upload-test-key-32-characters',mail:async()=>{}});
  async function actor(admin=false){
    const id=randomUUID(),token=newToken();
    await database.query("INSERT INTO platform.accounts(id,status,roles,mfa_secret) VALUES ($1,'active',$2,$3)",[id,admin?['admin']:[],admin?'synthetic-test-factor':null]);
    await database.query("INSERT INTO platform.sessions(token_hash,account_id,expires_at) VALUES ($1,$2,CURRENT_TIMESTAMP+interval '1 hour')",[digest(token),id]);
    return {id,sessionToken:token,requestId:randomUUID()};
  }
  const owner=await actor(),other=await actor(),admin=await actor(true);let status='clean',scans=0;
  const service=createUploadService({database,identity,storage,scan:async()=>{scans++;return{status,engine:'test-double'};}});
  const run=(action,input,who=owner,bytes)=>service.run(action,input,who,bytes);
  const work=await run('create',{title:'Integration game'}),workId=work.id;
  const input={workId,licensed:true,orientation:'landscape',saveVersion:'v1',domains:[]};
  const bytes=zipFixture([['index.html','<p>Game</p>'],['game.js','eval("1")']]);
  await assert.rejects(run('detail',{workId},other),{code:'FORBIDDEN'});
  await assert.rejects(run('detail',{workId},{requestId:randomUUID()}),{code:'AUTHENTICATION_REQUIRED'});
  await assert.rejects(service.published(workId),{code:'NOT_FOUND'});
  await assert.rejects(run('upload',{...input,licensed:false},owner,bytes),{code:'LICENSE_REQUIRED'});
  await assert.rejects(run('upload',{...input,domains:['https://assets.example.com']},owner,bytes),{code:'NETWORK_REQUIRES_APPROVED_WORK'});
  const v1=await run('upload',input,owner,bytes);assert.equal(scans,3);assert.equal(v1.findings[0].kind,'dynamic-code');
  await assert.rejects(run('upload',input,owner,bytes),{code:'WITHDRAW_REQUIRED'});
  await assert.rejects(run('claim',{workId,versionId:v1.id}),{code:'FORBIDDEN'});
  await run('claim',{workId,versionId:v1.id},admin);
  await assert.rejects(run('decide',{workId,versionId:v1.id,status:'rejected'},admin),{code:'REASON_REQUIRED'});
  await assert.rejects(run('decide',{workId,versionId:v1.id,status:'approved',reason:'Checked'},admin),{code:'REVIEW_REQUIRED'});
  await run('decide',{workId,versionId:v1.id,status:'approved',reason:'Checked all findings',findingsReviewed:true},admin);
  assert.equal((await service.published(workId)).id,v1.id);
  await assert.rejects(database.query("UPDATE platform.game_versions SET metadata='{}' WHERE id=$1",[v1.id]),/immutable/);
  const v2=await run('upload',{...input,domains:['https://assets.example.com']},owner,bytes);
  assert.equal((await service.published(workId)).id,v1.id);
  await run('withdraw',{workId,versionId:v2.id});
  await assert.rejects(run('claim',{workId,versionId:v2.id},admin),{code:'INVALID_TRANSITION'});
  status='error';const v3=await run('upload',input,owner,bytes);assert.equal(v3.scan,'error');
  await assert.rejects(service.preview(owner,workId,v3.id),{code:'PREVIEW_UNAVAILABLE'});
  await assert.rejects(run('claim',{workId,versionId:v3.id},admin),{code:'INVALID_TRANSITION'});
  await run('withdraw',{workId,versionId:v3.id});
  status='infected';const v4=await run('upload',input,owner,bytes);assert.equal(v4.scan,'infected');await run('withdraw',{workId,versionId:v4.id});
  status='clean';const v5=await run('upload',input,owner,bytes);
  await run('claim',{workId,versionId:v5.id},admin);await run('decide',{workId,versionId:v5.id,status:'changes',reason:'Fix structure',category:'structure'},admin);
  const v6=await run('upload',input,owner,bytes);await run('claim',{workId,versionId:v6.id},admin);await run('decide',{workId,versionId:v6.id,status:'rejected',reason:'Unsafe content',category:'security'},admin);
  const v7=await run('upload',input,owner,bytes);await run('claim',{workId,versionId:v7.id},admin);await run('decide',{workId,versionId:v7.id,status:'approved',reason:'Fixed',findingsReviewed:true},admin);
  assert.equal((await service.published(workId)).id,v7.id);
  const rollback={workId,versionId:v1.id,confirmed:true,reason:'Restore stable version'};
  await assert.rejects(run('rollback',rollback,admin),{code:'FORBIDDEN'});
  async function proof(){const raw=newToken();await database.query("INSERT INTO platform.identity_tokens(token_hash,account_id,purpose,action,resource_id,session_hash,expires_at) VALUES ($1,$2,'revalidate','admin.dangerous',$3,$4,CURRENT_TIMESTAMP+interval '5 minutes')",[digest(raw),admin.id,workId,digest(admin.sessionToken)]);return raw;}
  rollback.proof=await proof();await run('rollback',rollback,admin);assert.equal((await service.published(workId)).id,v1.id);
  await assert.rejects(run('rollback',rollback,admin),{code:'FORBIDDEN'});
  await run('revoke',{...rollback,proof:await proof()},admin);await assert.rejects(service.published(workId),{code:'NOT_FOUND'});
  await assert.rejects(run('rollback',{...rollback,proof:await proof()},admin),{code:'INVALID_TRANSITION'});
  const closed=createUploadService({database,identity,storage,scan:async()=>({status:'clean'}),deadline:1000,clock:()=>1000});
  await assert.rejects(closed.run('upload',input,owner,bytes),{code:'SUBMISSION_CLOSED'});
  const rejected=await run('upload',input,owner,zipFixture([['index.html','x'],['../evil.js','x']]));assert.equal(rejected.rejected,true);
  const events=(await run('detail',{workId})).events;assert.ok(events.some(e=>e.action==='upload_rejected'));assert.ok(events.some(e=>e.action==='rollback'));
  await run('rollback',{...rollback,versionId:v7.id,proof:await proof()},admin);
  await deletionParticipant.finalize(database,owner.id);await assert.rejects(service.published(workId),{code:'NOT_FOUND'});
  assert.equal((await database.query('SELECT owner_id FROM platform.works WHERE id=$1',[workId])).rows[0].owner_id,null);
  console.log('PASS: phase 3 PostgreSQL ownership, scans, five states, immutable versions, withdrawals, rollback proofs, deadline, audit and deletion');
}
