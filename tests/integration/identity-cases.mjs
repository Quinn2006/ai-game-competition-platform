import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createIdentityService } from '../../src/modules/identity/service.mjs';
import { createApp } from '../../src/app.mjs';
import { loadConfig } from '../../src/config.mjs';
import { totp, unseal, digest } from '../../src/modules/identity/crypto.mjs';
import { cleanupAudit, placeAuditHold } from '../../src/modules/audit/retention.mjs';

export async function identityCases(database) {
  const mailbox=[], secret='synthetic-integration-key-32-characters';
  let now=Date.now();
  const identity=createIdentityService({database,secret,mail:async m=>mailbox.push(m),clock:()=>now});
  const context=sessionToken=>({requestId:randomUUID(),address:'synthetic-source',sessionToken});
  const run=(action,input={},sessionToken)=>identity.run(action,input,context(sessionToken));
  const password='Synthetic correct horse battery 123';
  async function register(email) {
    await run('register',{email,password});
    const message=mailbox.at(-1);
    await assert.rejects(run('login',{email,password}),{code:'LOGIN_FAILED'});
    await run('verify',{token:message.token});
    await assert.rejects(run('verify',{token:message.token}),{code:'INVALID_TOKEN'});
    return run('login',{email,password});
  }
  const first=await register('first@example.test');
  const second=await register('second@example.test');
  assert.notEqual(first.sessionToken,second.sessionToken);
  assert.equal((await database.query('SELECT count(*) FROM platform.sessions WHERE token_hash=$1',[first.sessionToken])).rows[0].count,'0');
  const updated=await run('profile',{nickname:'<script>private</script>',bio:'My bio'},first.sessionToken);
  assert.equal(updated.user.nickname,'<script>private</script>');
  await assert.rejects(run('profile',{nickname:'x',bio:'',roles:['admin']},first.sessionToken),{code:'INVALID_PROFILE'});
  assert.deepEqual(Object.keys(await identity.publicProfile(first.user.id)),['id','nickname','avatar','bio']);
  await assert.rejects(run('admin/profile',{resourceId:second.user.id,proof:'x'.repeat(43)},first.sessionToken),{code:'FORBIDDEN'});
  await run('forgot',{email:first.user.email});
  const reset=mailbox.at(-1).token;
  const resetResults=await Promise.allSettled([run('reset',{token:reset,password}),run('reset',{token:reset,password})]);
  assert.equal(resetResults.filter(x=>x.status==='fulfilled').length,1);
  await assert.rejects(run('me',{},first.sessionToken),{code:'AUTHENTICATION_REQUIRED'});
  const login=await run('login',{email:first.user.email,password});
  await run('delete',{password,confirmed:true},login.sessionToken);
  await assert.rejects(run('me',{},login.sessionToken),{code:'AUTHENTICATION_REQUIRED'});
  await assert.rejects(identity.publicProfile(first.user.id),{code:'NOT_FOUND'});
  const cancel=mailbox.at(-1).token;
  await run('cancel',{token:cancel});
  await assert.rejects(run('cancel',{token:cancel}),{code:'INVALID_TOKEN'});
  const again=await run('login',{email:first.user.email,password});
  await run('delete',{password,confirmed:true},again.sessionToken);
  const cancelledTooLate=mailbox.at(-1).token;
  now+=7*86400000;
  await assert.rejects(run('cancel',{token:cancelledTooLate}),{code:'INVALID_TOKEN'});
  assert.equal(await identity.cleanup(),1);
  assert.equal(await identity.cleanup(),0);
  const deleted=(await database.query('SELECT * FROM platform.accounts WHERE id=$1',[first.user.id])).rows[0];
  assert.equal(deleted.email,null);assert.equal(deleted.password_hash,null);assert.equal(deleted.nickname,'');
  assert.equal(deleted.status,'deleted');

  const admin=await register('admin@example.test');
  await database.query("UPDATE platform.accounts SET roles=ARRAY['admin'] WHERE id=$1",[admin.user.id]);
  await assert.rejects(run('profile',{nickname:'Admin',bio:''},admin.sessionToken),{code:'MFA_REQUIRED'});
  const adminLogin=await run('login',{email:admin.user.email,password});
  assert.equal(adminLogin.setupOnly,true);
  const setup=await run('mfa/setup',{password},adminLogin.sessionToken);
  assert.match(setup.secret,/^[A-Z2-7]+$/);
  const pending=(await database.query('SELECT mfa_pending FROM platform.accounts WHERE id=$1',[admin.user.id])).rows[0].mfa_pending;
  const otpSecret=unseal(pending,secret,admin.user.id);
  const enabled=await run('mfa/enable',{code:totp(otpSecret,now)},adminLogin.sessionToken);
  assert.equal(enabled.recovery.length,8);
  await assert.rejects(run('login',{email:admin.user.email,password,code:totp(otpSecret,now)}),{code:'LOGIN_FAILED'});
  now+=31000;
  const signed=await run('login',{email:admin.user.email,password,code:totp(otpSecret,now)});
  now+=31000;
  const revalidated=await run('revalidate',{password,code:totp(otpSecret,now),action:'admin.sensitive',resourceId:second.user.id},signed.sessionToken);
  await assert.rejects(run('admin/profile',{resourceId:admin.user.id,proof:revalidated.proof},signed.sessionToken),{code:'FORBIDDEN'});
  const result=await run('admin/profile',{resourceId:second.user.id,proof:revalidated.proof},signed.sessionToken);
  assert.equal(result.user.email,second.user.email);
  await assert.rejects(run('admin/profile',{resourceId:second.user.id,proof:revalidated.proof},signed.sessionToken),{code:'FORBIDDEN'});
  const recovered=await run('login',{email:admin.user.email,password,recovery:enabled.recovery[0]});
  await assert.rejects(run('login',{email:admin.user.email,password,recovery:enabled.recovery[0]}),{code:'LOGIN_FAILED'});
  const dangerous=await run('revalidate',{password,recovery:enabled.recovery[1],action:'admin.dangerous',resourceId:second.user.id,confirmed:true},recovered.sessionToken);
  await assert.rejects(run('admin/roles',{resourceId:second.user.id,proof:dangerous.proof,roles:['judge']},recovered.sessionToken),{code:'FORBIDDEN'});
  await run('admin/roles',{resourceId:second.user.id,proof:dangerous.proof,roles:['judge'],confirmed:true},recovered.sessionToken);
  assert.deepEqual((await database.query('SELECT roles FROM platform.accounts WHERE id=$1',[second.user.id])).rows[0].roles,['judge']);
  const expiryProof=await run('revalidate',{password,recovery:enabled.recovery[2],action:'admin.sensitive',resourceId:second.user.id},recovered.sessionToken);
  now+=300000;
  await assert.rejects(run('admin/profile',{resourceId:second.user.id,proof:expiryProof.proof},recovered.sessionToken),{code:'FORBIDDEN'});
  now+=15*60000;
  await assert.rejects(run('me',{},recovered.sessionToken),{code:'AUTHENTICATION_REQUIRED'});
  const failures=await database.query("SELECT count(*) FROM platform.identity_events WHERE outcome='failure'");
  assert.ok(Number(failures.rows[0].count)>=8);
  const throttled=await Promise.allSettled(Array.from({length:6},()=>identity.run('forgot',{email:'rate-limit@example.test'},
    {requestId:randomUUID(),address:'separate-source'})));
  assert.equal(throttled.filter(x=>x.status==='fulfilled').length,5);
  assert.equal(throttled.find(x=>x.status==='rejected').reason.code,'RATE_LIMITED');

  const retention=await database.connect();
  try {
    await retention.query('BEGIN');
    const id=randomUUID();
    await retention.query("INSERT INTO platform.identity_events (id,actor_id,action,request_id,outcome,occurred_at,expires_at) VALUES ($1,$2,'login',$3,'success',CURRENT_TIMESTAMP-interval '1 year',CURRENT_TIMESTAMP-interval '1 day')",[id,admin.user.id,randomUUID()]);
    const hold=await placeAuditHold(retention,{table:'identity_events',eventId:id,reason:'security_incident',approvedBy:admin.user.id,reviewAt:new Date(Date.now()-3600000)});
    await cleanupAudit(retention);
    assert.equal((await retention.query('SELECT id FROM platform.identity_events WHERE id=$1',[id])).rowCount,1);
    await retention.query('UPDATE platform.audit_holds SET released_at=CURRENT_TIMESTAMP WHERE id=$1',[hold]);
    await cleanupAudit(retention);
    assert.equal((await retention.query('SELECT id FROM platform.identity_events WHERE id=$1',[id])).rowCount,0);
  } finally {await retention.query('ROLLBACK');retention.release();}

  // Real HTTP contract with the same PostgreSQL-backed service.
  const logs=[],config={...loadConfig({APP_ENV:'test'}),mainOrigin:''};
  const app=createApp({config,database,identity,storage:{health:async()=>true},log:(_event,entry)=>logs.push(entry)});
  app.listen(0,'127.0.0.1');await once(app,'listening');
  config.mainOrigin=`http://127.0.0.1:${app.address().port}`;
  const request=(action,input,headers={})=>fetch(`${config.mainOrigin}/api/identity/${action}`,{method:'POST',headers:{'Content-Type':'application/json',Origin:config.mainOrigin,...headers},body:JSON.stringify(input)});
  try {
    assert.equal((await fetch(`${config.mainOrigin}/account`)).status,200);
    assert.equal((await request('login',{email:second.user.email,password},{Origin:'https://evil.test'})).status,403);
    const response=await request('login',{email:second.user.email,password});
    assert.equal(response.status,200);
    const data=await response.json();assert.equal(data.sessionToken,undefined);
    const setCookie=response.headers.get('set-cookie');assert.match(setCookie,/HttpOnly/);assert.match(setCookie,/SameSite=Strict/);
    const cookie=setCookie.split(';')[0];
    const me=await fetch(`${config.mainOrigin}/api/identity/me`,{headers:{Cookie:cookie}});assert.equal(me.status,200);
    assert.equal((await request('profile',{nickname:'HTTP user',bio:'safe'},{Cookie:cookie})).status,200);
    assert.equal((await request('profile',{nickname:'x',bio:'',ownerId:admin.user.id},{Cookie:cookie})).status,400);
    assert.equal((await request('logout',{}, {Cookie:cookie})).status,200);
    assert.equal((await fetch(`${config.mainOrigin}/api/identity/me`,{headers:{Cookie:cookie}})).status,401);
    assert.equal((await fetch(`${config.mainOrigin}/dev/mail`)).status,404);
    assert.equal(JSON.stringify(logs).includes(password),false);
    assert.equal(JSON.stringify(logs).includes(digest(cookie)),false);
  } finally {await new Promise(resolve=>{app.close(resolve);app.closeAllConnections();});}
}
