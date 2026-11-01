import { randomBytes, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { AppError, publicError } from '../../platform/errors.mjs';
import { inspectZip, defaultLimits } from './zip.mjs';
import QRCode from 'qrcode';

const assets = new Map([['/studio',['studio.html','text/html']],['/play',['play.html','text/html']],['/games/ui.mjs',['games.mjs','text/javascript']],['/games/style.css',['games.css','text/css']]]);
const mime = { html:'text/html',js:'text/javascript',css:'text/css',json:'application/json',svg:'image/svg+xml',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp',ico:'image/x-icon',mp3:'audio/mpeg',ogg:'audio/ogg',wav:'audio/wav',m4a:'audio/mp4',mp4:'video/mp4',webm:'video/webm',woff:'font/woff',woff2:'font/woff2',ttf:'font/ttf',wasm:'application/wasm',txt:'text/plain' };
const fail = (code,status=400) => { throw new AppError(code,status,'请求无法完成'); };
async function body(req,max) {
  let size=0; const parts=[];
  for await (const part of req) { size+=part.length; if(size>max) fail('BODY_TOO_LARGE',413); parts.push(part); }
  return Buffer.concat(parts);
}
export function createGameHttp({ config, uploads, storage, limits=defaultLimits, loadTimeout=30000 }) {
  const tickets=new Map();
  let cached=null;
  let receiving=false;
  function issue(version,context=null) {
    for(const [key,t] of tickets) if(t.expires<Date.now()) tickets.delete(key);
    if(tickets.size>=1000) fail('BUSY',429);
    const key=randomBytes(32).toString('hex');
    tickets.set(key,{version,context,expires:Date.now()+30*60000});
    return { src:`${config.gameOrigin}/g/${key}/index.html`,workId:version.work_id,title:version.title,
      saveVersion:version.metadata.saveVersion,orientation:version.metadata.orientation,loadTimeout };
  }
  const main=async(req,res,requestId)=>{
    const url=new URL(req.url,config.mainOrigin),path=url.pathname;
    if(!assets.has(path) && !path.startsWith('/api/games/')) return null;
    if(req.headers.host!==new URL(config.mainOrigin).host) fail('INVALID_HOST',403);
    const asset=assets.get(path);
    if(asset) {
      if(!['GET','HEAD'].includes(req.method)) fail('METHOD_NOT_ALLOWED',405);
      res.setHeader('Content-Type',asset[1]+'; charset=utf-8');
      res.setHeader('Content-Security-Policy',`default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-src ${config.gameOrigin}; base-uri 'none'; frame-ancestors ${path==='/play'?config.mainOrigin:"'none'"}`);
      return {route:path,data:req.method==='HEAD'?'':await readFile(new URL('../../web/'+asset[0],import.meta.url))};
    }
    if(!uploads) fail('UPLOADS_UNAVAILABLE',503);
    const action=path.slice('/api/games/'.length);
    if(action==='qr') {
      if(req.method!=='GET') fail('METHOD_NOT_ALLOWED',405);
      const work=await uploads.published(url.searchParams.get('work'));
      res.setHeader('Content-Type','image/svg+xml');
      return {route:path,data:await QRCode.toString(config.mainOrigin+'/play?work='+work.work_id,{type:'svg',errorCorrectionLevel:'M'})};
    }
    const cookies=(req.headers.cookie??'').split(';').map(x=>x.trim()).filter(x=>x.startsWith('session='));
    const context={requestId,sessionToken:cookies.length===1?cookies[0].slice(8):undefined};
    if(action==='play') {
      if(req.method!=='GET') fail('METHOD_NOT_ALLOWED',405);
      return {route:path,data:JSON.stringify(issue(await uploads.published(url.searchParams.get('work'))))};
    }
    if(req.method!=='POST') fail('METHOD_NOT_ALLOWED',405);
    if(req.headers.origin!==config.mainOrigin || (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site']!=='same-origin')) fail('CSRF_REJECTED',403);
    let input,bytes;
    if(action==='upload') {
      if(receiving)fail('UPLOAD_BUSY',429);
      if(req.headers['content-type']!=='application/zip') fail('CONTENT_TYPE',415);
      // Authenticate before accepting a large body.
      await uploads.run('detail',{workId:url.searchParams.get('workId')},context);
      try {input=JSON.parse(url.searchParams.get('metadata'));} catch {fail('INVALID_JSON');}
      if(!input || typeof input!=='object' || Array.isArray(input)) fail('INVALID_JSON');
      input.workId=url.searchParams.get('workId');
      if(receiving)fail('UPLOAD_BUSY',429);
      receiving=true;try {bytes=await body(req,limits.compressed);}finally{receiving=false;}
    } else {
      if(req.headers['content-type']?.split(';')[0]!=='application/json') fail('CONTENT_TYPE',415);
      try {input=JSON.parse((await body(req,16384)).toString());} catch {fail('INVALID_JSON');}
      if(!input || typeof input!=='object' || Array.isArray(input)) fail('INVALID_JSON');
    }
    const result=action==='preview'?issue(await uploads.preview(context,input.workId,input.versionId),context):await uploads.run(action,input,context,bytes);
    return {route:path,data:JSON.stringify(result)};
  };
  const game=createServer({requestTimeout:10000},async(req,res)=>{
    res.setHeader('Cache-Control','no-store'); res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    res.setHeader('Content-Security-Policy',"default-src 'none'; sandbox");
    try {
      if(req.headers.host!==new URL(config.gameOrigin).host) fail('INVALID_HOST',403);
      if(!['GET','HEAD'].includes(req.method)) fail('METHOD_NOT_ALLOWED',405);
      const match=/^\/g\/([a-f0-9]{64})\/(.+)$/.exec(new URL(req.url,config.gameOrigin).pathname);
      const ticket=match&&tickets.get(match[1]);
      if(!ticket || ticket.expires<=Date.now()) fail('NOT_FOUND',404);
      const v=ticket.context?await uploads.preview(ticket.context,ticket.version.work_id,ticket.version.id):await uploads.published(ticket.version.work_id);
      if(v.id!==ticket.version.id) fail('VERSION_CHANGED',409);
      const base=`${config.gameOrigin}/g/${match[1]}/`,external=v.metadata.domains.join(' ');
      res.setHeader('Content-Security-Policy',`default-src 'none'; sandbox allow-scripts; script-src ${base} 'unsafe-inline' ${external}; style-src ${base} 'unsafe-inline' ${external}; img-src ${base} data: ${external}; media-src ${base} ${external}; font-src ${base} ${external}; connect-src ${base} ${external}; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors ${config.mainOrigin}`);
      // Opaque sandbox origins need CORS for module scripts and fetch of package assets.
      res.setHeader('Access-Control-Allow-Origin','*');
      const path=decodeURIComponent(match[2]);
      let data;
      if(path==='__platform_bridge.mjs') { data=await readFile(new URL('../../web/bridge.mjs',import.meta.url)); res.setHeader('Content-Type','text/javascript'); }
      else {
        if(cached?.id!==v.id || cached.digest!==v.digest){
          const bytes=await storage.get(ticket.context?'review':'release',v.id);
          if(createHash('sha256').update(bytes).digest('hex')!==v.digest)fail('ASSET_INTEGRITY',503);
          cached={id:v.id,digest:v.digest,...await inspectZip(bytes,limits)};
        }
        const archive=cached;
        data=archive.files.get(path);
        if(!data) fail('NOT_FOUND',404);
        res.setHeader('Content-Type',(mime[path.split('.').at(-1).toLowerCase()]??'application/octet-stream')+'; charset=utf-8');
        if(path==='index.html') data=Buffer.concat([Buffer.from('<script src="__platform_bridge.mjs"></script>'),data]);
      }
      res.writeHead(200);res.end(req.method==='HEAD'?undefined:data);
    } catch(error) {const result=publicError(error,'game');res.writeHead(result.status);res.end(JSON.stringify(result.body));}
  });
  return {main,game};
}
