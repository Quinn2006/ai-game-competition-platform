// Local-only is an explicit operator decision, never an automatic fallback.
export function backupPolicy(config) {
  const policy=config.backupPolicy??'different-physical-disk';
  if(policy==='local-only') {
    if(config.offDiskRoot || config.localOnlyAcknowledged!==true)throw Error('Explicit local-only acknowledgement required; omit offDiskRoot');
  } else if(policy!=='different-physical-disk' || !config.offDiskRoot)throw Error('Physical backup disk required');
  return policy;
}

export async function completeBackup(config,{local,checkDisk,copy,report}) {
  const policy=backupPolicy(config);
  const result={backupPolicy:policy,localBackupVerified:false,offDiskVerified:false,disasterRecoveryVerified:false};
  await report(result);
  await local();result.localBackupVerified=true;await report(result);
  if(policy==='different-physical-disk') {
    await checkDisk();await copy();result.offDiskVerified=true;result.disasterRecoveryVerified=true;
  } else result.offDiskStatus='not-performed-operator-accepted';
  await report(result);
  return result;
}
