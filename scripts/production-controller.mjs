import { readFile, writeFile, rename } from 'node:fs/promises';
import { join, relative, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lifecycle } from './production-lifecycle.mjs';
import { runTool, backupProduction, verifyReferences } from './production-backup.mjs';
import { databaseReady } from '../backend/src/platform/migrations.mjs';
import { recoveryMaterial, copyBundle, plain } from './recovery-store.mjs';
import { connect } from './production-database.mjs';

const scripts=fileURLToPath(new URL('./',import.meta.url));
export async function runController(config,{requestedAt=Date.now(),backupOnly=false}={}){
  // A Windows FileShare.None lock is held by the PowerShell host before this
  // process starts. This entry is only callable by that host in production.
  for(const p of [config.installationRoot,config.backupRoot,config.stagingRoot,config.evidenceRoot])await plain(p,true);
  const mainEnvironment=JSON.parse(await readFile(join(config.installationRoot,'main','environment.json'),'utf8'));
  if(config.healthUrl!==`http://${mainEnvironment.HOST}:${mainEnvironment.PORT}/health/ready`)throw Error('Readiness target differs from installation');
  const under=(child,parent)=>{const r=relative(resolve(parent),resolve(child));return !r||!r.startsWith('..')&&!isAbsolute(r);};
  if([config.installationRoot,config.backupRoot,config.stagingRoot,config.offDiskRoot].some(p=>under(config.recoveryMaterialFile,p)))throw Error('Recovery material must be separately controlled');
  if(under(config.backupRoot,config.installationRoot)||under(config.stagingRoot,config.installationRoot)||under(config.stagingRoot,config.backupRoot))throw Error('Backup/staging trees overlap runtime data');
  const availability=join(config.installationRoot,'main','availability.json');
  const journal=join(config.evidenceRoot,'controller-state.json');
  const runStarted=requestedAt,stopRequest=join(config.evidenceRoot,'stop-request.json');
  if(!Number.isSafeInteger(runStarted)||runStarted>Date.now())throw Error('Invalid manual start timestamp');
  let previous;
  try{previous=JSON.parse(await readFile(journal,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  const saveState=async state=>{const p=journal+'.'+randomUUID()+'.tmp';await writeFile(p,JSON.stringify(state),{flag:'wx'});await rename(p,journal);};
  const owned=new Map();let stop=false,writerStartedAt=0;
  const lease=async state=>{
    const issuedAt=Date.now(),temporary=availability+'.'+randomUUID()+'.tmp';
    await writeFile(temporary,JSON.stringify({version:1,state,issuedAt,expiresAt:issuedAt+(state==='warming'?120000:12000)}),{flag:'wx'});
    await rename(temporary,availability);
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
    if(!exited()){child.stdin.end();await Promise.race([new Promise(r=>child.once('exit',r)),new Promise(r=>setTimeout(r,waitMs))]);}
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
    },
    async startWriters(){writerStartedAt=Date.now();await lease('warming');await startOwned('supervisor',config.pwsh,['-NoProfile','-File',join(scripts,'production-isolation.ps1'),'-Action','Start','-Root',config.installationRoot]);},
    async ready(){
      const deadline=Date.now()+60000;
      do{
        if([...owned.values()].some(p=>p.exitCode!==null||p.signalCode!==null||p.spawnError))return false;
        try{const r=await fetch(config.healthUrl,{signal:AbortSignal.timeout(2000)});if(r.ok)return true;}catch{}
        if(machine.phase==='open')return false;
        await new Promise(r=>setTimeout(r,500));
      }while(Date.now()<deadline);return false;
    },
    async renewLease(){await lease('open');},
    async openIngress(){
      // Only the existing, explicitly approved tunnel adapter may consume its
      // secret. No temporary tunnel fallback and no direct reads by this code.
      if(!config.tunnelAdapter)throw Error('Approved tunnel adapter required');
      await startOwned('tunnel',config.pwsh,['-NoProfile','-File',config.tunnelAdapter,'-Mode','Public','-TunnelMode','Own','-ManagedTunnelOnly','-ExpectedMainOrigin',mainEnvironment.MAIN_ORIGIN,'-ExpectedGameOrigin',mainEnvironment.GAME_ORIGIN]);
      await saveState({clean:false,phase:'active',startedAt:new Date(runStarted).toISOString()});
    },
    async stopWriters(){
      await lease('draining');
      const child=owned.get('supervisor');
      if(child&&child.exitCode===null&&child.signalCode===null&&!child.spawnError)await Promise.race([new Promise(r=>child.once('exit',r)),new Promise(r=>setTimeout(r,140000))]);
      await stopOwned('supervisor');await storageCheck('Stopped');await stopOwned('scanner');
      let graceful=false;
      try{const s=JSON.parse(await readFile(join(config.installationRoot,'shutdown.json'),'utf8'));graceful=s.graceful===true&&Date.parse(s.at)>=writerStartedAt;}catch{}
      return {graceful,forcedAbort:!graceful,memoryUploads:'restart required'};
    },
    async backup(){
      const id=new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID();
      const material=await recoveryMaterial(config.recoveryMaterialFile);
      const destination=join(config.backupRoot,id);
      const reportPath=join(config.evidenceRoot,id+'.backup.json'),report={localBackupVerified:false,offDiskVerified:false};
      await writeFile(reportPath,JSON.stringify(report),{flag:'wx'});
      await backupProduction({url:process.env.PRODUCTION_MIGRATION_URL,dumpUrl:process.env.PRODUCTION_BACKUP_URL,
        caFile:config.caFile,pgBin:config.pgBin,privateRoot:join(config.installationRoot,'private'),servingRoot:join(config.installationRoot,'serving'),
        staging:join(config.stagingRoot,id),destination,material,assertStopped:()=>storageCheck('Stopped')});
      report.localBackupVerified=true;await writeFile(reportPath,JSON.stringify(report));
      await storageCheck('DifferentDisk','-Target',config.offDiskRoot);
      await copyBundle(destination,join(config.offDiskRoot,id),material);
      report.offDiskVerified=true;await writeFile(reportPath,JSON.stringify(report));
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
      const report={...result,at:new Date().toISOString()};
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
