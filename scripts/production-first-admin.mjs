import { randomBytes, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { connect } from './production-database.mjs';
import { hashPassword } from '../backend/src/modules/identity/crypto.mjs';

// Offline first-install operation; existing accounts are never adopted or reset.
export async function firstAdministrator(client,{email,passwordFile}) {
  if(!/^[a-z0-9._+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(email))throw Error('Administrator login email required');
  const identity=(await client.query('SELECT current_database() AS db,current_user AS role')).rows[0];
  if(identity.db!=='ai_games_production'||identity.role!=='migrate_production')throw Error('Production migration identity required');
  const password=randomBytes(24).toString('base64url'),id=randomUUID();
  await client.query('BEGIN');
  try {
    await client.query('SET LOCAL ROLE owner_production');
    await client.query('LOCK TABLE platform.accounts IN EXCLUSIVE MODE');
    if((await client.query('SELECT environment FROM platform.environment_identity')).rows[0]?.environment!=='production')throw Error('Wrong environment');
    if((await client.query('SELECT 1 FROM platform.accounts LIMIT 1')).rowCount)throw Error('First administrator requires empty accounts');
    await client.query("INSERT INTO platform.accounts(id,email,password_hash,status,nickname,roles) VALUES($1,$2,$3,'active','平台管理员',ARRAY['admin'])",[id,email.toLowerCase(),await hashPassword(password)]);
    await client.query("INSERT INTO platform.identity_events(id,actor_id,target_id,action,request_id,outcome) VALUES($1,NULL,$2,'registered',$3,'success'),($4,NULL,$2,'roles_changed',$3,'success')",[randomUUID(),id,randomUUID(),randomUUID()]);
    // Persist before commit: a file failure must not strand an unknown password.
    await writeFile(passwordFile,JSON.stringify({email:email.toLowerCase(),password,mfaEnrollmentRequired:true}),{flag:'wx',mode:0o600});
    await client.query('COMMIT');
  } catch(e) {await client.query('ROLLBACK');throw e;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  let client;
  try {
    if(process.env.CONFIRM_EMPTY_PRODUCTION_ADMIN!=='ai_games_production')throw Error('Explicit bootstrap acknowledgement required');
    const {runTool}=await import('./production-backup.mjs');
    await runTool('pwsh.exe',['-NoProfile','-File',resolve('scripts/production-storage-check.ps1'),'-Action','PrivateDirectory','-Root',resolve(process.argv[3],'..')]);
    await runTool('pwsh.exe',['-NoProfile','-File',resolve('scripts/production-storage-check.ps1'),'-Action','Stopped','-Root',process.env.PRODUCTION_INSTALLATION_ROOT]);
    client=await connect(process.env.PRODUCTION_MIGRATION_URL,process.env.DATABASE_CA_FILE);
    await firstAdministrator(client,{email:process.argv[2],passwordFile:process.argv[3]});
    console.log('First administrator created; password stays in protected local file. First login requires MFA enrollment.');
  } catch {console.error('First administrator bootstrap refused or failed; inspect protected installation evidence.');process.exitCode=1;}
  finally {await client?.end();}
}
