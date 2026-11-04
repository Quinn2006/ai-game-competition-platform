import test from 'node:test';
import assert from 'node:assert/strict';
import {providerInput,publicProvider,publicIPv4,providerAnswer,providerRequest} from '../backend/src/modules/operations/ai-provider.mjs';
const input={endpoint:'https://api.example.test/v1',model:'test-model',apiKey:'synthetic-key',enabled:true};
test('AI config encrypts keys, preserves only for the same endpoint and exposes no secret',()=>{
 const config=providerInput(input,null,'test-secret');assert.equal(config.endpoint,'https://api.example.test/v1/chat/completions');
 assert.ok(config.key_cipher);assert.ok(!JSON.stringify(publicProvider(config)).includes('synthetic-key'));
 assert.equal(providerInput({...input,apiKey:''},config,'test-secret').key_cipher,config.key_cipher);
 assert.throws(()=>providerInput({...input,endpoint:'https://other.example.test/v1',apiKey:''},config,'test-secret'),{code:'API_KEY_REQUIRED'});
 for(const endpoint of ['http://example.test','https://127.0.0.1/v1','https://[::1]/v1','https://user:pass@example.test/v1','https://example.test/v1?key=x'])assert.throws(()=>providerInput({...input,endpoint},null,'test-secret'));
 for(const address of ['127.0.0.1','10.0.0.1','169.254.169.254','172.16.0.1','192.168.1.1','100.64.0.1','::1','224.0.0.1'])assert.equal(publicIPv4(address),false);
 assert.equal(publicIPv4('8.8.8.8'),true);
});
test('AI provider sends bounded stateless requests and validates responses',async()=>{
 const config=providerInput(input,null,'test-secret');
 assert.equal(await providerAnswer(config,'test-secret','如何上传？',async(endpoint,key,body,signal)=>{
  assert.equal(key,input.apiKey);assert.equal(body.model,input.model);assert.equal(body.store,false);assert.equal(body.stream,false);assert.equal(body.max_completion_tokens,1024);assert.equal(body.messages.length,2);assert.equal(body.messages[1].content,'如何上传？');assert.ok(signal);return {choices:[{message:{content:'请进入创作台。'}}]};
 }),'请进入创作台。');
 await assert.rejects(providerAnswer(config,'wrong-secret','question',async()=>{throw Error('must not reach transport');}));
 await assert.rejects(providerAnswer(config,'test-secret','question',async()=>({choices:[]})));
 await assert.rejects(providerRequest(input.endpoint,'key',{},AbortSignal.abort()),{name:'AbortError'});
 await assert.rejects(providerRequest('https://localhost/v1/chat/completions','key',{},AbortSignal.timeout(1000)),{code:'PRIVATE_API_ADDRESS'});
});
