import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createIdentityService} from '../../backend/src/modules/identity/service.mjs';
import {createOperationsService} from '../../backend/src/modules/operations/service.mjs';
export async function localIdentityCases(db){
 const email='local-'+randomUUID()+'@example.test',password='测试密码六位';let sent=0;
 const service=createIdentityService({database:db,secret:'local-identity-test-key',localAccounts:true,mail:async()=>{sent++;throw Error('No email allowed');}});
 const ctx={requestId:randomUUID(),address:'local-policy-test'};
 for(const password of ['12345','长'.repeat(129)])await assert.rejects(service.run('register',{email,password},ctx),{code:'INVALID_PASSWORD'});
 await service.run('register',{email,password},ctx);const login=await service.run('login',{email,password},ctx);assert.equal(login.user.status,'active');assert.equal(sent,0);
 await service.run('register',{email:email.toUpperCase(),password:'another password 987654321'},ctx);assert.equal((await db.query('SELECT count(*) FROM platform.accounts WHERE email=$1',[email])).rows[0].count,'1');
 const stored=(await db.query('SELECT password_hash FROM platform.accounts WHERE email=$1',[email])).rows[0].password_hash;assert.notEqual(stored,password);assert.ok(stored);
 for(const action of ['verify','forgot','resend','reset','cancel'])await assert.rejects(service.run(action,{email,password,token:'invalid'},ctx),{code:'LOCAL_ACCOUNT_ONLY'});
 const operations=createOperationsService({database:db,identity:service,mail:async()=>{sent++;}});await operations.notifyBusiness({recipients:[login.user.id],key:'local-only',title:'重要通知',body:'仅站内',important:true});
 assert.equal((await db.query("SELECT count(*) FROM platform.notification_mail m JOIN platform.notifications n ON n.id=m.id WHERE n.account_id=$1",[login.user.id])).rows[0].count,'0');assert.equal((await operations.run('notifications',{}, {...ctx,sessionToken:login.sessionToken})).items.length,1);assert.equal(sent,0);
 console.log('PASS: local registration without mail, unique normalized account names, hashed passwords, retired mail routes and site-only important notifications');
}
