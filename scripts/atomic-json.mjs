import { writeFile,rename,unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';

// Preserve atomic replacement, including when a short-lived Windows reader
// lacks delete sharing. Persistent denial still fails within the lease budget.
export async function writeAtomicJson(path,value,{retryMs=1000}={}) {
  const temporary=path+'.'+randomUUID()+'.tmp';
  await writeFile(temporary,JSON.stringify(value),{flag:'wx'});
  const deadline=performance.now()+retryMs;
  try {
    for(;;){
      try {await rename(temporary,path);return;}
      catch(error){
        if(process.platform!=='win32'||!['EPERM','EACCES','EBUSY'].includes(error.code)||performance.now()>=deadline)throw error;
        await setTimeout(20);
      }
    }
  } finally {await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
}
