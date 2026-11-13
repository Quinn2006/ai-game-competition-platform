import test from 'node:test';
import assert from 'node:assert/strict';
import { backupPolicy, completeBackup } from '../scripts/production-backup-policy.mjs';

test('local backup exception requires explicit acknowledgement and never reports disaster recovery',async()=>{
  assert.throws(()=>backupPolicy({}));
  assert.throws(()=>backupPolicy({backupPolicy:'local-only'}));
  assert.throws(()=>backupPolicy({backupPolicy:'local-only',localOnlyAcknowledged:true,offDiskRoot:'C:/backup'}));
  assert.throws(()=>backupPolicy({backupPolicy:'typo',offDiskRoot:'E:/backup'}));
  const calls=[];
  const result=await completeBackup({backupPolicy:'local-only',localOnlyAcknowledged:true},{
    local:async()=>calls.push('local'),checkDisk:async()=>assert.fail('No fabricated disk check'),
    copy:async()=>assert.fail('No fabricated copy'),report:async r=>calls.push({...r}),
  });
  assert.equal(result.localBackupVerified,true);assert.equal(result.offDiskVerified,false);
  assert.equal(result.disasterRecoveryVerified,false);assert.equal(calls.filter(x=>x==='local').length,1);
});

test('default off-disk policy fails on same-disk rejection and preserves verified local result',async()=>{
  let result,copied=false;
  await assert.rejects(completeBackup({offDiskRoot:'C:/backup'},{local:async()=>{},
    checkDisk:async()=>{throw Error('Same physical disk');},copy:async()=>{copied=true;},report:async r=>{result={...r};},
  }),/Same physical disk/);
  assert.equal(result.localBackupVerified,true);assert.equal(result.offDiskVerified,false);assert.equal(copied,false);
});

test('local backup failure propagates and cannot produce a successful backup report',async()=>{
  let result;
  await assert.rejects(completeBackup({backupPolicy:'local-only',localOnlyAcknowledged:true},{
    local:async()=>{throw Error('Disk full');},report:async r=>{result={...r};},
  }),/Disk full/);
  assert.equal(result.localBackupVerified,false);assert.equal(result.disasterRecoveryVerified,false);
});
