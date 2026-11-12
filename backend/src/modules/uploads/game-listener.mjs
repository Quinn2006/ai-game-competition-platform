import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { AppError, publicError } from '../../platform/errors.mjs';
const mime = { html:'text/html',js:'text/javascript',css:'text/css',json:'application/json',svg:'image/svg+xml',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp',ico:'image/x-icon',mp3:'audio/mpeg',ogg:'audio/ogg',wav:'audio/wav',m4a:'audio/mp4',mp4:'video/mp4',webm:'video/webm',woff:'font/woff',woff2:'font/woff2',ttf:'font/ttf',wasm:'application/wasm',txt:'text/plain' };
const fail=(code,status)=>{throw new AppError(code,status,'请求无法完成');};
export function createGameListener({config,authorize,readAsset}) {
  let active=0;
  return createServer({requestTimeout:10000,maxHeaderSize:8192},async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    res.setHeader('Content-Security-Policy',"default-src 'none'; sandbox");
    if(active>=16){res.writeHead(503);res.end();return;}
    active++;
    try {
      if(req.headers.host!==new URL(config.gameOrigin).host)fail('INVALID_HOST',403);
      if(!['GET','HEAD'].includes(req.method))fail('METHOD_NOT_ALLOWED',405);
      const match=/^\/g\/([a-f0-9]{64})\/(.+)$/.exec(new URL(req.url,config.gameOrigin).pathname);
      if(!match)fail('NOT_FOUND',404);
      const path=decodeURIComponent(match[2]);
      const v=await authorize(match[1],path);
      const base=`${config.gameOrigin}/g/${match[1]}/`,external=v.metadata.domains.join(' ');
      res.setHeader('Content-Security-Policy',`default-src 'none'; sandbox allow-scripts; script-src ${base} 'unsafe-inline' ${external}; style-src ${base} 'unsafe-inline' ${external}; img-src ${base} data: ${external}; media-src ${base} ${external}; font-src ${base} ${external}; connect-src ${base} ${external}; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors ${config.mainOrigin}`);
      res.setHeader('Access-Control-Allow-Origin','*');
      let data;
      if(path==='__platform_bridge.mjs') {data=await readFile(new URL('../../../../frontend/bridge.mjs',import.meta.url));res.setHeader('Content-Type','text/javascript');}
      else {
        data=await readAsset(v,path,match[1]);
        res.setHeader('Content-Type',(mime[path.split('.').at(-1).toLowerCase()]??'application/octet-stream')+'; charset=utf-8');
        if(path==='index.html')data=Buffer.concat([Buffer.from('<script src="__platform_bridge.mjs"></script>'),data]);
      }
      res.writeHead(200);res.end(req.method==='HEAD'?undefined:data);
    } catch(error) {const result=publicError(error,'game');res.writeHead(result.status);res.end(JSON.stringify(result.body));}
    finally {active--;}
  });
}
