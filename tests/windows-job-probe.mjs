import { writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { Worker } from 'node:worker_threads';

const [mode,output]=process.argv.slice(2);
if(mode==='child') {
  try {
    const child=spawn(process.execPath,['-e','process.exit(0)'],{windowsHide:true,stdio:'ignore'});
    child.on('error',async error=>{await writeFile(output,JSON.stringify({blocked:true,code:error.code}));});
    child.on('exit',async code=>{await writeFile(output,JSON.stringify({blocked:code!==0,code}));});
  } catch(error) {await writeFile(output,JSON.stringify({blocked:true,code:error.code}));}
} else if(mode==='memory') {
  await writeFile(output,'started');
  const allocations=[];
  try {for(let i=0;i<40;i++)allocations.push(Buffer.alloc(16*1024*1024,1));await writeFile(output,'limit-escaped');}
  catch {await writeFile(output,'allocation-refused');}
} else if(mode==='cpu') {
  await writeFile(output,'started');
  for(let i=0;i<2;i++)new Worker('while(true){}',{eval:true});
} else throw Error('Unknown probe');
