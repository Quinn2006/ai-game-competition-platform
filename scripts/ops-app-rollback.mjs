// Starts candidate then immutable prior source on the same loopback address.
// No proxy/production service is switched by this local rehearsal.
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { probe } from './ops-probe.mjs';

function command(file,args) {
  const result=spawnSync(file,args,{encoding:'utf8',windowsHide:true});
  if(result.status!==0)throw new Error(`${file} failed`);
  return result.stdout.trim();
}
async function smoke(directory,port) {
  const child=spawn(process.execPath,['backend/src/server.mjs'],{cwd:directory,windowsHide:true,
    env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,APP_ENV:'development',PORT:String(port)},stdio:['ignore','pipe','pipe']});
  const closed=once(child,'close');
  let output='';
  child.stdout.on('data',chunk=>{output+=chunk;});
  child.stderr.resume();
  try {
    const deadline=Date.now()+10000;
    while(!output.includes('app.started')) {
      if(child.exitCode!==null||Date.now()>deadline)throw new Error('Release startup failed');
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    const url=`http://127.0.0.1:${port}`;
    if(!await probe(url+'/health/live')||!await probe(url+'/account'))throw new Error('Release smoke failed');
    if(await probe(url+'/health/ready'))throw new Error('Absent dependencies incorrectly ready');
  } finally { child.kill(); await closed; }
}
try {
  const revision=command('git',['rev-parse','HEAD']);
  await mkdir('tmp',{recursive:true});
  const directory=await mkdtemp(resolve('tmp','release-drill-'));
  const archive=join(directory,'stable.tar'),stable=join(directory,'stable');
  await mkdir(stable);
  command('git',['archive','--format=tar',`--output=${archive}`,revision]);
  command('tar',['-xf',archive,'-C',stable]);
  const socket=createServer().listen(0,'127.0.0.1');await once(socket,'listening');
  const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
  await smoke(resolve('.'),port);
  await smoke(stable,port);
  console.log(JSON.stringify({candidateStartup:true,previousArtifactStartup:true,revision,scope:'loopback application rollback smoke; no database compatibility or proxy switch acceptance'}));
} catch(error) {console.error(error.message);process.exitCode=1;}
