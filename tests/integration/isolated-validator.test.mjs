import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { isolatedFixture } from '../isolation-fixture.mjs';
import { zipFixture } from '../zip-fixture.mjs';
import { validationClient } from '../../backend/src/platform/isolated-runtime.mjs';
import { callChannel } from '../../backend/src/platform/service-channel.mjs';

test('separate validator: real ClamAV, malformed ZIP, expansion bound, EICAR, tampered input and cleanup',{
  skip:!process.env.CLAMD_PORT||process.platform!=='win32',timeout:30000,
},async()=>{
  const root=resolve('tmp','isolated-validator-'+randomUUID());await mkdir(root);
  const limits={compressed:1000000,expanded:4096,files:4};
  const fixture=await isolatedFixture(root,{scannerPort:Number(process.env.CLAMD_PORT),uploadLimits:limits});
  try {
    const worker=await fixture.launch('validator');assert.notEqual(worker.status.pid,process.pid);
    const validate=validationClient(fixture.runtime,limits);
    assert.equal((await validate(Buffer.from('not a ZIP'),randomUUID())).rejected,true);
    assert.equal((await validate(zipFixture([['index.html','x'.repeat(5000)]]),randomUUID())).code,'ZIP_LIMIT');
    const eicar='X5O!P%@AP[4\\PZX54(P^)7CC)7}'+ '$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
    const infected=await validate(zipFixture([['index.html','<p>Test</p>'],['sample.txt',eicar]]),randomUUID());
    assert.equal(infected.status,'infected');assert.equal(infected.serving,undefined);
    const clean=await validate(zipFixture([['index.html','<p>Safe fixture</p>']]),randomUUID());
    assert.equal(clean.status,'clean');assert.match(clean.serving.digest,/^[a-f0-9]{64}$/);
    const id=randomUUID();await writeFile(join(fixture.runtime.inboxRoot,id),'altered');
    await assert.rejects(callChannel(fixture.runtime.validator,{action:'validate',id,digest:'a'.repeat(64),size:7}),{status:503});
    await fixture.stop();
    await assert.rejects(callChannel(fixture.runtime.validator,{action:'health'},100),{status:503});
    assert.throws(()=>process.kill(worker.status.pid,0));
  }finally{await fixture.stop();}
});
