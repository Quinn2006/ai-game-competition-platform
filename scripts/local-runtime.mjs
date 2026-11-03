import { mkdir, readFile, writeFile, lstat, readdir, copyFile } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import pg from 'pg';

const root=fileURLToPath(new URL('../',import.meta.url));
const data=join(root,'data'), cluster=join(data,'postgres');
const toolsFile=join(data,'local-tools.json');
const localTools=existsSync(toolsFile)?JSON.parse(readFileSync(toolsFile,'utf8')):{};
const legacyBin=join(root,'tmp/phase2-postgres/runtime/pgsql/bin');
const bin=process.env.PG_BIN || localTools.pgBin || (existsSync(legacyBin)?legacyBin:'');
const pgCommand=name=>bin?join(bin,name+(process.platform==='win32'?'.exe':'')):name;
const action=process.argv[2];
const stamp=()=>new Date().toISOString().replace(/[:.]/g,'-');
function run(name,args,env={}) {
  const command=name==='icacls'?name:pgCommand(name);
  const result=spawnSync(command,args,{encoding:'utf8',windowsHide:true,stdio:'ignore',env:{...process.env,...env},timeout:120000});
  if(result.error || result.status!==0) throw Error(`${name} failed; exit ${result.status}. No credentials printed.`);
  return result.stdout;
}
async function exists(path){try{await lstat(path);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}
async function privateDirectory(path){
  await mkdir(path,{recursive:true,mode:0o700});
  if((await lstat(path)).isSymbolicLink())throw Error('Symlink/junction refused');
  if(process.platform==='win32'){
    const account=`${process.env.USERDOMAIN}\\${process.env.USERNAME}`;
    run('icacls',[path,'/inheritance:r','/grant:r',`${account}:(OI)(CI)F`,'*S-1-5-18:(OI)(CI)F','*S-1-5-32-544:(OI)(CI)F']);
  }
}
function connection(value){
  const u=new URL(value);
  if(u.hostname!=='127.0.0.1'||u.pathname!=='/ai_games_development')throw Error('Local development source required');
  return {args:['-h','127.0.0.1','-p',u.port,'-U',decodeURIComponent(u.username)],env:{PGPASSWORD:decodeURIComponent(u.password)},database:u.pathname.slice(1)};
}
async function state(path=join(data,'credentials.json')){return JSON.parse(await readFile(path,'utf8'));}
async function start(){
  const s=await state(),u=new URL(s.databaseDevelopment);
  if(!await exists(join(cluster,'PG_VERSION')))throw Error('Initialize the fixed instance first');
  const status=spawnSync(pgCommand('pg_ctl'),['-D',cluster,'status'],{windowsHide:true,stdio:'ignore'});
  if(status.status!==0)run('pg_ctl',['-D',cluster,'-l',join(data,'postgres.log'),'-o',`-p ${u.port} -h 127.0.0.1`,'-w','start']);
}
export async function copyTree(source,target){
  const info=await lstat(source);if(info.isSymbolicLink())throw Error('Symlink/junction refused');
  if(info.isDirectory()){
    await mkdir(target,{recursive:true,mode:0o700});
    if((await lstat(target)).isSymbolicLink())throw Error('Target link refused');
    for(const name of await readdir(source))await copyTree(join(source,name),join(target,name));
  }else if(info.isFile()){
    const bytes=await readFile(source);
    if(await exists(target)){
      if((await lstat(target)).isSymbolicLink()||!(await readFile(target)).equals(bytes))throw Error('Existing file differs; refusing overwrite');
    }else await copyFile(source,target,1);
    if(!(await readFile(target)).equals(bytes))throw Error('File verification failed');
  }else throw Error('Unsupported file type');
}
async function inventory(url){
  const c=new pg.Client({connectionString:url});await c.connect();
  try{
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const tables=(await c.query("SELECT schemaname,tablename FROM pg_tables WHERE schemaname IN ('platform','public') ORDER BY 1,2")).rows;
    const result={};
    for(const t of tables){
      const quote=s=>'"'+s.replaceAll('"','""')+'"';
      const rows=(await c.query(`SELECT row_to_json(t)::text AS row FROM ${quote(t.schemaname)}.${quote(t.tablename)} t ORDER BY row_to_json(t)::text COLLATE "C"`)).rows;
      result[t.schemaname+'.'+t.tablename]={count:rows.length,sha256:createHash('sha256').update(rows.map(r=>r.row).join('\n')).digest('hex')};
    }
    await c.query('COMMIT');return result;
  }finally{await c.end();}
}
async function fileInventory(path,prefix=''){
  const result={};
  for(const name of (await readdir(path)).sort()){
    const file=join(path,name),s=await lstat(file),key=prefix+name;
    if(s.isSymbolicLink())throw Error('Backup links refused');
    if(s.isDirectory())Object.assign(result,await fileInventory(file,key+'/'));
    else if(s.isFile())result[key]=createHash('sha256').update(await readFile(file)).digest('hex');
    else throw Error('Unsupported backup entry');
  }
  return result;
}
async function main(){
  if(action==='init'){
    if(await exists(join(data,'credentials.json'))||await exists(join(cluster,'PG_VERSION'))||await exists(join(root,'.env')))throw Error('Existing configuration/cluster; refusing initialization');
    await privateDirectory(data);
    for(const name of ['postgres','submissions/development/incoming','submissions/development/quarantine','submissions/development/review','submissions/development/release','backups','exports'])await privateDirectory(join(data,name));
    const password=randomBytes(32).toString('hex'),sessionSecret=randomBytes(32).toString('hex');
    const port=Number(process.env.LOCAL_PG_PORT||55440);if(!Number.isInteger(port)||port<1024||port>65535)throw Error('Invalid port');
    const pw=join(data,'init-password.tmp');await writeFile(pw,password,{flag:'wx',mode:0o600});
    run('initdb',['-D',cluster,'-U','app_admin','--pwfile='+pw,'--auth=scram-sha-256','--encoding=UTF8','--locale=C']);
    const url=`postgres://app_development:${password}@127.0.0.1:${port}/ai_games_development`;
    const s={state:data,databaseDevelopment:url,sessionSecret,adminUser:'app_admin'};
    await writeFile(join(data,'credentials.json'),JSON.stringify(s,null,2),{flag:'wx',mode:0o600});
    await start();
    const c=new pg.Client({host:'127.0.0.1',port,user:'app_admin',password,database:'postgres'});await c.connect();
    try{await c.query(`CREATE ROLE app_development LOGIN PASSWORD '${password}'`);await c.query('CREATE DATABASE ai_games_development OWNER app_development');}finally{await c.end();}
    await writeFile(join(root,'.env'),`APP_ENV=development\nDATABASE_URL=${url}\nSESSION_SECRET=${sessionSecret}\nLOCAL_GAMES=1\nSUBMISSIONS_ROOT=data/submissions\nEXPORTS_ROOT=data/exports\n`,{flag:'wx',mode:0o600});
    if(process.platform==='win32')run('icacls',[join(root,'.env'),'/inheritance:r','/grant:r',`${process.env.USERDOMAIN}\\${process.env.USERNAME}:F`,'*S-1-5-18:F','*S-1-5-32-544:F']);
    console.log('Fixed local instance initialized. Existing instances untouched.');
  }else if(action==='start'){await start();console.log('Fixed instance ready');}
  else if(action==='stop'){run('pg_ctl',['-D',cluster,'-m','fast','-w','stop']);console.log('Fixed instance stopped');}
  else if(action==='backup'){
    // Stop application writes before invoking: database and files must form one consistent set.
    const s=await state(process.argv[3]?resolve(process.argv[3],'credentials.json'):undefined),con=connection(s.databaseDevelopment);
    await privateDirectory(join(data,'backups'));
    const out=join(data,'backups',stamp());await privateDirectory(out);
    const before=await inventory(s.databaseDevelopment);
    run('pg_dump',[...con.args,'-Fc','--no-owner','--no-acl','-f',join(out,'database.dump'),con.database],con.env);
    const source=resolve(process.argv[4]||join(data,'submissions'));
    if(!await exists(source))throw Error('Submission source missing');
    await copyTree(source,join(out,'submissions'));
    const after=await inventory(s.databaseDevelopment);
    if(JSON.stringify(before)!==JSON.stringify(after))throw Error('Database changed during backup; stop writers and retry');
    await writeFile(join(out,'manifest.json'),JSON.stringify({format:1,tables:before,files:await fileInventory(join(out,'submissions')),createdAt:new Date().toISOString(),dumpSha256:createHash('sha256').update(await readFile(join(out,'database.dump'))).digest('hex')},null,2),{flag:'wx',mode:0o600});
    // Preserve the encryption key needed for existing MFA secrets, under private backup ACL.
    await writeFile(join(out,'credentials.json'),JSON.stringify(s),{flag:'wx',mode:0o600});
    console.log(out);
  }else if(action==='restore'||action==='restore-check'){
    const out=resolve(process.argv[3]||'');
    const rel=relative(join(data,'backups'),out);if(!rel||rel.startsWith('..')||isAbsolute(rel))throw Error('Choose a backup inside data/backups');
    const manifest=JSON.parse(await readFile(join(out,'manifest.json'),'utf8'));
    if(manifest.format!==1||createHash('sha256').update(await readFile(join(out,'database.dump'))).digest('hex')!==manifest.dumpSha256)throw Error('Backup checksum mismatch');
    if(JSON.stringify(await fileInventory(join(out,'submissions')))!==JSON.stringify(manifest.files))throw Error('Backup files mismatch');
    const s=await state(),con=connection(s.databaseDevelopment);
    if(action==='restore-check'){
      const url=new URL(s.databaseDevelopment),name='ai_games_restore_'+Date.now();
      const admin=new pg.Client({host:url.hostname,port:+url.port,user:s.adminUser,password:url.password,database:'postgres'});await admin.connect();
      try{await admin.query(`CREATE DATABASE ${name} OWNER app_development`);}finally{await admin.end();}
      run('pg_restore',[...con.args,'--exit-on-error','--single-transaction','--no-owner','--no-acl','-d',name,join(out,'database.dump')],con.env);
      url.pathname='/'+name;
      if(JSON.stringify(await inventory(url.toString()))!==JSON.stringify(manifest.tables))throw Error('Restore check differs');
      console.log(`Restore verified in separate database ${name}; main database untouched.`);return;
    }
    if(Object.keys(await inventory(s.databaseDevelopment)).length)throw Error('Restore requires an empty target; existing data is never overwritten');
    run('pg_restore',[...con.args,'--exit-on-error','--single-transaction','--no-owner','--no-acl','-d',con.database,join(out,'database.dump')],con.env);
    if(JSON.stringify(await inventory(s.databaseDevelopment))!==JSON.stringify(manifest.tables))throw Error('Restored rows differ');
    await copyTree(join(out,'submissions'),join(data,'submissions'));
    const old=await state(join(out,'credentials.json'));
    for(const path of [join(data,'credentials.json'),join(root,'.env')])await copyFile(path,path+'.'+stamp()+'.bak',1);
    s.sessionSecret=old.sessionSecret;
    await writeFile(join(data,'credentials.json'),JSON.stringify(s,null,2));
    const env=await readFile(join(root,'.env'),'utf8');await writeFile(join(root,'.env'),env.replace(/^SESSION_SECRET=.*$/m,'SESSION_SECRET='+s.sessionSecret));
    console.log('Restore verified: all table counts and row hashes match; files copied and verified.');
  }else if(action==='verify'){
    const s=await state();console.log(JSON.stringify(await inventory(s.databaseDevelopment),null,2));
  }else throw Error('Usage: local-runtime.mjs init|start|stop|backup [source-state source-submissions]|restore|restore-check backup-directory|verify');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(()=>{console.error('Local runtime operation failed. Existing source data retained; inspect configuration, permissions and service status.');process.exitCode=1;});
