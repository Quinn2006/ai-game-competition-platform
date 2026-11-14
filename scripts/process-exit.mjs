// Clear the deadline when a process exits early; an abandoned timer must not
// keep the controller (and its exclusive manual-start lock) alive after stop.
export function waitForProcessExit(child,timeoutMs) {
  if(child.exitCode!==null||child.signalCode!==null||child.spawnError)return Promise.resolve();
  return new Promise(resolve=>{
    const finish=()=>{clearTimeout(timer);child.off('exit',finish);resolve();};
    const timer=setTimeout(finish,timeoutMs);
    child.once('exit',finish);
  });
}
