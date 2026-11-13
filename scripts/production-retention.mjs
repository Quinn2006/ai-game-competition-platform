import { readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyBundle, recoveryMaterial, plain, digestFile } from './recovery-store.mjs';
import { runTool } from './production-backup.mjs';
import { hash } from './production-database.mjs';
import { fileURLToPath } from 'node:url';

export function retainedBackups(items,{daily=7,weekly=4,monthly=3}={}) {
  for(const value of [daily,weekly,monthly])if(!Number.isInteger(value)||value<1)throw Error('Positive retention floors required');
  const sorted=[...items].sort((a,b)=>b.snapshotAt.localeCompare(a.snapshotAt)),keep=new Set();
  for(const [limit,bucket] of [[daily,s=>s.slice(0,10)],[weekly,s=>String(Math.floor((Date.parse(s)+8*3600000)/604800000))],[monthly,s=>s.slice(0,7)]]){
    const seen=new Set();
    for(const item of sorted){const key=bucket(item.snapshotAt);if(!seen.has(key)&&seen.size<limit){keep.add(item.name);seen.add(key);}}
  }
  if(sorted[0])keep.add(sorted[0].name);
  return keep;
}
export async function retentionPlan(root,offDiskRoot,material,policy) {
  await plain(root,true);await plain(offDiskRoot,true);
  if(resolve(root).toLowerCase()===resolve(offDiskRoot).toLowerCase())throw Error('Independent copy required');
  const items=[];
  for(const entry of await readdir(root,{withFileTypes:true})){
    if(!entry.isDirectory()||entry.isSymbolicLink())throw Error('Unexpected retention entry; inspect manually');
    const path=join(root,entry.name),m=await verifyBundle(path,material);
    if(!Number.isFinite(Date.parse(m.snapshotAt)))throw Error('Backup timestamp invalid');
    items.push({name:entry.name,snapshotAt:m.snapshotAt,manifestSha256:await digestFile(join(path,'manifest.enc'))});
  }
  if(!items.length)throw Error('No verified backup');
  const keep=retainedBackups(items,policy);
  // Every candidate must already have a verified copy on the distinct disk.
  // Remote copies are never removed by this command, so the last surviving
  // copy cannot be erased by an independent local/remote retention run.
  for(const item of items){
    await verifyBundle(join(offDiskRoot,item.name),material);
    if(await digestFile(join(offDiskRoot,item.name,'manifest.enc'))!==item.manifestSha256)throw Error('Off-disk copy differs');
  }
  return {format:1,root:resolve(root),offDiskRoot:resolve(offDiskRoot),policy,
    keep:items.filter(i=>keep.has(i.name)),remove:items.filter(i=>!keep.has(i.name))};
}
async function main(){
  const [action,configFile,planFile]=process.argv.slice(2),config=JSON.parse(await readFile(configFile,'utf8'));
  const material=await recoveryMaterial(config.recoveryMaterialFile);
  await runTool(config.pwsh,['-NoProfile','-File',fileURLToPath(new URL('./production-storage-check.ps1',import.meta.url)),'-Action','DifferentDisk','-Root',config.backupRoot,'-Target',config.offDiskRoot]);
  const plan=await retentionPlan(config.backupRoot,config.offDiskRoot,material,config.retention);
  if(action==='plan'){await writeFile(planFile,JSON.stringify(plan,null,2),{flag:'wx'});console.log('Review retention digest: '+hash(JSON.stringify(plan)));return;}
  const reviewed=JSON.parse(await readFile(planFile,'utf8'));
  if(action!=='apply'||JSON.stringify(plan)!==JSON.stringify(reviewed)||process.env.APPROVED_RETENTION_SHA256!==hash(JSON.stringify(plan)))throw Error('Explicit unchanged retention approval required');
  for(const item of plan.remove){
    const target=resolve(plan.root,item.name);
    if(!target.toLowerCase().startsWith(plan.root.toLowerCase()+'\\')||target===plan.root)throw Error('Deletion target escaped');
    await plain(target,true);await verifyBundle(target,material);
    // The byte-verified, independently stored encrypted bundle is the recovery
    // copy required before removing this exact local directory.
    await rm(target,{recursive:true});
  }
  console.log('Removed only reviewed local copies; verified off-disk recovery copies retained.');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(()=>{console.error('Retention refused; inspect incomplete backups, copies and reviewed digest.');process.exitCode=1;});
