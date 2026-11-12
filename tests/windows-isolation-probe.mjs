// Runs only in the dedicated acceptance tree, under one of the new accounts.
import { readFile, writeFile, open } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { readRuntimeConfig } from '../backend/src/platform/isolated-runtime.mjs';
import { serveChannel, callChannel } from '../backend/src/platform/service-channel.mjs';
const [root,role,databaseFile]=process.argv.slice(2);
const config=await readRuntimeConfig(join(root,role,'runtime.json'),role);
const result={role, pid:process.pid, secretEnvironment:Object.keys(process.env).some(key=>/DATABASE|SESSION|TOKEN|SECRET/i.test(key)),files:{},network:{}};
const files=['private/probe-db','private/probe-review','private/probe-backup','main/probe-secret','serving/probe-readable'].map(name=>[name,join(root,name)]);
if(databaseFile)files.push(['disposable-database',databaseFile]);
for(const [name,file] of files){
  let read=false,write=false;
  try{await readFile(file);read=true;}catch{}
  try{const handle=await open(file,'r+');await handle.close();write=true;}catch{}
  result.files[name]={read,write};
}
const output=join(root,role,'temp','acceptance.json');
if(role==='main'){
  await serveChannel(config.auth,async input=>({ok:input?.action==='probe',pid:process.pid}));
  await writeFile(output,JSON.stringify(result));
}else{
  for(const [name,host,port] of [['database','127.0.0.1',55673],['unrelated','127.0.0.1',4372],['ipv6','::1',4373],['external','192.0.2.1',443],['scanner','127.0.0.1',config.scannerPort]]){
    result.network[name]=await new Promise(resolve=>{
      const socket=createConnection({host,port});const timer=setTimeout(()=>{socket.destroy();resolve('timeout');},2000);
      socket.on('connect',()=>{clearTimeout(timer);socket.destroy();resolve('connected');});
      socket.on('error',error=>{clearTimeout(timer);resolve(error.code);});
    });
  }
  if(role==='game'){
    try{result.authenticatedPipe=(await callChannel(config.auth,{action:'probe'})).ok;}
    catch(error){result.pipeError=error.code;result.authenticatedPipe=false;}
  }
  if(role==='validator')result.unauthorizedPipe=await new Promise(resolve=>{
    const socket=createConnection(config.validator.pipe.replace(/-validator$/,'-auth'));
    const timer=setTimeout(()=>{socket.destroy();resolve('timeout');},2000);
    socket.on('connect',()=>{clearTimeout(timer);socket.destroy();resolve('connected');});
    socket.on('error',error=>{clearTimeout(timer);resolve(error.code);});
  });
  await writeFile(output,JSON.stringify(result));
}
