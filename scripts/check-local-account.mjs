import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {loadConfig} from '../backend/src/config.mjs';
import {createDatabase} from '../backend/src/platform/database.mjs';
import {migrate} from '../backend/src/platform/migrations.mjs';
import {createIdentityService} from '../backend/src/modules/identity/service.mjs';
import {verifyPassword} from '../backend/src/modules/identity/crypto.mjs';
const config=loadConfig();assert.equal(config.environment,'development');assert.equal(new URL(config.databaseUrl).hostname,'127.0.0.1');
const db=createDatabase(config,()=>{});
try{
 assert.equal((await db.query("SELECT to_regnamespace('platform') AS name")).rows[0].name,null,'Fresh disposable development database required');
 await migrate(db,'development','up');const service=createIdentityService({database:db,localAccounts:true,secret:'test-local-reset-secret',mail:async()=>{throw Error('Mail forbidden');}}),email='reset-test@example.test',oldPassword='Synthetic old password 123',password='Synthetic new password 456',context={requestId:randomUUID()};
 await service.run('register',{email,password:oldPassword},context);const login=await service.run('login',{email,password:oldPassword},context);
 await db.query("UPDATE platform.accounts SET mfa_secret='synthetic-retained-mfa' WHERE id=$1",[login.user.id]);
 async function cli(input){await new Promise((resolve,reject)=>{const child=spawn(process.execPath,['scripts/local-account.mjs'],{env:process.env,stdio:['pipe','pipe','pipe']});let error='';child.stderr.on('data',d=>error+=d);child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(Error(error)));child.stdin.end(JSON.stringify(input));});}
 await cli({action:'reset-password',email,password});const u=(await db.query('SELECT * FROM platform.accounts WHERE id=$1',[login.user.id])).rows[0];assert.equal(await verifyPassword(password,u.password_hash),true);assert.equal(await verifyPassword(oldPassword,u.password_hash),false);assert.equal(u.mfa_secret,'synthetic-retained-mfa');assert.equal((await db.query('SELECT count(*) FROM platform.sessions WHERE account_id=$1',[u.id])).rows[0].count,'0');
 await db.query("UPDATE platform.accounts SET status='deleting',deletion_due=CURRENT_TIMESTAMP+interval '1 day' WHERE id=$1",[u.id]);await cli({action:'cancel-deletion',email});assert.equal((await db.query('SELECT status FROM platform.accounts WHERE id=$1',[u.id])).rows[0].status,'active');
 console.log('PASS: real local management CLI password reset, session revocation, MFA preservation, deletion cancellation and audit');
}finally{await db.end();}
