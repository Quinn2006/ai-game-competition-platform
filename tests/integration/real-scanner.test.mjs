import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDatabase } from '../../backend/src/platform/database.mjs';
import { loadConfig } from '../../backend/src/config.mjs';
import { migrate } from '../../backend/src/platform/migrations.mjs';
import { createScanner } from '../../backend/src/modules/uploads/scanner.mjs';
import { createIdentityService } from '../../backend/src/modules/identity/service.mjs';
import { createUploadService } from '../../backend/src/modules/uploads/service.mjs';
import { createLocalStorage } from '../../backend/src/platform/local-storage.mjs';
import { totp,unseal } from '../../backend/src/modules/identity/crypto.mjs';
import { zipFixture } from '../zip-fixture.mjs';

test('real ClamAV + PostgreSQL: clean/EICAR, authenticated review, real MFA rollback and revoke',async()=>{
  const config=loadConfig();assert.equal(config.environment,'test');assert.equal(process.env.CONFIRM_DISPOSABLE_DATABASE,'ai_games_test');
  const database=createDatabase(config,()=>{}),scan=createScanner();
  try{
    await migrate(database,'test','up');
    assert.equal((await scan(Buffer.from('harmless text'))).status,'clean','Real scanner must be available; no skip/mock');
    // Standard non-executable EICAR test string, kept in memory and never written as an executable.
    const eicar=Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}'+ '$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*');
    assert.equal((await scan(eicar)).status,'infected');
    const infected=zipFixture([['index.html','<p>Test</p>'],['sample.txt',eicar]]);
    assert.equal((await scan(infected)).status,'infected');
    const secret='synthetic-real-scanner-test-key-32-characters',mail=[];let now=Date.now();
    const identity=createIdentityService({database,secret,mail:async m=>mail.push(m),clock:()=>now});
    const context=sessionToken=>({requestId:randomUUID(),sessionToken,address:'scanner-test'});
    const password='Synthetic scanner acceptance password 123';
    const auth=(action,input,token)=>identity.run(action,input,context(token));
    async function account(){const email=randomUUID()+'@example.test';await auth('register',{email,password});await auth('verify',{token:mail.at(-1).token});return auth('login',{email,password});}
    const author=await account(),admin=await account();
    await database.query("UPDATE platform.accounts SET roles=ARRAY['admin'] WHERE id=$1",[admin.user.id]);
    await auth('mfa/setup',{password},admin.sessionToken);
    const pending=(await database.query('SELECT mfa_pending FROM platform.accounts WHERE id=$1',[admin.user.id])).rows[0].mfa_pending;
    const otp=unseal(pending,secret,admin.user.id);await auth('mfa/enable',{code:totp(otp,now)},admin.sessionToken);
    now+=31000;const signed=await auth('login',{email:admin.user.email,password,code:totp(otp,now)});
    const service=createUploadService({database,identity,storage:createLocalStorage('tmp/real-scanner-tests/'+randomUUID(),'test'),scan,clock:()=>now});
    const run=(action,input,token=author.sessionToken,bytes)=>service.run(action,input,context(token),bytes);
    const {id:workId}=await run('create',{title:'Real scanner acceptance'});
    const input={workId,licensed:true,orientation:'landscape',saveVersion:'v1',domains:[]};
    const bad=await run('upload',input,author.sessionToken,infected);assert.equal(bad.scan,'infected');
    await assert.rejects(run('claim',{workId,versionId:bad.id},signed.sessionToken),{code:'INVALID_TRANSITION'});
    await run('withdraw',{workId,versionId:bad.id});
    async function publish(text){const v=await run('upload',input,author.sessionToken,zipFixture([['index.html',text]]));assert.equal(v.scan,'clean');await run('claim',{workId,versionId:v.id},signed.sessionToken);await run('decide',{workId,versionId:v.id,status:'approved',reason:'Checked real scanned assets',findingsReviewed:true},signed.sessionToken);return v;}
    const first=await publish('<p>Version one</p>'),second=await publish('<p>Version two</p>');assert.equal((await service.published(workId)).id,second.id);
    async function proof(){now+=31000;return (await auth('revalidate',{password,code:totp(otp,now),action:'admin.dangerous',resourceId:workId,confirmed:true},signed.sessionToken)).proof;}
    const request={workId,versionId:first.id,confirmed:true,reason:'Restore verified original',proof:await proof()};
    await run('rollback',request,signed.sessionToken);assert.equal((await service.published(workId)).id,first.id);
    await assert.rejects(run('rollback',request,signed.sessionToken),{code:'FORBIDDEN'});
    await run('revoke',{...request,proof:await proof()},signed.sessionToken);await assert.rejects(service.published(workId),{code:'NOT_FOUND'});
    console.log('PASS: real engine detected EICAR raw and ZIP; clean uploads, MFA-authorized review/rollback/revoke passed');
  }finally{await database.end();}
});
