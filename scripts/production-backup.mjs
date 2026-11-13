import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { connect, quote, hash, grantRuntime } from './production-database.mjs';
import { migrationFiles } from '../backend/src/platform/migrations.mjs';
import { seal, unseal } from '../backend/src/modules/identity/crypto.mjs';
import { plain, inventory, digestFile, recoveryMaterial, createRecoveryMaterial, writeBundle, verifyBundle, unpackBundle, copyBundle } from './recovery-store.mjs';
import { databaseReady } from '../backend/src/platform/migrations.mjs';
import { deletionParticipant as uploadDeletion } from '../backend/src/modules/uploads/service.mjs';
import { deletionParticipant as discoveryDeletion } from '../backend/src/modules/discovery/service.mjs';
import { deletionParticipant as communityDeletion } from '../backend/src/modules/community/service.mjs';
import { deletionParticipant as competitionDeletion } from '../backend/src/modules/competition/service.mjs';
import { deletionParticipant as operationsDeletion } from '../backend/src/modules/operations/service.mjs';

export async function runTool(exe,args,env={}) {
  return new Promise((resolve,reject)=>{
    const child=spawn(exe,args,{windowsHide:true,stdio:'ignore',env:{...process.env,...env}});
    child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error(`Maintenance subprocess failed: ${basename(exe)} (exit ${code})`)));
  });
}
export function pgArguments(url,caFile) {
  const u=new URL(url);
  if(u.search||u.hash||!caFile)throw Error('verify-full required');
  return {args:['-h',u.hostname,'-p',u.port||'5432','-U',decodeURIComponent(u.username),'-d',decodeURIComponent(u.pathname.slice(1))],env:{PGPASSWORD:decodeURIComponent(u.password),PGSSLMODE:'verify-full',PGSSLROOTCERT:caFile}};
}
export async function tableInventory(c) {
  const tables=(await c.query("SELECT schemaname,tablename FROM pg_tables WHERE schemaname IN ('public','platform') ORDER BY 1,2")).rows,result={};
  await c.query("SET timezone='UTC'");
  for(const t of tables){
    const rows=(await c.query(`SELECT row_to_json(t)::text AS row FROM ${quote(t.schemaname)}.${quote(t.tablename)} t ORDER BY row_to_json(t)::text COLLATE "C"`)).rows;
    result[t.schemaname+'.'+t.tablename]={count:rows.length,sha256:hash(rows.map(r=>r.row).join('\n'))};
  }
  return result;
}
async function compatible(m) {
  const migrations=(await migrationFiles()).map(({id,checksum})=>({id,checksum}));
  const version=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')).version;
  if(m.applicationVersion!==version||JSON.stringify(m.migrations)!==JSON.stringify(migrations))throw Error('Incompatible application/migration version');
}
export async function verifyReferences(c,privateRoot,servingRoot) {
  const files=await inventory(privateRoot),byPath=new Map(files.map(f=>[f.path,f]));
  async function object(key,digest){
    const file=byPath.get(key),metaPath=join(privateRoot,dirname(key),'.'+basename(key)+'.meta');
    if(!file||file.sha256!==digest||(await plain(metaPath)).size>4096)throw Error('Referenced original missing or changed');
    const meta=JSON.parse(await readFile(metaPath,'utf8'));
    if(meta.v!==1||meta.key!==key||meta.sha256!==digest||meta.size!==file.size)throw Error('Referenced object metadata differs');
  }
  const versions=(await c.query('SELECT id,digest,metadata,scan_status,status,revoked,withdrawn FROM platform.game_versions')).rows;
  for(const v of versions){
    if(v.scan_status!=='clean')continue;
    await object('production/review/'+v.id,v.digest);
    if(v.status==='approved'){
      await object('production/release/'+v.id,v.digest);
    }
    if(!v.metadata.serving)throw Error('Isolated resource manifest required');
    const path=join(servingRoot,v.id,v.metadata.serving.digest);
    if(await digestFile(path)!==v.metadata.serving.digest)throw Error('Serving manifest mismatch');
    const manifest=JSON.parse(await readFile(path,'utf8'));
    if(manifest.archive!==v.digest||!Array.isArray(manifest.files))throw Error('Serving archive mismatch');
    for(const f of manifest.files){
      if(!/^[a-f0-9]{64}$/.test(f.digest))throw Error('Serving digest invalid');
      const asset=join(servingRoot,v.id,f.digest);
      if((await plain(asset)).size!==f.size||await digestFile(asset)!==f.digest)throw Error('Serving file mismatch');
    }
  }
  const events=(await c.query("SELECT detail FROM platform.upload_events WHERE action='profile_files'")).rows;
  for(const {detail} of events)for(const f of detail.files??[]){
    if(!['review','release','quarantine'].includes(f.area)||!/^[-a-zA-Z0-9_]{1,128}$/.test(f.key)||byPath.get('production/'+f.area+'/'+f.key)?.sha256!==f.sha256)throw Error('Profile attachment mismatch');
    await object('production/'+f.area+'/'+f.key,f.sha256);
  }
  const invalid=(await c.query(`SELECT 1 FROM platform.works w JOIN platform.game_versions v ON v.id=w.published_version
    JOIN platform.accounts a ON a.id=w.owner_id WHERE v.work_id<>w.id OR v.status<>'approved' OR v.scan_status<>'clean'
    OR v.revoked OR v.withdrawn OR a.status<>'active' OR EXISTS(SELECT FROM platform.operations_hidden h WHERE h.work_id=w.id)`)).rowCount;
  if(invalid)throw Error('Publication state inconsistent');
  return {versions:versions.length,attachments:events.length};
}
export async function backupProduction({url,dumpUrl,caFile,pgBin,privateRoot,servingRoot,staging,destination,material,assertStopped}) {
  if(new URL(url).pathname!=='/ai_games_production'||new URL(dumpUrl).pathname!=='/ai_games_production')throw Error('Production source required');
  if(new URL(url).hostname!==new URL(dumpUrl).hostname||new URL(url).port!==new URL(dumpUrl).port)throw Error('Dump source differs');
  await assertStopped();await plain(dirname(staging),true);await mkdir(staging,{mode:0o700});
  const c=await connect(url,caFile),startedAt=new Date().toISOString();
  try{
    await c.query('SET ROLE owner_production');await c.query('BEGIN');
    const tables=(await c.query("SELECT schemaname,tablename FROM pg_tables WHERE schemaname IN ('public','platform') ORDER BY 1,2")).rows;
    await c.query(`LOCK TABLE ${tables.map(t=>quote(t.schemaname)+'.'+quote(t.tablename)).join(',')} IN SHARE MODE NOWAIT`);
    const migrations=(await c.query('SELECT id,checksum FROM public.schema_migrations ORDER BY id')).rows;
    if(!await databaseReady(c,'production'))throw Error('Source schema not compatible');
    if((await c.query('SELECT environment FROM platform.environment_identity')).rows[0]?.environment!=='production')throw Error('Wrong source environment');
    await verifyReferences(c,privateRoot,servingRoot);
    const before=await tableInventory(c),snapshot=(await c.query('SELECT pg_export_snapshot() AS id')).rows[0].id;
    const connection=pgArguments(dumpUrl,caFile);
    await runTool(join(pgBin,'pg_dump.exe'),[...connection.args,'-Fc','--no-owner','--no-acl','--snapshot='+snapshot,'-f',join(staging,'database.dump')],connection.env);
    await assertStopped();
    const ledger=(await c.query('SELECT kind,id,occurred_at FROM platform.recovery_ledger ORDER BY kind,id')).rows;
    const applicationVersion=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')).version;
    const metadata={applicationVersion,migrations,tables:before,ledger,startedAt,snapshotAt:new Date().toISOString(),
      database:'ai_games_production',serverVersion:(await c.query('SHOW server_version_num')).rows[0].server_version_num,
      memoryUploads:'discarded; client must restart upload',source:'stopped-writers-and-share-locks'};
    const manifest=await writeBundle({directory:destination,sources:[{root:staging,prefix:'database'},{root:privateRoot,prefix:'private'},{root:servingRoot,prefix:'serving'}],metadata,material,
      beforeComplete:async()=>{await assertStopped();if(JSON.stringify(before)!==JSON.stringify(await tableInventory(c)))throw Error('Database changed');}});
    await c.query('COMMIT');return manifest;
  }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{await c.end();}
}
export async function sanitizeRestored(c,oldSecret,newSecret,ledger) {
  if(!newSecret||newSecret.length<32||newSecret===oldSecret)throw Error('Fresh application secret required');
  await c.query('BEGIN');
  try{
    // Conservatively overlay later deletion/revocation evidence. A canceled
    // deletion/withdrawal requires operator review, never automatic resurrection.
    for(const item of ledger){
      if(!['account','chat','version','work','hidden'].includes(item.kind)||!/^[a-f0-9-]{36}$/.test(item.id))throw Error('Deletion ledger invalid');
      if(item.kind==='account'){
        for(const participant of [uploadDeletion,discoveryDeletion,communityDeletion,competitionDeletion,operationsDeletion])await participant.finalize(c,item.id);
        await c.query("UPDATE platform.accounts SET status='deleted',email=NULL,password_hash=NULL,mfa_secret=NULL,mfa_pending=NULL,nickname='',bio='',avatar='',roles='{}' WHERE id=$1",[item.id]);
        await c.query('UPDATE platform.works SET published_version=NULL WHERE owner_id=$1',[item.id]);
        await c.query('DELETE FROM platform.support_chats WHERE account_id=$1',[item.id]);
      } else if(item.kind==='chat'){
        await c.query('INSERT INTO platform.support_deletions(provider_key) SELECT provider_key FROM platform.support_chats WHERE id=$1 AND provider_key IS NOT NULL ON CONFLICT DO NOTHING',[item.id]);
        await c.query('DELETE FROM platform.support_chats WHERE id=$1',[item.id]);
      }
      else if(item.kind==='version'){
        await c.query('UPDATE platform.game_versions SET revoked=true WHERE id=$1',[item.id]);
        await c.query('UPDATE platform.works SET published_version=NULL WHERE published_version=$1',[item.id]);
      } else {
        await c.query('UPDATE platform.works SET published_version=NULL WHERE id=$1',[item.id]);
        await c.query('INSERT INTO platform.operations_hidden(work_id) SELECT id FROM platform.works WHERE id=$1 ON CONFLICT DO NOTHING',[item.id]);
      }
      await c.query('INSERT INTO platform.recovery_ledger(kind,id) VALUES($1,$2) ON CONFLICT DO NOTHING',[item.kind,item.id]);
    }
    const accounts=(await c.query('SELECT id,mfa_secret FROM platform.accounts WHERE mfa_secret IS NOT NULL')).rows;
    for(const a of accounts)await c.query('UPDATE platform.accounts SET mfa_secret=$2,mfa_pending=NULL WHERE id=$1',[a.id,seal(unseal(a.mfa_secret,oldSecret,a.id),newSecret,a.id)]);
    await c.query('UPDATE platform.accounts SET mfa_pending=NULL');
    const providers=(await c.query('SELECT key_cipher FROM platform.support_provider WHERE key_cipher IS NOT NULL')).rows;
    for(const p of providers)await c.query('UPDATE platform.support_provider SET key_cipher=$1,enabled=false',[seal(unseal(p.key_cipher,oldSecret,'support-provider-api-key'),newSecret,'support-provider-api-key')]);
    await c.query(`DELETE FROM platform.sessions; DELETE FROM platform.identity_tokens; DELETE FROM platform.auth_limits;
      UPDATE platform.support_chats SET pending=false WHERE pending;
      UPDATE platform.support_provider SET enabled=false;`);
    // play_sessions are historical metrics, not bearer credentials. In-memory
    // preview/play tickets and partial uploads cannot survive a process restart.
    await c.query('COMMIT');return {mfaAccounts:accounts.length,oldCredentialsInvalidated:true};
  }catch(e){await c.query('ROLLBACK');throw e;}
}
export async function restoreProduction({backup,targetRoot,targetDatabase,adminUrl,migrationUrl,caFile,pgBin,material,newSecret,latestLedger=[]}) {
  const started=performance.now();
  if(!/^ai_games_restore_[a-f0-9]{16}$/.test(targetDatabase))throw Error('Fresh independent restore database required');
  const manifest=await verifyBundle(backup,material);await compatible(manifest);
  const admin=await connect(adminUrl,caFile),url=new URL(migrationUrl);url.pathname='/'+targetDatabase;
  try{
    if(new URL(adminUrl).hostname!==url.hostname||new URL(adminUrl).port!==url.port)throw Error('Restore server mismatch');
    if(Math.floor(Number((await admin.query('SHOW server_version_num')).rows[0].server_version_num)/10000)!==Math.floor(Number(manifest.serverVersion)/10000))throw Error('PostgreSQL major version differs; separate upgrade procedure required');
    await admin.query(`CREATE DATABASE ${quote(targetDatabase)} OWNER owner_production`);
    await admin.query(`REVOKE ALL ON DATABASE ${quote(targetDatabase)} FROM PUBLIC`);
    await admin.query(`GRANT CONNECT ON DATABASE ${quote(targetDatabase)} TO migrate_production`);
  }finally{await admin.end();}
  await unpackBundle(backup,targetRoot,material);
  const connection=pgArguments(url.toString(),caFile);
  await runTool(join(pgBin,'pg_restore.exe'),[...connection.args,'--exit-on-error','--single-transaction','--no-owner','--no-acl','--role=owner_production',join(targetRoot,'database','database.dump')],connection.env);
  const c=await connect(url.toString(),caFile);
  try{
    await c.query('SET ROLE owner_production');
    if(JSON.stringify(await tableInventory(c))!==JSON.stringify(manifest.tables))throw Error('Restored table contents differ');
    await verifyReferences(c,join(targetRoot,'private'),join(targetRoot,'serving'));
    const security=await sanitizeRestored(c,material.sessionSecret,newSecret,[...manifest.ledger,...latestLedger]);
    await verifyReferences(c,join(targetRoot,'private'),join(targetRoot,'serving'));
    await grantRuntime(c);
    const report={format:1,verified:true,eligibleForCutover:false,targetDatabase,backupSnapshotAt:manifest.snapshotAt,
      elapsedMs:Math.round(performance.now()-started),security,
      requires:['authoritative deletion-ledger reconciliation','new service credentials and ACLs','isolated login/MFA and publication/play acceptance','explicit cutover approval'],
      sourceUntouched:true};
    await writeFile(join(targetRoot,'restore-report.json'),JSON.stringify(report,null,2),{flag:'wx'});return report;
  }finally{await c.end();}
}

async function main(){
  const [action,configFile]=process.argv.slice(2),config=JSON.parse(await readFile(configFile,'utf8'));
  if(action==='keys'){
    await runTool('pwsh.exe',['-NoProfile','-File',new URL('./production-storage-check.ps1',import.meta.url).pathname.replace(/^\/(.:)/,'$1'),'-Action','PrivateDirectory','-Root',dirname(config.recoveryMaterialFile)]);
    await createRecoveryMaterial(config.recoveryMaterialFile,process.env.SESSION_SECRET);
    console.log('Recovery material created in the reviewed private directory; store a separately controlled offline recovery copy. No key printed.');return;
  }
  const material=await recoveryMaterial(config.recoveryMaterialFile);
  if(action==='verify'){await verifyBundle(config.backup,material);console.log('Encrypted backup fully verified');return;}
  if(action==='restore'){
    const report=await restoreProduction({...config,material,adminUrl:process.env.PRODUCTION_ADMIN_URL,migrationUrl:process.env.PRODUCTION_MIGRATION_URL,newSecret:process.env.RESTORE_SESSION_SECRET});
    console.log(JSON.stringify(report));return;
  }
  if(action!=='backup')throw Error('Use backup, verify or restore');
  // Fail before reading source material unless all installed runtime processes
  // have exited. The supervisor owns the Jobs; do not trust a user-written flag.
  const assertStopped=()=>runTool('pwsh.exe',['-NoProfile','-File',new URL('./production-storage-check.ps1',import.meta.url).pathname.replace(/^\/(.:)/,'$1'),'-Action','Stopped','-Root',config.installationRoot]);
  const manifest=await backupProduction({...config,material,url:process.env.PRODUCTION_MIGRATION_URL,dumpUrl:process.env.PRODUCTION_BACKUP_URL,assertStopped});
  console.log(JSON.stringify({localBackupVerified:true,snapshotAt:manifest.snapshotAt,offDiskVerified:false}));
  await runTool('pwsh.exe',['-NoProfile','-File',new URL('./production-storage-check.ps1',import.meta.url).pathname.replace(/^\/(.:)/,'$1'),'-Action','DifferentDisk','-Root',config.installationRoot,'-Target',dirname(config.offDiskDestination)]);
  await copyBundle(config.destination,config.offDiskDestination,material);
  console.log(JSON.stringify({localBackupVerified:true,offDiskVerified:true,snapshotAt:manifest.snapshotAt}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(()=>{console.error('Backup/recovery refused or failed. No complete disaster-recovery claim; protected source and partial output retained.');process.exitCode=1;});
