import { readFile, writeFile } from 'node:fs/promises';
import { join, relative, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lifecycle } from './production-lifecycle.mjs';
import { runTool, backupProduction, verifyReferences } from './production-backup.mjs';
import { databaseReady } from '../backend/src/platform/migrations.mjs';
import { recoveryMaterial, copyBundle, plain } from './recovery-store.mjs';
import { connect } from './production-database.mjs';
import { backupPolicy, completeBackup } from './production-backup-policy.mjs';
import { createScanner } from '../backend/src/modules/uploads/scanner.mjs';
import { waitForProcessExit } from './process-exit.mjs';
import { writeAtomicJson } from './atomic-json.mjs';

const scripts=fileURLToPath(new URL('./',import.meta.url));
export async function runController(config,{requestedAt=Date.now(),backupOnly=false}={}){
  const policy=backupPolicy(config);
  // A Windows FileShare.None lock is held by the PowerShell host before this
  // process starts. This entry is only callable by that host in production.
  for(const p of [config.installationRoot,config.backupRoot,config.stagingRoot,config.evidenceRoot])await plain(p,true);
  const mainEnvironment=JSON.parse(await readFile(join(config.installationRoot,'main','environment.json'),'utf8'));
  if(config.healthUrl!==`http://${mainEnvironment.HOST}:${mainEnvironment.PORT}/health/ready`)throw Error('Readiness target differs from installation');
  const under=(child,parent)=>{const r=relative(resolve(parent),resolve(child));return !r||!r.startsWith('..')&&!isAbsolute(r);};
  if([config.installationRoot,config.backupRoot,config.stagingRoot,config.offDiskRoot].filter(Boolean).some(p=>under(config.recoveryMaterialFile,p)))throw Error('Recovery material must be separately controlled');
  if(under(config.backupRoot,config.installationRoot)||under(config.stagingRoot,config.installationRoot)||under(config.stagingRoot,config.backupRoot))throw Error('Backup/staging trees overlap runtime data');
  const availability=join(config.installationRoot,'main','availability.json');
  const journal=join(config.evidenceRoot,'controller-state.json');
  const runStarted=requestedAt,stopRequest=join(config.evidenceRoot,'stop-request.json');
  if(!Number.isSafeInteger(runStarted)||runStarted>Date.now())throw Error('Invalid manual start timestamp');
  let previous;
  try{previous=JSON.parse(await readFile(journal,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  const saveState=state=>writeAtomicJson(journal,state);
  const owned=new Map();let stop=false,writerStartedAt=0,lastBackup,lastReadiness,lastLeaseFailure;
  const lease=async state=>{
    const issuedAt=Date.now();
    try{await writeAtomicJson(availability,{version:1,state,issuedAt,expiresAt:issuedAt+(state==='warming'?120000:12000)});}
    catch(error){lastLeaseFailure={at:new Date().toISOString(),state,code:['EPERM','EACCES','EBUSY','ENOENT','ENOSPC'].includes(error.code)?error.code:'WRITE_FAILED'};throw error;}
  };
  async function startOwned(name,exe,args){
    if(owned.has(name))throw Error('Owned process exists');
    // The native host creates a kill-on-close Job. Credentials and config
    // contents never appear in the command line; only protected file paths do.
    const spec=join(config.evidenceRoot,randomUUID()+'.process.json');
    await writeFile(spec,JSON.stringify({exe,args,cwd:config.projectRoot}),{flag:'wx'});
    const child=spawn(config.pwsh,['-NoProfile','-File',join(scripts,'production-process.ps1'),'-Specification',spec],{windowsHide:true,stdio:['pipe','ignore','ignore']});
    child.on('error',()=>{child.spawnError=true;});child.stdin.on('error',()=>{});owned.set(name,child);
  }
  async function stopOwned(name,waitMs=5000){
    const child=owned.get(name);if(!child)return;
    const exited=()=>child.exitCode!==null||child.signalCode!==null||child.spawnError;
    if(!exited()){child.stdin.end();await waitForProcessExit(child,waitMs);}
    if(!exited())throw Error('Owned process failed to exit');
    owned.delete(name);
  }
  const storageCheck=(action,...args)=>runTool(config.pwsh,['-NoProfile','-File',join(scripts,'production-storage-check.ps1'),'-Action',action,'-Root',config.installationRoot,...args]);
  const service=action=>runTool(config.pwsh,['-NoProfile','-File',join(scripts,'production-services.ps1'),'-Action',action,'-ConfigFile',config.configFile]);
  const hooks={
    async closeIngress(){await lease('draining');await stopOwned('tunnel');},
    async recover(){
      await storageCheck('Stopped');
      // A prior unclean shutdown is retained in evidence, never overwritten by
      // an automatic publication decision. Source integrity is checked at startup.
      await saveState({clean:false,at:new Date().toISOString()});
    },
    async startDependencies(){
      await service('StartDatabase');
      const c=await connect(process.env.PRODUCTION_MIGRATION_URL,config.caFile);
      try{
        await c.query('SET ROLE owner_production');
        if(!await databaseReady(c,'production'))throw Error('Recovery schema check failed');
        await verifyReferences(c,join(config.installationRoot,'private'),join(config.installationRoot,'serving'));
      }finally{await c.end();}
      if(previous && !previous.clean && !backupOnly)await hooks.backup();
      await startOwned('scanner',config.scannerExe,['--config-file='+config.scannerConfig]);
      // ClamAV loads its signature database before accepting scans. Do not
      // launch a fail-closed main process while that dependency is warming.
      const validator=JSON.parse(await readFile(join(config.installationRoot,'validator','runtime.json'),'utf8'));
      const scan=createScanner({port:validator.scannerPort,timeout:1500}),deadline=Date.now()+60000;
      while(true){
        const host=owned.get('scanner');
        if(host.exitCode!==null||host.signalCode!==null||host.spawnError)throw Error('Scanner exited during startup');
        if((await scan(Buffer.from('production controller readiness'))).status==='clean')break;
        if(Date.now()>=deadline)throw Error('Scanner startup deadline exceeded');
        await new Promise(r=>setTimeout(r,500));
      }
    },
    async startWriters(){writerStartedAt=Date.now();await lease('warming');await startOwned('supervisor',config.pwsh,['-NoProfile','-File',join(scripts,'production-isolation.ps1'),'-Action','Start','-Root',config.installationRoot]);},
    async ready(){
      const deadline=Date.now()+60000;
      do{
        const processes=[...owned].map(([name,p])=>({name,exitCode:p.exitCode,signalCode:p.signalCode,spawnError:p.spawnError===true}));
        if(processes.some(p=>p.exitCode!==null||p.signalCode!==null||p.spawnError)){
          lastReadiness={at:new Date().toISOString(),kind:'process-exit',processes};return false;
        }
        const started=Date.now();
        try{
          // The application bounds dependency checks at 2 seconds and may
          // spend another 250 ms recording failure. Let its 503 reach us.
          const r=await fetch(config.healthUrl,{signal:AbortSignal.timeout(4000)});
          lastReadiness={at:new Date().toISOString(),kind:'http',status:r.status,elapsedMs:Date.now()-started,processes};
          await r.body?.cancel();if(r.ok)return true;
        }catch(error){lastReadiness={at:new Date().toISOString(),kind:'transport',timeout:error.name==='TimeoutError',elapsedMs:Date.now()-started,processes};}
        if(machine.phase==='open')return false;
        await new Promise(r=>setTimeout(r,500));
      }while(Date.now()<deadline);return false;
    },
    async renewLease(){await lease('open');},
    async openIngress(){
      // Only the existing, explicitly approved tunnel adapter may consume its
      // secret. No temporary tunnel fallback and no direct reads by this code.
      if(!config.tunnelAdapter)throw Error('Approved tunnel adapter required');
      const statusFile=join(config.evidenceRoot,randomUUID()+'.tunnel.json');
      await startOwned('tunnel',config.pwsh,['-NoProfile','-File',config.tunnelAdapter,'-Mode','Public','-TunnelMode','Own','-ManagedTunnelOnly','-ExpectedMainOrigin',mainEnvironment.MAIN_ORIGIN,'-ExpectedGameOrigin',mainEnvironment.GAME_ORIGIN,'-ManagedStatusFile',statusFile]);
      const deadline=Date.now()+70000;
      while(true){
        let status;
        try{status=JSON.parse((await readFile(statusFile,'utf8')).replace(/^\uFEFF/,''));}catch(e){if(e.code!=='ENOENT'&&!(e instanceof SyntaxError))throw e;}
        const host=owned.get('tunnel');
        if(status?.phase==='failed'||host.exitCode!==null||host.signalCode!==null||host.spawnError)throw Error('Managed tunnel failed');
        if(status?.phase==='connected')break;
        if(Date.now()>=deadline||!await hooks.ready())throw Error('Managed tunnel readiness failed');
        await hooks.renewLease();await new Promise(r=>setTimeout(r,1000));
      }
      await saveState({clean:false,phase:'active',startedAt:new Date(runStarted).toISOString()});
    },
    async stopWriters(){
      await lease('draining');
      const child=owned.get('supervisor');
      if(child)await waitForProcessExit(child,140000);
      await stopOwned('supervisor');await storageCheck('Stopped');await stopOwned('scanner');
      let graceful=writerStartedAt===0;
      if(writerStartedAt)try{const s=JSON.parse(await readFile(join(config.installationRoot,'shutdown.json'),'utf8'));graceful=s.graceful===true&&Date.parse(s.at)>=writerStartedAt;}catch{}
      return {graceful,forcedAbort:!graceful,memoryUploads:'restart required'};
    },
    async backup(){
      const id=new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID();
      const material=await recoveryMaterial(config.recoveryMaterialFile);
      const destination=join(config.backupRoot,id);
      const reportPath=join(config.evidenceRoot,id+'.backup.json');
      let firstReport=true;
      lastBackup=undefined;
      lastBackup=await completeBackup(config,{
        local:()=>backupProduction({url:process.env.PRODUCTION_MIGRATION_URL,dumpUrl:process.env.PRODUCTION_BACKUP_URL,
        caFile:config.caFile,pgBin:config.pgBin,privateRoot:join(config.installationRoot,'private'),servingRoot:join(config.installationRoot,'serving'),
        staging:join(config.stagingRoot,id),destination,material,assertStopped:()=>storageCheck('Stopped')}),
        checkDisk:()=>storageCheck('DifferentDisk','-Target',config.offDiskRoot),
        copy:()=>copyBundle(destination,join(config.offDiskRoot,id),material),
        report:async report=>{lastBackup={...report};await writeFile(reportPath,JSON.stringify(report),{flag:firstReport?'wx':'w'});firstReport=false;},
      });
    },
    async stopDatabase(){
      const c=await connect(process.env.PRODUCTION_MIGRATION_URL,config.caFile);
      try{
        await c.query('SET ROLE owner_production');
        // Existing development databases share the cluster: never terminate
        // their sessions just to complete a production shutdown report.
        const others=await c.query("SELECT 1 FROM pg_stat_activity WHERE backend_type='client backend' AND pid<>pg_backend_pid()");
        if(others.rowCount)throw Error('Other database clients remain; refusing shared cluster stop');
      }finally{await c.end();}
      await service('StopDatabase');
    },
    async report(result){
      const report={...result,lastReadiness,lastLeaseFailure,backupPolicy:policy,localBackupVerified:lastBackup?.localBackupVerified===true,
        offDiskVerified:lastBackup?.offDiskVerified===true,disasterRecoveryVerified:lastBackup?.disasterRecoveryVerified===true,at:new Date().toISOString()};
      await writeFile(join(config.evidenceRoot,randomUUID()+'.shutdown.json'),JSON.stringify(report),{flag:'wx'});
      previous={clean:result.ingressClosed&&result.writersStopped&&result.databaseStopped&&result.backupVerified,...report};await saveState(previous);
    },
  };
  const machine=lifecycle(hooks);
  process.on('SIGINT',()=>{stop=true;});process.on('SIGTERM',()=>{stop=true;});
  try{
    await hooks.closeIngress();
    if(backupOnly){await hooks.recover();await hooks.startDependencies();return;}
    while(!stop){
      try{const request=JSON.parse(await readFile(stopRequest,'utf8'));if(request.issuedAt>=runStarted)stop=true;}catch(e){if(e.code!=='ENOENT')throw e;}
      if(stop)break;
      await machine.tick();
      if(machine.phase==='failed'||machine.phase==='closed')break;
      await new Promise(r=>setTimeout(r,1000));
    }
  }
  finally{await machine.stop();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const config=JSON.parse(await readFile(process.argv[2],'utf8'));config.configFile=resolve(process.argv[2]);
  runController(config,{requestedAt:process.argv[3]?Number(process.argv[3]):Date.now(),backupOnly:process.argv[4]==='backup'}).catch(()=>{console.error('Managed production controller failed closed; inspect protected shutdown evidence.');process.exitCode=1;});
}
