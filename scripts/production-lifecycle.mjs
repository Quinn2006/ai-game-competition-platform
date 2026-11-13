// Serialized state transitions for an explicitly started manual session.
// Hooks own concrete resources, so no global PID/name-based termination occurs.
export function lifecycle(hooks,{clock=Date.now,maximumGapMs=15000}={}) {
  let phase='closed',last=null,busy=null,failed=false,lastClose=null;
  async function close(reason){
    if(lastClose && ['closed','failed'].includes(phase))return lastClose;
    phase='closing';const result={reason,ingressClosed:false,writersStopped:false,backupVerified:false,databaseStopped:false};
    const errors=[];
    // Ingress closes before waiting for any application work.
    for(const [name,action] of [['ingressClosed',()=>hooks.closeIngress()],['writersStopped',()=>hooks.stopWriters()]]){
      try{const outcome=await action();result[name]=true;if(name==='writersStopped'&&outcome)result.writerOutcome=outcome;}catch{errors.push(name);}
    }
    if(result.writersStopped){try{await hooks.backup();result.backupVerified=true;}catch{errors.push('backupVerified');}}
    // Backup failure never skips a safe database stop; live writers do.
    if(result.writersStopped){try{await hooks.stopDatabase();result.databaseStopped=true;}catch{errors.push('databaseStopped');}}
    phase=errors.length?'failed':'closed';result.errors=errors;await hooks.report(result);lastClose=result;return result;
  }
  async function tick(){
    const now=clock(),gap=last!==null&&(now<last||now-last>maximumGapMs);last=now;
    if(gap){failed=true;return close('clock-or-resume');}
    if(phase==='failed'||failed||lastClose)return;
    if(phase==='closed'){
      phase='starting';
      lastClose=null;
      try{
        await hooks.closeIngress();await hooks.recover();await hooks.startDependencies();await hooks.startWriters();
        if(!await hooks.ready())throw Error('Dependencies not ready');
        await hooks.renewLease();await hooks.openIngress();phase='open';
      }catch{failed=true;return close('startup-failed');}
    }else if(phase==='open'){
      try{if(!await hooks.ready())throw Error('Dependency failed');await hooks.renewLease();}
      catch{failed=true;return close('dependency-failed');}
    }
  }
  function serialized(fn){if(busy)return busy;busy=fn().finally(()=>{last=clock();busy=null;});return busy;}
  return {tick:()=>serialized(tick),stop:()=>serialized(()=>close('operator-stop')),get phase(){return phase;}};
}
