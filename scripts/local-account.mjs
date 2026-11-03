import {randomUUID} from 'node:crypto';
import {createDatabase} from '../backend/src/platform/database.mjs';
import {loadConfig} from '../backend/src/config.mjs';
import {hashPassword} from '../backend/src/modules/identity/crypto.mjs';
const config=loadConfig(),url=new URL(config.databaseUrl);
if(config.environment!=='development'||!['127.0.0.1','localhost','::1','[::1]'].includes(url.hostname))throw Error('Local development database required');
let raw='';for await(const chunk of process.stdin){raw+=chunk;if(raw.length>4096)throw Error('Input too large');}
const input=JSON.parse(raw);raw='';
if(!['reset-password','cancel-deletion'].includes(input.action)||typeof input.email!=='string')throw Error('Invalid local account action');
if(input.action==='reset-password'&&(typeof input.password!=='string'||[...input.password].length<15||[...input.password].length>128))throw Error('Password must contain 15-128 characters');
const db=createDatabase(config,()=>{}),c=await db.connect();
try{await c.query('BEGIN');if((await c.query('SELECT environment FROM platform.environment_identity WHERE singleton')).rows[0]?.environment!=='development')throw Error('Wrong database environment');
 const u=(await c.query('SELECT id,status,deletion_due FROM platform.accounts WHERE email=$1 FOR UPDATE',[input.email.trim().toLowerCase()])).rows[0];
 if(!u)throw Error('Account not found');
 if(input.action==='reset-password'){
  if(!['active','pending'].includes(u.status))throw Error('Account is not active');
  const hash=await hashPassword(input.password);input.password='';await c.query("UPDATE platform.accounts SET password_hash=$2,status='active' WHERE id=$1",[u.id,hash]);
 }else{if(u.status!=='deleting'||+u.deletion_due<=Date.now())throw Error('Deletion cannot be cancelled');await c.query("UPDATE platform.accounts SET status='active',deletion_due=NULL WHERE id=$1",[u.id]);}
 await c.query('DELETE FROM platform.sessions WHERE account_id=$1',[u.id]);await c.query("DELETE FROM platform.identity_tokens WHERE account_id=$1 AND purpose<>'recovery'",[u.id]);
 await c.query('INSERT INTO platform.identity_events(id,actor_id,target_id,action,request_id,outcome) VALUES($1,NULL,$2,$3,$4,\'success\')',[randomUUID(),u.id,input.action==='reset-password'?'password_reset':'deletion_cancelled',randomUUID()]);
 await c.query('COMMIT');console.log('Local account updated. Sessions revoked; MFA unchanged.');
}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();await db.end();}
