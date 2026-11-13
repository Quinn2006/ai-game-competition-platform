// Test harness only: production launcher never imports this module.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { callChannel } from '../backend/src/platform/service-channel.mjs';

export async function isolatedFixture(root, config, {servingRoot} = {}) {
  const id=randomUUID(), children=[];
  const runtime={};
  for(const name of ['servingRoot','inboxRoot','stageRoot']){runtime[name]=name==='servingRoot'&&servingRoot?servingRoot:join(root,name);if(name!=='servingRoot'||!servingRoot)await mkdir(runtime[name]);}
  for(const service of ['auth','validator','control']){
    const key=randomBytes(32).toString('hex'),keyFile=join(root,service+'.key');await writeFile(keyFile,key);
    runtime[service]={pipe:'\\\\.\\pipe\\agp-test-'+id+'-'+service,key,keyFile,service};
  }
  const minimal={SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR,TEMP:root,TMP:root};
  async function launch(role){
    const settings={version:1,role,mainOrigin:config.mainOrigin,gameOrigin:config.gameOrigin,gameListenOrigin:config.gameListenOrigin,
      ...(role==='game'?{auth:runtime.auth,control:runtime.control,servingRoot:runtime.servingRoot}:{validator:runtime.validator,inboxRoot:runtime.inboxRoot,stageRoot:runtime.stageRoot,scannerPort:config.scannerPort,limits:config.uploadLimits})};
    const path=join(root,role+'.json');await writeFile(path,JSON.stringify(settings));
    const entry=role==='game'?'game-server.mjs':'validator.mjs';
    const child=spawn(process.execPath,[resolve('backend/src',entry),path],{env:minimal,windowsHide:true,stdio:['ignore','ignore','pipe']});
    child.stderr.on('data',()=>{});children.push(child);
    const channel=role==='game'?runtime.control:runtime.validator;
    for(let tries=0;tries<100;tries++){
      if(child.exitCode!==null)throw Error('Child startup failed: '+role);
      try {const status=await callChannel(channel,{action:'health'});if(status.ready)return {child,status};}catch{}
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    throw Error('Child startup timed out: '+role);
  }
  async function stop(){await Promise.all(children.map(async child=>{if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill();await exited;}}));}
  return {runtime,launch,stop};
}
