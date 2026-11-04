import {request} from 'node:https';
import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import {seal,unseal} from '../identity/crypto.mjs';
import {fail,textField} from './policy.mjs';
const aad='support-provider-api-key';
export function providerInput(input,old,secret){
 if(typeof input.endpoint!=='string'||input.endpoint.length>2048)fail('INVALID_API_URL');
 if(!secret)fail('AI_CONFIG_UNAVAILABLE',503,'服务端尚未配置密钥加密功能');
 let url;try{url=new URL(input.endpoint);}catch{fail('INVALID_API_URL',400,'请填写完整的 HTTPS API 地址');}
 if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||isIP(url.hostname)||url.hostname.includes(':')||url.hostname==='localhost'||url.hostname.endsWith('.localhost'))fail('INVALID_API_URL',400,'仅支持公网 HTTPS API 地址，不接受内网、IP、查询参数或密码');
 url.pathname=url.pathname.replace(/\/+$/,'');if(!url.pathname.endsWith('/chat/completions'))url.pathname+='/chat/completions';
 const endpoint=url.href,model=textField(input.model,200);
 if(typeof input.enabled!=='boolean'||typeof input.apiKey!=='string'||input.apiKey.length>4096||/[\r\n]/.test(input.apiKey))fail('INVALID_AI_CONFIG');
 const key=input.apiKey.trim();
 if(!key&&(!old?.key_cipher||old.endpoint!==endpoint))fail('API_KEY_REQUIRED',400,'首次配置或更换 API 地址时，请重新填写密钥');
 return {endpoint,model,enabled:input.enabled,key_cipher:key?seal(Buffer.from(key),secret,aad):old.key_cipher};
}
export function publicProvider(row){return {endpoint:row.endpoint,model:row.model,enabled:row.enabled,hasKey:Boolean(row.key_cipher)};}
export function publicIPv4(address){
 if(isIP(address)!==4)return false;const [a,b]=address.split('.').map(Number);
 return !([0,10,127].includes(a)||a>=224||a===100&&b>=64&&b<=127||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&(b===0||b===168)||a===198&&(b===18||b===19||b===51)||a===203&&b===0);
}
// Resolve once, validate, and pin the socket to that address; never follow redirects with a key.
export async function providerRequest(endpoint,key,payload,signal){
 signal.throwIfAborted();
 const url=new URL(endpoint);let abort;
 const addresses=await Promise.race([lookup(url.hostname,{all:true,family:4}),new Promise((_,reject)=>{abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});})]).finally(()=>signal.removeEventListener('abort',abort));
 signal?.throwIfAborted();
 if(!addresses.length||addresses.some(r=>!publicIPv4(r.address)))fail('PRIVATE_API_ADDRESS',400,'API 地址必须解析到公网地址');
 return new Promise((resolve,reject)=>{
  const req=request(url,{method:'POST',signal,agent:false,lookup:(_host,options,callback)=>options.all?callback(null,[addresses[0]]):callback(null,addresses[0].address,4),headers:{'Content-Type':'application/json',Authorization:'Bearer '+key}},res=>{
   if(res.statusCode!==200){res.resume();reject(Error('API_HTTP_'+res.statusCode));return;}
   let size=0;const chunks=[];res.on('data',part=>{size+=part.length;if(size>131072){res.destroy(Error('API_RESPONSE_TOO_LARGE'));return;}chunks.push(part);});
   res.on('error',reject);res.on('end',()=>{try{resolve(JSON.parse(Buffer.concat(chunks)));}catch{reject(Error('API_RESPONSE_INVALID'));}});
  });req.on('error',reject);req.end(JSON.stringify(payload));
 });
}
export async function providerAnswer(config,secret,question,transport=providerRequest){
 const key=unseal(config.key_cipher,secret,aad).toString();
 const result=await transport(config.endpoint,key,{model:config.model,store:false,stream:false,max_completion_tokens:1024,messages:[{role:'system',content:'你是小游戏平台客服。只回答平台使用问题，不执行任何管理操作。已知帮助：在创作台上传拥有授权的 ZIP，扫描和审核通过后公开；比赛在比赛中心报名；账号问题通过反馈联系管理员。不知道的事项请建议联系管理员，不编造平台状态。'},{role:'user',content:question}]},AbortSignal.timeout(15000));
 return textField(result?.choices?.[0]?.message?.content,10000);
}
