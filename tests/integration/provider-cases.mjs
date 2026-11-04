import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createIdentityService} from '../../backend/src/modules/identity/service.mjs';
import {createOperationsService} from '../../backend/src/modules/operations/service.mjs';
import {digest,newToken} from '../../backend/src/modules/identity/crypto.mjs';
export async function providerCases(db){
 const identity=createIdentityService({database:db,secret:'provider-test-secret',localAccounts:true});
 async function actor(admin){const id=randomUUID(),sessionToken=newToken();await db.query("INSERT INTO platform.accounts(id,status,roles,mfa_secret) VALUES($1,'active',$2,$3)",[id,admin?['admin']:[],admin?'fixture':null]);await db.query("INSERT INTO platform.sessions(token_hash,account_id,expires_at) VALUES($1,$2,CURRENT_TIMESTAMP+interval '1 hour')",[digest(sessionToken),id]);return {id,sessionToken,requestId:randomUUID()};}
 const admin=await actor(true),user=await actor(false);let calls=0,failTransport=false;
 const service=createOperationsService({database:db,identity,apiSecret:'provider-test-secret',aiTransport:async(_url,key,body)=>{calls++;assert.equal(key,'synthetic-provider-key');assert.equal(body.store,false);if(failTransport)throw Error('private upstream detail '+key);return {choices:[{message:{content:'客服连接成功'}}]};}});
 const resourceId=randomUUID(),config={endpoint:'https://api.example.test/v1',model:'fixture',apiKey:'synthetic-provider-key',enabled:true,resourceId};
 async function proof(who=admin){const token=newToken();await db.query("INSERT INTO platform.identity_tokens(token_hash,account_id,purpose,action,resource_id,session_hash,expires_at) VALUES($1,$2,'revalidate','admin.dangerous',$3,$4,CURRENT_TIMESTAMP+interval '5 minutes')",[digest(token),who.id,resourceId,digest(who.sessionToken)]);return {proof:token,confirmed:true};}
 await assert.rejects(service.run('ai-config',{},user),{code:'FORBIDDEN'});
 await assert.rejects(service.run('ai-save',config,admin),{code:'CONFIRMATION_REQUIRED'});
 await assert.rejects(service.run('ai-test',{...config,...await proof(user)},user),{code:'FORBIDDEN'});
 await service.run('ai-test',{...config,...await proof()},admin);
 assert.equal((await service.run('ai-config',{},admin)).hasKey,false,'testing must not save');
 const savedProof=await proof();await service.run('ai-save',{...config,...savedProof},admin);
 await assert.rejects(service.run('ai-save',{...config,...savedProof},admin),{code:'FORBIDDEN'});
 const publicConfig=await service.run('ai-config',{},admin);assert.equal(publicConfig.hasKey,true);assert.equal(publicConfig.enabled,true);assert.ok(!JSON.stringify(publicConfig).includes(config.apiKey));
 const stored=(await db.query('SELECT key_cipher FROM platform.support_provider WHERE id')).rows[0].key_cipher;assert.notEqual(stored,config.apiKey);
 const chat=await service.run('chat',{question:'怎么上传？'},user);assert.equal(chat.answer,'客服连接成功');assert.equal(chat.available,true);
 assert.equal((await db.query('SELECT provider_key FROM platform.support_chats WHERE id=$1',[chat.id])).rows[0].provider_key,null,'stateless API has no deletable remote object');
 failTransport=true;await assert.rejects(service.run('ai-test',{...config,apiKey:'',...await proof()},admin),e=>e.code==='AI_TEST_FAILED'&&!e.message.includes(config.apiKey));
 await service.run('ai-save',{...config,apiKey:'',enabled:false,...await proof()},admin);const before=calls;
 assert.equal((await service.run('chat',{question:'关闭后'},user)).available,false);assert.equal(calls,before);
 assert.ok(!(await db.query("SELECT detail::text FROM platform.operations_events WHERE action='ai_provider_updated'")).rows.some(r=>r.detail.includes(config.apiKey)));
 console.log('PASS: encrypted provider settings, admin proof, stateless chat, no-save test, disable and sanitized failures');
}
