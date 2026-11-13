import pg from 'pg';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { migrationFiles } from '../backend/src/platform/migrations.mjs';

export const roles = Object.freeze({owner:'owner_production',migrator:'migrate_production',app:'app_production',backup:'backup_production'});
export const quote = value => '"' + value.replaceAll('"','""') + '"';
export const hash = value => createHash('sha256').update(value).digest('hex');
export async function connect(url, caFile) {
  const parsed = new URL(url);
  if (!['postgres:','postgresql:'].includes(parsed.protocol) || parsed.search || parsed.hash || !caFile) throw Error('Explicit verify-full connection required');
  const client = new pg.Client({connectionString:url,ssl:{rejectUnauthorized:true,ca:await readFile(caFile,'utf8')},connectionTimeoutMillis:5000});
  await client.connect();
  return client;
}
export async function releasePlan(url) {
  const u = new URL(url);
  if (u.pathname !== '/ai_games_production' || u.search || u.hash) throw Error('Production database required');
  const migrations = await migrationFiles();
  const pkg = JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
  return {format:1,host:u.hostname,port:u.port||'5432',database:'ai_games_production',version:pkg.version,
    roles,migrations:migrations.map(({id,checksum})=>({id,checksum})),destructiveRollback:false};
}
export async function applyRelease(client, plan, approval, {verifiedBackup} = {}) {
  if (approval !== hash(JSON.stringify(plan))) throw Error('Reviewed release digest required');
  const actual = (await client.query('SELECT current_database() AS db,current_user AS role')).rows[0];
  if (actual.db !== plan.database || actual.role !== roles.migrator) throw Error('Separate migration identity required');
  const migrations = await migrationFiles();
  if (JSON.stringify(plan.migrations) !== JSON.stringify(migrations.map(({id,checksum})=>({id,checksum})))) throw Error('Release source changed');
  await client.query('BEGIN');
  try {
    await client.query('SET LOCAL ROLE owner_production');
    if((await client.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND usename='app_production' AND pid<>pg_backend_pid()")).rowCount)throw Error('Application connections must be drained before migration');
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query('SELECT pg_advisory_xact_lock(432001)');
    await client.query(`CREATE TABLE IF NOT EXISTS public.schema_migrations(id text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
    const rows = (await client.query('SELECT id,checksum FROM public.schema_migrations ORDER BY id')).rows;
    if (rows.length > migrations.length || rows.some((r,i)=>r.id!==migrations[i].id||r.checksum!==migrations[i].checksum)) throw Error('Migration history mismatch');
    if (rows.length && (await client.query('SELECT environment FROM platform.environment_identity')).rows[0]?.environment !== 'production') throw Error('Wrong environment');
    if(rows.length && rows.length<migrations.length && (!verifiedBackup || verifiedBackup.database!==plan.database || JSON.stringify(verifiedBackup.migrations)!==JSON.stringify(rows)))throw Error('Verified pre-migration backup of current schema required');
    for (const m of migrations.slice(rows.length)) {
      await client.query(m.up);
      if (m.id === '001_foundation') await client.query("INSERT INTO platform.environment_identity(environment) VALUES('production')");
      await client.query('INSERT INTO public.schema_migrations(id,checksum) VALUES($1,$2)',[m.id,m.checksum]);
    }
    await grantRuntime(client);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
}
export async function grantRuntime(client) {
  await client.query(`REVOKE ALL ON SCHEMA public,platform FROM PUBLIC;
    REVOKE ALL ON ALL TABLES IN SCHEMA public,platform FROM PUBLIC,app_production,backup_production;
    REVOKE ALL ON ALL FUNCTIONS IN SCHEMA platform FROM PUBLIC;
    GRANT USAGE ON SCHEMA public,platform TO app_production,backup_production;
    GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA platform TO app_production;
    REVOKE INSERT,UPDATE,DELETE ON platform.environment_identity FROM app_production;
    REVOKE INSERT,UPDATE,DELETE ON platform.recovery_ledger FROM app_production;
    GRANT SELECT ON public.schema_migrations TO app_production;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA platform TO app_production;
    GRANT SELECT ON ALL TABLES IN SCHEMA public,platform TO backup_production;
    GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA platform TO app_production;
    GRANT SELECT ON ALL SEQUENCES IN SCHEMA platform TO backup_production;
    ALTER DEFAULT PRIVILEGES FOR ROLE owner_production IN SCHEMA platform REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;`);
}
// Bootstrap is separate from migration and never reads the development .env.
// It refuses existing roles/database, so a partial failure is inspected rather
// than silently adopting unrelated identities or changing their passwords.
export async function initialize(admin, passwords) {
  for (const name of ['migrator','app','backup']) if (!/^[a-f0-9]{64}$/.test(passwords[name]??'')) throw Error('Fresh random role credentials required');
  const existing = await admin.query("SELECT 1 FROM pg_roles WHERE rolname=ANY($1) UNION ALL SELECT 1 FROM pg_database WHERE datname='ai_games_production'",[Object.values(roles)]);
  if (existing.rowCount) throw Error('Existing production objects; use inspection/migrate, never bootstrap over them');
  await admin.query('BEGIN');
  try {
    await admin.query('CREATE ROLE owner_production NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS');
    for (const name of ['migrator','app','backup']) await admin.query(`CREATE ROLE ${roles[name]} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${passwords[name]}'`);
    await admin.query('GRANT owner_production TO migrate_production');
    await admin.query('GRANT pg_read_all_stats TO owner_production');
    await admin.query('COMMIT');
  } catch(e) { await admin.query('ROLLBACK'); throw e; }
  await admin.query('CREATE DATABASE ai_games_production OWNER owner_production');
  await admin.query('REVOKE ALL ON DATABASE ai_games_production FROM PUBLIC');
  await admin.query('GRANT CONNECT ON DATABASE ai_games_production TO migrate_production,app_production,backup_production');
}

async function main() {
  const [action,file] = process.argv.slice(2), url = process.env.PRODUCTION_MIGRATION_URL;
  const plan = await releasePlan(url);
  if (action === 'plan') { await writeFile(file,JSON.stringify(plan,null,2),{flag:'wx'}); console.log(`Review digest: ${hash(JSON.stringify(plan))}`); return; }
  const reviewed = JSON.parse(await readFile(file,'utf8'));
  if (JSON.stringify(reviewed)!==JSON.stringify(plan) || process.env.APPROVED_RELEASE_SHA256!==hash(JSON.stringify(plan))) throw Error('Reviewed plan differs');
  let client;
  try {
    if (action==='initialize') {
      client=await connect(process.env.PRODUCTION_ADMIN_URL,process.env.DATABASE_CA_FILE);
      const adminUrl=new URL(process.env.PRODUCTION_ADMIN_URL),target=new URL(url);
      if(adminUrl.hostname!==target.hostname||adminUrl.port!==target.port||adminUrl.pathname!=='/postgres')throw Error('Admin target differs');
      await initialize(client,{migrator:decodeURIComponent(target.password),app:process.env.PRODUCTION_APP_PASSWORD,backup:process.env.PRODUCTION_BACKUP_PASSWORD});
    } else if(action==='migrate') {
      if(!process.env.PRODUCTION_INSTALLATION_ROOT)throw Error('Reviewed stopped installation required');
      const {runTool}=await import('./production-backup.mjs');
      const {fileURLToPath}=await import('node:url');
      await runTool('pwsh.exe',['-NoProfile','-File',fileURLToPath(new URL('./production-storage-check.ps1',import.meta.url)),'-Action','Stopped','-Root',process.env.PRODUCTION_INSTALLATION_ROOT]);
      let verifiedBackup;
      if(process.env.PRE_MIGRATION_BACKUP){
        const {verifyBundle,recoveryMaterial}=await import('./recovery-store.mjs');
        verifiedBackup=await verifyBundle(process.env.PRE_MIGRATION_BACKUP,await recoveryMaterial(process.env.RECOVERY_MATERIAL_FILE));
      }
      client=await connect(url,process.env.DATABASE_CA_FILE);
      await applyRelease(client,reviewed,process.env.APPROVED_RELEASE_SHA256,{verifiedBackup});
    } else throw Error('Use plan, initialize or migrate');
    console.log('Controlled database operation verified; no application started.');
  } finally { await client?.end(); }
}
if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) main().catch(()=>{console.error('Production database operation refused or failed; inspect protected evidence. Credentials omitted.');process.exitCode=1;});
