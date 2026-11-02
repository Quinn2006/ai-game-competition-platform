import { readFile } from 'node:fs/promises';
import { fail } from './policy.mjs';
const assets=new Map(['/admin','/notifications','/announcements','/help','/feedback','/support','/status'].map(p=>[p,['operations.html','text/html']]));
assets.set('/operations/lifecycle.mjs',['support-lifecycle.mjs','text/javascript']);
assets.set('/operations/ui.mjs',['operations.mjs','text/javascript']);assets.set('/operations/style.css',['operations.css','text/css']);assets.set('/operations/banner.mjs',['announcement-banner.mjs','text/javascript']);
const reads=new Set(['chat-history','my-complaints','complaints','announcements','status','dashboard','users','works','todos','errors','audit','announcement-list','settings-read','notifications','my-feedback']);
const writes=new Set(['chat-delete','complaint','complaint-close','read','feedback','chat','export','batch','announcement-save','announcement-action','settings','sensitive-edit','feedback-reply']);
export function createOperationsHttp({config,operations}){return async(req,res,requestId)=>{
 const path=new URL(req.url,config.mainOrigin).pathname;
 if(!assets.has(path)&&!path.startsWith('/api/operations/'))return null;
 if(req.headers.host!==new URL(config.mainOrigin).host)fail('INVALID_HOST',403);
 if(assets.has(path)){
  if(!['GET','HEAD'].includes(req.method))fail('METHOD_NOT_ALLOWED',405);
  const [file,type]=assets.get(path);res.setHeader('Content-Type',type+'; charset=utf-8');res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  return {route:path,data:req.method==='HEAD'?'':await readFile(new URL('../../web/'+file,import.meta.url))};
 }
 const action=path.slice('/api/operations/'.length);if(!reads.has(action)&&!writes.has(action))fail('NOT_FOUND',404);
 if(req.method!==(reads.has(action)?'GET':'POST'))fail('METHOD_NOT_ALLOWED',405);
 if(!operations)fail('OPERATIONS_UNAVAILABLE',503,'运营服务尚未配置');
 const name=config.environment==='production'?'__Host-session':'session',cookies=(req.headers.cookie??'').split(';').map(s=>s.trim()).filter(s=>s.startsWith(name+'='));
 const context={requestId,address:req.socket.remoteAddress,sessionToken:cookies.length===1?cookies[0].slice(name.length+1):undefined};
 let input=Object.fromEntries(new URL(req.url,config.mainOrigin).searchParams);
 if(writes.has(action)){
  if(req.headers.origin!==config.mainOrigin||req.headers['sec-fetch-site']&&req.headers['sec-fetch-site']!=='same-origin')fail('CSRF_REJECTED',403);
  if(req.headers['content-type']?.split(';')[0]!=='application/json')fail('CONTENT_TYPE',415);
  const chunks=[];let size=0;for await(const part of req){size+=part.length;if(size>800000)fail('BODY_TOO_LARGE',413);chunks.push(part);}
  try{input=JSON.parse(Buffer.concat(chunks));if(!input||typeof input!=='object'||Array.isArray(input))throw Error();}catch{fail('INVALID_JSON');}
 }
 return {route:path,data:JSON.stringify(await operations.run(action,input,context))};
};}
