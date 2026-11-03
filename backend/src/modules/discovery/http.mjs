import { readFile } from 'node:fs/promises';
import { createHmac, randomBytes } from 'node:crypto';
import { AppError } from '../../platform/errors.mjs';

const assets=new Map([['/',['discover.html','text/html']],['/discover',['discover.html','text/html']],['/work',['discover.html','text/html']],['/author',['discover.html','text/html']],['/team',['discover.html','text/html']],['/rankings',['discover.html','text/html']],['/catalog/edit',['discover.html','text/html']],['/catalog/admin',['discover.html','text/html']],['/catalog/ui.mjs',['discover.mjs','text/javascript']],['/catalog/style.css',['discover.css','text/css']],['/catalog/history.mjs',['search-history.mjs','text/javascript']]]);
export function createDiscoveryHttp({config,discovery,clock=()=>Date.now()}) {
  const buckets=new Map(),key=randomBytes(32);
  const fail=(code,status,message)=>{throw new AppError(code,status,message);};
  function limit(req) {
    const now=clock();for(const [id,b] of buckets)if(b.until<=now)buckets.delete(id);
    // No persistent IP or session identifiers. Bound both per-address traffic and global memory.
    const id=createHmac('sha256',key).update(req.socket.remoteAddress??'unknown').digest('hex');
    let b=buckets.get(id);if(!b){if(buckets.size>=10000)fail('SEARCH_BUSY',429,'搜索繁忙，请稍后再试');b={count:0,until:now+60000};buckets.set(id,b);}
    if(++b.count>20)fail('SEARCH_RATE_LIMIT',429,'搜索过于频繁，请稍后再试');
  }
  return async(req,res,requestId)=>{
    const url=new URL(req.url,config.mainOrigin),path=url.pathname;
    if(!assets.has(path)&&!path.startsWith('/api/discovery/'))return null;
    if(req.headers.host!==new URL(config.mainOrigin).host)fail('INVALID_HOST',403,'请求来源无效');
    if(assets.has(path)){
      if(!['GET','HEAD'].includes(req.method))fail('METHOD_NOT_ALLOWED',405,'不支持的请求方法');
      const [file,type]=assets.get(path);res.setHeader('Content-Type',type+'; charset=utf-8');
      res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
      res.setHeader('Referrer-Policy','no-referrer');
      return {route:path,data:req.method==='HEAD'?'':await readFile(new URL('../../../../frontend/'+file,import.meta.url))};
    }
    if(!discovery)fail('DISCOVERY_UNAVAILABLE',503,'作品服务尚未配置');
    if(discovery.ready&&!await discovery.ready())fail('DISCOVERY_UNAVAILABLE',503,'作品服务尚未准备就绪');
    const action=path.slice('/api/discovery/'.length),read=['list','detail','profile','hot','history','capabilities','draft','settings'].includes(action);
    if(!read&&!['record','clear','edit','admin'].includes(action))fail('NOT_FOUND',404,'接口不存在');
    if(req.method!==(read?'GET':'POST'))fail('METHOD_NOT_ALLOWED',405,'不支持的请求方法');
    const name=config.environment==='production'?'__Host-session':'session';
    const cookies=(req.headers.cookie??'').split(';').map(v=>v.trim()).filter(v=>v.startsWith(name+'='));
    const context={requestId,address:req.socket.remoteAddress,sessionToken:cookies.length===1?cookies[0].slice(name.length+1):undefined};
    let input=Object.fromEntries(url.searchParams);
    if(!read){
      if(req.headers.origin!==config.mainOrigin||(req.headers['sec-fetch-site']&&req.headers['sec-fetch-site']!=='same-origin'))fail('CSRF_REJECTED',403,'请从本站操作');
      if(req.headers['content-type']?.split(';')[0]!=='application/json')fail('CONTENT_TYPE',415,'需要 JSON');
      if(action==='record')limit(req);
      const parts=[];let size=0;for await(const part of req){size+=part.length;if(size>(action==='edit'?800000:100000))fail('BODY_TOO_LARGE',413,'内容过大');parts.push(part);}
      try{input=JSON.parse(Buffer.concat(parts).toString());if(!input||typeof input!=='object'||Array.isArray(input))throw Error();}catch{fail('INVALID_JSON',400,'内容无效');}
    }
    let result;
    if(action==='capabilities')result={duration:true,rankings:false,play:config.localGames===true};
    else if(action==='detail')result=await discovery.detail(input.id);
    else if(action==='profile')result=await discovery.profile(input.kind,input.id);
    else if(action==='history'||action==='clear')result=await discovery[action](context);
    else result=await discovery[action](input,context);
    return {route:'/api/discovery/'+action,data:JSON.stringify(result)};
  };
}
