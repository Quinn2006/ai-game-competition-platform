import {readFile} from 'node:fs/promises';
import {AppError} from '../../platform/errors.mjs';
const read=new Set(['mine','admin','assignments','inspection']);
const write=new Set(['delete','create','register','invite-preview','join','invite','verify','submit','change','consent','decide','assign','assign-judge','score','unlock','invalidate','snapshot','publish','exclude','appeal','resolve-appeal','identities']);
const fail=(code,status)=>{throw new AppError(code,status,'请求未完成，请检查输入和登录状态');};
export function createCompetitionHttp({config,competition}){
 return async(req,res,requestId)=>{
  const url=new URL(req.url,config.mainOrigin),path=url.pathname;
  const assets={'/competitions':['competition.html','text/html'],'/competitions/ui.mjs':['competition.mjs','text/javascript'],'/competitions/style.css':['competition.css','text/css']};
  if(!assets[path]&&!path.startsWith('/api/competition/'))return null;
  if(req.headers.host!==new URL(config.mainOrigin).host)fail('INVALID_HOST',403);
  if(assets[path]){
   if(!['GET','HEAD'].includes(req.method))fail('METHOD_NOT_ALLOWED',405);
   const [file,type]=assets[path];res.setHeader('Content-Type',type+'; charset=utf-8');
   res.setHeader('Content-Security-Policy',`default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-src ${config.gameOrigin??"'none'"}; base-uri 'none'; frame-ancestors 'none'`);
   return {route:path,data:req.method==='HEAD'?'':await readFile(new URL('../../../../frontend/'+file,import.meta.url))};
  }
  if(!competition)fail('COMPETITION_UNAVAILABLE',503);
  const action=path.slice('/api/competition/'.length),publicRead=['list','results','global','awards'].includes(action);
  if(!read.has(action)&&!write.has(action)&&!publicRead)fail('NOT_FOUND',404);
  if(req.method!==(write.has(action)?'POST':'GET'))fail('METHOD_NOT_ALLOWED',405);
  let input=Object.fromEntries(url.searchParams);
  if(write.has(action)){
   if(req.headers.origin!==config.mainOrigin||(req.headers['sec-fetch-site']&&req.headers['sec-fetch-site']!=='same-origin'))fail('CSRF_REJECTED',403);
   if(req.headers['content-type']?.split(';')[0]!=='application/json')fail('CONTENT_TYPE',415);
   const chunks=[];let size=0;for await(const p of req){size+=p.length;if(size>65536)fail('BODY_TOO_LARGE',413);chunks.push(p);}
   try{input=JSON.parse(Buffer.concat(chunks));if(!input||typeof input!=='object'||Array.isArray(input))throw Error();}catch{fail('INVALID_JSON',400);}
  }
  const name=config.environment==='production'?'__Host-session':'session';
  const values=(req.headers.cookie??'').split(';').map(x=>x.trim()).filter(x=>x.startsWith(name+'='));
  const result=action==='global'?await competition.globalResults():action==='awards'?await competition.awards():action==='list'?await competition.publicList():action==='results'?await competition.publicResults(input.contestId):
   await competition.run(action,input,{requestId,sessionToken:values.length===1?values[0].slice(name.length+1):undefined});
  return {route:'/api/competition/'+action,data:JSON.stringify(result)};
 };
}
