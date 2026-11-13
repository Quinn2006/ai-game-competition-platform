import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, cp } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { retainedBackups } from '../scripts/production-retention.mjs';
import { createAvailability } from '../backend/src/platform/availability.mjs';
import { lifecycle } from '../scripts/production-lifecycle.mjs';
import { createRecoveryMaterial, writeBundle, verifyBundle, unpackBundle, copyBundle, inside } from '../scripts/recovery-store.mjs';

const at=time=>Date.parse('2026-11-13T'+time+'+08:00');
async function root(){const path=resolve('tmp','recovery-unit-'+randomUUID());await mkdir(path,{recursive:true});return path;}
test('manual availability permits any hour but refuses stale/future leases, malformed file and drain',async()=>{
  const dir=await root(),file=join(dir,'availability.json');let now=at('07:59:59');
  const a=createAvailability(file,()=>now);
  assert.equal(await a.permits(),false);
  for(const [time,expected] of [['00:00:00',true],['07:59:59',true],['08:00:00',true],['21:59:59',true],['22:00:00',true],['23:59:59',true]]){
    now=at(time);await writeFile(file,JSON.stringify({version:1,state:'open',issuedAt:now,expiresAt:now+12000}));assert.equal(await a.permits(),expected);
  }
  now=at('12:00:00');await writeFile(file,JSON.stringify({version:1,state:'open',issuedAt:now+1,expiresAt:now+12000}));assert.equal(await a.permits(),false);
  await writeFile(file,JSON.stringify({version:1,state:'open',issuedAt:now-20000,expiresAt:now-1}));assert.equal(await a.permits(),false);
  await writeFile(file,'{');assert.equal(await a.permits(),false);
  a.drain();assert.equal(await a.state(),'draining');
});

test('Windows managed process host reports a naturally failing child without waiting for stdin closure',{skip:process.platform!=='win32',timeout:10000},async()=>{
  const dir=await root(),specification=join(dir,'process.json');
  await writeFile(specification,JSON.stringify({exe:process.execPath,args:['-e','process.exit(7)'],cwd:dir}));
  const host=spawn('pwsh.exe',['-NoProfile','-File',resolve('scripts/production-process.ps1'),'-Specification',specification],{windowsHide:true,stdio:['pipe','ignore','ignore']});
  const timer=setTimeout(()=>host.stdin.end(),5000);
  try{const started=performance.now();await once(host,'exit');assert.notEqual(host.exitCode,0);assert.ok(performance.now()-started<4500,'natural failure must propagate promptly');}
  finally{clearTimeout(timer);host.stdin.end();}
});
function fixture(){
  const calls=[],faults=new Set();let now=at('08:00:00');
  const hooks=Object.fromEntries(['closeIngress','recover','startDependencies','startWriters','ready','renewLease','openIngress','stopWriters','backup','stopDatabase','report'].map(name=>[name,async value=>{calls.push(name);if(faults.has(name))throw Error(name);return name==='ready'?true:value;}]));
  const machine=lifecycle(hooks,{clock:()=>now});
  return {calls,faults,machine,set time(value){now=at(value);}};
}
test('manual close orders ingress, drain, backup and safe database stop; repeated stop never reopens',async()=>{
  const f=fixture();await f.machine.tick();assert.equal(f.machine.phase,'open');
  const report=await f.machine.stop();assert.equal(report.writersStopped,true);
  assert.deepEqual(f.calls.slice(-5),['closeIngress','stopWriters','backup','stopDatabase','report']);
  const length=f.calls.length;await f.machine.tick();assert.equal(f.calls.length,length);
  await f.machine.stop();await f.machine.stop();assert.equal(f.calls.length,length);
});
test('manual session starts after 22:00 and crosses old schedule boundaries without shutdown',async()=>{
  const f=fixture();f.time='21:59:59';await f.machine.tick();f.time='22:00:01';await f.machine.tick();
  assert.equal(f.machine.phase,'open');assert.equal(f.calls.includes('stopWriters'),false);await f.machine.stop();
  const night=fixture();night.time='23:30:00';await night.machine.tick();assert.equal(night.machine.phase,'open');await night.machine.stop();
});

test('retention keeps newest and daily/weekly/monthly floors',()=>{
  const items=Array.from({length:180},(_,i)=>({name:String(i),snapshotAt:new Date(Date.UTC(2026,10,13)-i*86400000).toISOString()}));
  const keep=retainedBackups(items,{daily:7,weekly:4,monthly:3});
  for(let i=0;i<7;i++)assert.ok(keep.has(String(i)));
  assert.ok(keep.size>=9);assert.ok(keep.size<=14);assert.equal(keep.has('179'),false);
  assert.throws(()=>retainedBackups(items,{daily:0,weekly:4,monthly:3}));
});

test('Windows managed process host stops its Job when controller pipe closes and releases its port',{skip:process.platform!=='win32',timeout:20000},async()=>{
  const dir=await root(),probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');
  const port=probe.address().port;await new Promise(r=>probe.close(r));
  const childFile=join(dir,'child.mjs'),ready=join(dir,'ready.json');
  await writeFile(childFile,`import {createServer} from 'node:net';import {writeFileSync} from 'node:fs';createServer().listen(${port},'127.0.0.1',()=>writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:process.pid,secretPresent:Boolean(process.env.PRODUCTION_ADMIN_URL)})));`);
  const specification=join(dir,'process.json');await writeFile(specification,JSON.stringify({exe:process.execPath,args:[childFile],cwd:dir}));
  const host=spawn('pwsh.exe',['-NoProfile','-File',resolve('scripts/production-process.ps1'),'-Specification',specification],{windowsHide:true,stdio:['pipe','ignore','pipe'],env:{...process.env,PRODUCTION_ADMIN_URL:'synthetic forbidden environment'}});
  let stderr='';host.stderr.on('data',c=>{stderr+=c;});
  try{
    let status;
    for(let i=0;i<100;i++){try{status=JSON.parse(await readFile(ready,'utf8'));break;}catch{}if(host.exitCode!==null)throw Error(stderr);await new Promise(r=>setTimeout(r,50));}
    assert.ok(status);assert.equal(status.secretPresent,false);
    const exit=once(host,'exit');host.stdin.end();await exit;assert.equal(host.exitCode,0,stderr);
    assert.throws(()=>process.kill(status.pid,0));
    probe.listen(port,'127.0.0.1');await once(probe,'listening');await new Promise(r=>probe.close(r));
  }finally{if(host.exitCode===null){host.stdin.end();await once(host,'exit');}}
});
test('backup failure is separate from database stop; active writer failure forbids backup/stop',async()=>{
  for(const fault of ['backup','stopWriters']){
    const f=fixture();await f.machine.tick();f.faults.add(fault);const report=await f.machine.stop();
    assert.equal(report.backupVerified,false);assert.equal(report.databaseStopped,fault==='backup');
    if(fault==='stopWriters')assert.equal(f.calls.includes('backup'),false);
  }
});
test('dependency failure, resume and clock reversal close once and require review',async()=>{
  for(const mode of ['ready','resume','reverse']){
    const f=fixture();await f.machine.tick();
    if(mode==='ready')f.faults.add('ready');else f.time=mode==='resume'?'08:01:00':'07:59:59';
    await f.machine.tick();f.time='09:00:00';await f.machine.tick();
    assert.equal(f.calls.filter(n=>n==='openIngress').length,1);
  }
});
test('encrypted bundle verifies bytes, excludes recovery key, refuses corruption/incompletion/wrong key and restores only a new directory',async()=>{
  const dir=await root(),source=join(dir,'source');await mkdir(source);await writeFile(join(source,'file.bin'),Buffer.from('private synthetic work'));
  const material=await createRecoveryMaterial(join(dir,'recovery.json'),'synthetic-session-secret-32-characters');
  const bundle=join(dir,'backup');await writeBundle({directory:bundle,sources:[{root:source,prefix:'private'}],metadata:{test:true},material});
  const m=await verifyBundle(bundle,material);assert.equal(m.files.length,1);
  assert.equal((await readFile(join(bundle,'00000000.enc'))).includes(Buffer.from('private synthetic work')),false);
  const restored=join(dir,'restored');await unpackBundle(bundle,restored,material);
  assert.equal((await readFile(join(restored,'private','file.bin'),'utf8')),'private synthetic work');
  await assert.rejects(unpackBundle(bundle,restored,material));
  await copyBundle(bundle,join(dir,'copy'),material);
  await assert.rejects(verifyBundle(bundle,{...material,encryptionKey:'0'.repeat(64)}));
  const damaged=join(dir,'damaged');await cp(bundle,damaged,{recursive:true});await writeFile(join(damaged,'00000000.enc'),'corrupt');await assert.rejects(verifyBundle(damaged,material));
  const interrupted=join(dir,'interrupted');await assert.rejects(writeBundle({directory:interrupted,sources:[{root:source,prefix:'private'}],metadata:{},material,beforeComplete:async()=>{throw Error('Power loss');}}));
  await assert.rejects(readFile(join(interrupted,'complete.json')));await assert.rejects(verifyBundle(interrupted,material));
  for(const name of ['../file','C:/file','a\\b','/a','a/../b'])assert.throws(()=>inside(dir,name));
});
