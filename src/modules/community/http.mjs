import { randomBytes,createHmac,timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { AppError } from '../../platform/errors.mjs';
const fail=(code,status=400)=>{throw new AppError(code,status,'操作未完成，请检查登录状态或稍后重试');};
const read=new Set(['state','comments','favorites','risks']);
const actions=new Set([...read,'like','favorite','comment','delete-comment','start','signal','merge','words','resolve','hold']);
export function createCommunityHttp({config,community}){
  const key=config.sessionSecret??randomBytes(32),buckets=new Map();
  const sign=id=>createHmac('sha256',key).update('visitor:'+id).digest('hex');
  const cookie=(req,name)=>{const values=(req.headers.cookie??'').split(';').map(x=>x.trim()).filter(x=>x.startsWith(name+'='));return values.length===1?values[0].slice(name.length+1):undefined;};
  return async(req,res,requestId)=>{
    const url=new URL(req.url,config.mainOrigin),path=url.pathname;
    const assets={'/community/ui.mjs':['community.mjs','text/javascript'],'/community/style.css':['community.css','text/css'],'/favorites':['community.html','text/html'],'/community/admin':['community.html','text/html']};
    if(!assets[path]&&!path.startsWith('/api/community/'))return null;
    if(req.headers.host!==new URL(config.mainOrigin).host)fail('INVALID_HOST',403);
    if(assets[path]){
      if(!['GET','HEAD'].includes(req.method))fail('METHOD_NOT_ALLOWED',405);
      const [file,type]=assets[path];res.setHeader('Content-Type',type+'; charset=utf-8');
      res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
      return {route:path,data:req.method==='HEAD'?'':await readFile(new URL('../../web/'+file,import.meta.url))};
    }
    if(!community)fail('COMMUNITY_UNAVAILABLE',503);
    const action=path.slice('/api/community/'.length);if(!actions.has(action))fail('NOT_FOUND',404);
    if(req.method!==(read.has(action)?'GET':'POST'))fail('METHOD_NOT_ALLOWED',405);
    const production=config.environment==='production',name=production?'__Host-visitor':'visitor';
    const raw=cookie(req,name)??'',parts=raw.split('.');let visitor;
    if(parts.length===2&&/^[a-f0-9]{64}$/.test(parts[0])&&/^[a-f0-9]{64}$/.test(parts[1])&&timingSafeEqual(Buffer.from(parts[1]),Buffer.from(sign(parts[0]))))visitor=parts[0];
    if(!visitor){visitor=randomBytes(32).toString('hex');res.setHeader('Set-Cookie',`${name}=${visitor}.${sign(visitor)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000${production?'; Secure':''}`);}
    let input=Object.fromEntries(url.searchParams);
    if(!read.has(action)){
      if(req.headers.origin!==config.mainOrigin||(req.headers['sec-fetch-site']&&req.headers['sec-fetch-site']!=='same-origin'))fail('CSRF_REJECTED',403);
      if(req.headers['content-type']?.split(';')[0]!=='application/json')fail('CONTENT_TYPE',415);
      const now=Date.now();for(const [k,b]of buckets)if(b.until<=now)buckets.delete(k);
      const source=createHmac('sha256',key).update(req.socket.remoteAddress??'').digest('hex');
      let b=buckets.get(source);if(!b){if(buckets.size>=10000)fail('BUSY',429);b={until:now+60000,count:0};buckets.set(source,b);}if(++b.count>300)fail('RATE_LIMITED',429);
      const chunks=[];let size=0;for await(const p of req){size+=p.length;if(size>65536)fail('BODY_TOO_LARGE',413);chunks.push(p);}
      try{input=JSON.parse(Buffer.concat(chunks).toString());if(!input||typeof input!=='object'||Array.isArray(input))throw Error();}catch{fail('INVALID_JSON');}
    }
    const result=await community.run(action,input,{visitor,requestId,sessionToken:cookie(req,production?'__Host-session':'session')});
    return {route:'/api/community/'+action,data:JSON.stringify(result)};
  };
}
