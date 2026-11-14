// Installed acceptance probe: opens handles only, never reads secret contents
// or writes database/control files. Runs inside the actual role's Windows Job.
import { open, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { join } from 'node:path';
const [root,role,pipe]=process.argv.slice(2),runtime=join(root,'runtime');
const files={database:join(root,'postgres/global/pg_control'),maintenance:join(root,'configuration/maintenance.env'),
  recovery:join(root,'recovery/material.json'),mainConfig:join(runtime,'main/main.env'),
  private:join(runtime,'private/acceptance-canary'),serving:join(runtime,'serving/acceptance-canary'),
  inbox:join(runtime,'inbox/acceptance-canary'),stage:join(runtime,'stage/acceptance-canary')};
const result={role,secretEnvironment:Object.keys(process.env).some(k=>/DATABASE|SESSION|TOKEN|SECRET/.test(k)),files:{},network:{}};
for(const [key,path] of Object.entries(files)){
  result.files[key]={};
  for(const [mode,flag] of [['read','r'],['write','r+']]){
    try{const handle=await open(path,flag);await handle.close();result.files[key][mode]=true;}
    catch(error){result.files[key][mode]=false;result.files[key][mode+'Error']=error.code;}
  }
}
const connect=options=>new Promise(resolve=>{
  const socket=createConnection(options),timer=setTimeout(()=>{socket.destroy();resolve('timeout');},2500);
  socket.once('connect',()=>{clearTimeout(timer);socket.destroy();resolve('connected');});
  socket.once('error',error=>{clearTimeout(timer);resolve(error.code);});
});
if(role!=='main')for(const [name,host,port] of [['database','127.0.0.1',55441],['main','127.0.0.1',4320],['scanner','127.0.0.1',3310],['ipv6','::1',55441],['external','192.0.2.1',443]])result.network[name]=await connect({host,port});
if(role==='validator')result.unauthorizedPipe=await connect({path:pipe});
await writeFile(join(runtime,role,'temp/production-boundary.json'),JSON.stringify(result));
