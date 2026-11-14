import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once, EventEmitter } from 'node:events';
import { waitForProcessExit } from '../scripts/process-exit.mjs';

test('early child exit releases the Node event loop instead of retaining the shutdown deadline',async()=>{
  const url=new URL('../scripts/process-exit.mjs',import.meta.url).href;
  const child=spawn(process.execPath,['--input-type=module','-e',`import{EventEmitter}from'node:events';import{waitForProcessExit}from ${JSON.stringify(url)};const child=new EventEmitter();child.exitCode=null;child.signalCode=null;setTimeout(()=>child.emit('exit',0),20);await waitForProcessExit(child,140000);`],{stdio:'ignore',windowsHide:true});
  const started=performance.now(),deadline=setTimeout(()=>child.kill(),3000);
  try{await once(child,'exit');assert.equal(child.exitCode,0);assert.ok(performance.now()-started<2500);}
  finally{clearTimeout(deadline);}
});

test('exit deadline removes its listener when the child does not exit',async()=>{
  const child=new EventEmitter();child.exitCode=null;child.signalCode=null;
  await waitForProcessExit(child,10);assert.equal(child.listenerCount('exit'),0);
});
