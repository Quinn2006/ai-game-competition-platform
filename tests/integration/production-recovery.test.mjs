import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, cp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { request } from 'node:http';
import pg from 'pg';
import { initialize, connect, releasePlan, applyRelease, hash } from '../../scripts/production-database.mjs';
import { backupProduction, restoreProduction, runTool, tableInventory } from '../../scripts/production-backup.mjs';
import { createRecoveryMaterial, verifyBundle } from '../../scripts/recovery-store.mjs';
import { assertApplicationRole, createDatabase } from '../../backend/src/platform/database.mjs';
import { loadConfig } from '../../backend/src/config.mjs';
import { startServer } from '../../backend/src/server.mjs';
import { createProductionLocalStorageDriver } from '../../backend/src/platform/production-local-storage.mjs';
import { createPrivateStorage } from '../../backend/src/platform/storage.mjs';
import { hashPassword, seal, totp, newToken, digest, unseal } from '../../backend/src/modules/identity/crypto.mjs';
import { createIdentityService } from '../../backend/src/modules/identity/service.mjs';
import { isolatedFixture } from '../isolation-fixture.mjs';
import { zipFixture } from '../zip-fixture.mjs';
import { switchDatabase } from '../../scripts/production-cutover.mjs';

test('disposable production TLS, least privilege, real scan/publish, encrypted backup and independent recovery',{
  skip:process.env.RUN_PRODUCTION_RECOVERY!=='1',timeout:240000,
},async()=>{
  const root=resolve('tmp','production-recovery-'+randomUUID());await mkdir(root);
  const pgBin=resolve('tmp/phase2-postgres/runtime/pgsql/bin'),openssl='C:\\Program Files\\Git\\usr\\bin\\openssl.exe';
  const port=55680,ca=join(root,'ca.pem'),cluster=join(root,'postgres');
  const passwords=Object.fromEntries(['admin','migrator','app','backup'].map(k=>[k,randomBytes(32).toString('hex')]));
  const url=(role,database='ai_games_production')=>`postgres://${role==='admin'?'acceptance_admin':role==='migrator'?'migrate_production':role+'_production'}:${passwords[role]}@127.0.0.1:${port}/${database}`;
  const originalSecret=randomBytes(32).toString('hex'),newSecret=randomBytes(32).toString('hex');
  let started=false,scanner,admin,migrator,runtime,separate,appPool,serviceConfig,serviceRegistered=false;
  const evidence={root,startedAt:new Date().toISOString(),passed:false};
  async function serviceTool(args,label){
    const child=spawn('pwsh.exe',args,{windowsHide:true,stdio:['ignore','pipe','pipe']});
    const chunks=[];child.stdout.on('data',c=>chunks.push(c));child.stderr.on('data',c=>chunks.push(c));
    const [code]=await once(child,'exit');
    await writeFile(join(root,label+'.log'),Buffer.concat(chunks));
    if(code!==0)throw Error('Service '+label+' failed; protected diagnostic log retained');
  }
  try{
    // Every path is new under tmp. No service/account/ACL/WFP installation and
    // no access to the existing cluster or tunnel configuration occurs here.
    await runTool(openssl,['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(root,'ca.key'),'-out',ca,'-days','2','-subj','/CN=AGP disposable acceptance CA']);
    await runTool(openssl,['req','-newkey','rsa:2048','-nodes','-keyout',join(root,'server.key'),'-out',join(root,'server.csr'),'-subj','/CN=localhost']);
    await writeFile(join(root,'extensions.cnf'),'subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n');
    await runTool(openssl,['x509','-req','-in',join(root,'server.csr'),'-CA',ca,'-CAkey',join(root,'ca.key'),'-CAcreateserial','-out',join(root,'server.crt'),'-days','2','-extfile',join(root,'extensions.cnf')]);
    await writeFile(join(root,'password.tmp'),passwords.admin,{flag:'wx'});
    await runTool(join(pgBin,'initdb.exe'),['-D',cluster,'-U','acceptance_admin','--pwfile='+join(root,'password.tmp'),'--auth=scram-sha-256','--encoding=UTF8','--locale=C']);
    await writeFile(join(root,'server.conf'),`data_directory='${cluster.replaceAll('\\','/')}'\nport=${port}\nlisten_addresses='127.0.0.1'\nssl=on\nssl_cert_file='${join(root,'server.crt').replaceAll('\\','/')}'\nssl_key_file='${join(root,'server.key').replaceAll('\\','/')}'\n`);
    if(process.env.RUN_PRODUCTION_RECOVERY_SERVICE==='1'){
      serviceConfig=join(root,'service-config.json');
      const serviceName='AGP-PostgreSQL-Acceptance';
      await writeFile(serviceConfig,JSON.stringify({databaseDirectory:cluster,databaseService:serviceName,pgBin,databaseControlRoot:join(root,'service-control'),databasePort:port,serverCertificate:join(root,'server.crt'),serverPrivateKey:join(root,'server.key')}));
      await runTool('pwsh.exe',['-NoProfile','-Command',"if(Get-Service -Name AGP-PostgreSQL-Acceptance -ErrorAction SilentlyContinue){throw 'Existing service refused'}"]);
      await serviceTool(['-NoProfile','-File',resolve('scripts/production-postgres.ps1'),'-Action','Prepare','-ConfigFile',serviceConfig],'prepare');
      serviceRegistered=true; // Own the rollback obligation even if Register fails partway.
      await serviceTool(['-NoProfile','-File',resolve('scripts/production-postgres.ps1'),'-Action','Register','-ConfigFile',serviceConfig],'register');
      await serviceTool(['-NoProfile','-Command',`$ErrorActionPreference='Stop'; Start-Service -Name ${serviceName}; (Get-Service -Name ${serviceName}).WaitForStatus('Running',[TimeSpan]::FromSeconds(30))`],'start-service');
      started=true;evidence.windowsService=true;
    }else{
      await runTool(join(pgBin,'pg_ctl.exe'),['-D',cluster,'-l',join(root,'postgres.log'),'-o',`-c config_file="${join(root,'server.conf')}"`,'-w','start']);started=true;
    }
    admin=await connect(url('admin','postgres'),ca);await initialize(admin,passwords);
    migrator=await connect(url('migrator'),ca);const plan=await releasePlan(url('migrator'));
    await assert.rejects(applyRelease(migrator,plan,'unapproved'));
    await applyRelease(migrator,plan,hash(JSON.stringify(plan)));await applyRelease(migrator,plan,hash(JSON.stringify(plan)));
    await assert.rejects(initialize(admin,passwords));
    const tls=(await migrator.query('SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()')).rows[0];assert.equal(tls.ssl,true);
    const bad=new pg.Client({connectionString:url('app'),ssl:{rejectUnauthorized:true,ca:await readFile(ca,'utf8'),servername:'wrong.invalid'}});
    await assert.rejects(bad.connect());await bad.end().catch(()=>{});
    const untrusted=new pg.Client({connectionString:url('app'),ssl:{rejectUnauthorized:true}});await assert.rejects(untrusted.connect());await untrusted.end().catch(()=>{});
    appPool=createDatabase({databaseUrl:url('app'),databaseTls:'verify-full',databaseCaFile:ca},()=>{});await assertApplicationRole(appPool);
    for(const sql of ['CREATE TABLE platform.forbidden(id int)','CREATE ROLE forbidden','UPDATE platform.environment_identity SET environment=\'test\'','DELETE FROM public.schema_migrations','DELETE FROM platform.recovery_ledger'])await assert.rejects(appPool.query(sql),{code:'42501'});
    const backupClient=await connect(url('backup'),ca);await assert.rejects(backupClient.query("DELETE FROM platform.accounts"),{code:'42501'});await backupClient.end();
    evidence.tlsAndRoles=true;
    await migrator.query('SET ROLE owner_production');
    const authorId=randomUUID(),adminId=randomUUID(),mfa=randomBytes(20),password='Synthetic acceptance password 729!';
    const stored=await hashPassword(password);
    for(const [id,email,roles,mfaValue] of [[authorId,'author@example.com',[],null],[adminId,'admin@example.com',['admin'],seal(mfa,originalSecret,adminId)]]){
      await migrator.query("INSERT INTO platform.accounts(id,email,password_hash,status,nickname,roles,mfa_secret) VALUES($1,$2,$3,'active',$4,$5,$6)",[id,email,stored,email,roles,mfaValue]);
    }
    const identity=createIdentityService({database:appPool,secret:originalSecret,localAccounts:true});
    const author=await identity.run('login',{email:'author@example.com',password},{requestId:randomUUID(),address:'acceptance-author'});
    const moderator=await identity.run('login',{email:'admin@example.com',password,code:totp(mfa)},{requestId:randomUUID(),address:'acceptance-admin'});
    const privateRoot=join(root,'private');await mkdir(privateRoot);
    const sid='S-1-5-21-1123157113-573781608-2536295357-1001';
    const config={...loadConfig({APP_ENV:'production',MAIN_ORIGIN:'https://main.example.com',GAME_ORIGIN:'https://game.example.net',DATABASE_URL:url('app'),DATABASE_CA_FILE:ca,SESSION_SECRET:originalSecret,PRIVATE_STORAGE_DRIVER:'local',PRIVATE_STORAGE_ROOT:privateRoot,PRIVATE_STORAGE_TRUST_ROOT:privateRoot,PRIVATE_STORAGE_ACCOUNT:sid,CLAMD_PORT:'3311'}),port:0,gameListenOrigin:'http://127.0.0.2:0'};
    const inspect=paths=>({identitySid:sid,accountSid:sid,results:paths.map(path=>({path,protected:true,owner:sid,aces:[sid,'S-1-5-18','S-1-5-32-544'].map(sid=>({sid,allow:true,inherited:false,rights:2032127}))}))});
    const storage=createPrivateStorage(config,createProductionLocalStorageDriver(config,{aclProbe:{inspect,inspectAsync:async p=>inspect(p)}}));
    const scannerConfig=join(root,'clamd.conf');
    await writeFile(scannerConfig,`DatabaseDirectory ${resolve('tmp/phase3-clamav/database')}\nTCPSocket 3311\nTCPAddr 127.0.0.1\nForeground yes\nStreamMaxLength 300000000\nMaxThreads 2\nMaxQueue 4\n`);
    scanner=spawn(resolve('tmp/phase3-clamav/runtime/clamav-1.5.4.win.x64/clamd.exe'),['--config-file='+scannerConfig],{windowsHide:true,stdio:'ignore'});
    const isolationRoot=join(root,'isolation');await mkdir(isolationRoot);separate=await isolatedFixture(isolationRoot,config);
    await separate.launch('validator');runtime=await startServer({config,database:appPool,storage,isolation:separate.runtime,log:()=>{}});
    let game=await separate.launch('game');
    const call=(path,body,token,gameRequest=false)=>new Promise((resolve,reject)=>{
      const address=gameRequest?game.status.address:runtime.app.address(),bytes=body===undefined?undefined:Buffer.isBuffer(body)?body:Buffer.from(JSON.stringify(body));
      const req=request({host:address.address,port:address.port,path,method:bytes?'POST':'GET',headers:{Host:gameRequest?'game.example.net':'main.example.com',...(token?{Cookie:'__Host-session='+token}:{}),...(bytes?{Origin:config.mainOrigin,'Content-Type':Buffer.isBuffer(body)?'application/octet-stream':'application/json'}:{})}},res=>{
        const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>{let value=Buffer.concat(chunks).toString();try{value=JSON.parse(value);}catch{}resolve({status:res.statusCode,value});});
      });req.on('error',reject);req.end(bytes);
    });
    const ok=r=>{assert.equal(r.status,200,JSON.stringify(r.value));return r.value;};
    const work=ok(await call('/api/games/create',{title:'Recovery acceptance'},author.sessionToken));
    ok(await call('/api/discovery/edit',{workId:work.id,title:'Recovery acceptance',summary:'Durable summary',instructions:'Click',category:'益智',tags:[],cover:''},author.sessionToken));
    const bytes=zipFixture([['index.html','<h1>Recovery verified</h1>']]);
    const upload=ok(await call('/api/games/upload-start',{workId:work.id,size:bytes.length,licensed:true,orientation:'landscape',saveVersion:'v1',domains:[]},author.sessionToken));
    ok(await call('/api/games/upload-chunk?uploadId='+upload.uploadId+'&offset=0',bytes,author.sessionToken));
    const version=ok(await call('/api/games/upload-finish',{uploadId:upload.uploadId},author.sessionToken));
    assert.equal(version.scan,'clean');assert.equal((await call('/api/games/play?work='+work.id)).status,404);
    ok(await call('/api/games/claim',{workId:work.id,versionId:version.id},moderator.sessionToken));
    ok(await call('/api/games/decide',{workId:work.id,versionId:version.id,status:'approved',reason:'Verified fixture',findingsReviewed:true},moderator.sessionToken));
    const play=ok(await call('/api/games/play?work='+work.id));assert.equal((await call(new URL(play.src).pathname,undefined,undefined,true)).status,200);
    await runtime.stop();runtime=null;appPool=null;await separate.stop();
    const deletedLater=randomUUID(),chatId=randomUUID(),providerKey=randomUUID();
    await migrator.query("INSERT INTO platform.accounts(id,email,password_hash,status) VALUES($1,'deleted-later@example.com',$2,'active')",[deletedLater,stored]);
    await migrator.query('INSERT INTO platform.support_chats(id,account_id,question,answer,provider_key) VALUES($1,$2,$3,$4,$5)',[chatId,deletedLater,'synthetic question','synthetic answer',providerKey]);
    await migrator.query("INSERT INTO platform.identity_tokens(token_hash,account_id,purpose,expires_at) VALUES($1,$2,'recovery',CURRENT_TIMESTAMP+interval '1 year')",[digest(newToken()),authorId]);
    const material=await createRecoveryMaterial(join(root,'recovery-material.json'),originalSecret),destination=join(root,'backup');
    const manifest=await backupProduction({url:url('migrator'),dumpUrl:url('backup'),caFile:ca,pgBin,privateRoot,servingRoot:separate.runtime.servingRoot,staging:join(root,'dump-staging'),destination,material,assertStopped:async()=>{assert.equal(runtime,null);}});
    assert.equal(manifest.migrations.length,12);await verifyBundle(destination,material);
    await migrator.query("UPDATE platform.accounts SET status='deleted',email=NULL,password_hash=NULL,mfa_secret=NULL WHERE id=$1",[deletedLater]);
    await migrator.query('DELETE FROM platform.support_chats WHERE id=$1',[chatId]);
    const latestLedger=(await migrator.query('SELECT kind,id,occurred_at FROM platform.recovery_ledger ORDER BY kind,id')).rows;
    const sourceAfterDeletion=await tableInventory(migrator);
    const targetDatabase='ai_games_restore_'+randomBytes(8).toString('hex'),targetRoot=join(root,'restored');
    const report=await restoreProduction({backup:destination,targetRoot,targetDatabase,adminUrl:url('admin','postgres'),migrationUrl:url('migrator'),caFile:ca,pgBin,material,newSecret,latestLedger});
    assert.equal(report.verified,true);assert.equal(report.eligibleForCutover,false);assert.equal(report.security.mfaAccounts,1);
    assert.deepEqual(await tableInventory(migrator),sourceAfterDeletion,'source unchanged by independent recovery');
    const restored=await connect(url('migrator',targetDatabase),ca);await restored.query('SET ROLE owner_production');
    assert.equal((await restored.query('SELECT count(*) FROM platform.sessions')).rows[0].count,'0');
    assert.equal((await restored.query('SELECT count(*) FROM platform.identity_tokens')).rows[0].count,'0');
    assert.equal((await restored.query('SELECT status FROM platform.accounts WHERE id=$1',[deletedLater])).rows[0].status,'deleted');
    assert.equal((await restored.query('SELECT 1 FROM platform.support_chats WHERE id=$1',[chatId])).rowCount,0);
    assert.equal((await restored.query('SELECT 1 FROM platform.support_deletions WHERE provider_key=$1',[providerKey])).rowCount,1);
    const factor=(await restored.query('SELECT mfa_secret FROM platform.accounts WHERE id=$1',[adminId])).rows[0].mfa_secret;
    assert.deepEqual(unseal(factor,newSecret,adminId),mfa);assert.throws(()=>unseal(factor,originalSecret,adminId));
    await restored.query('RESET ROLE');await restored.end();
    // The independent target is not granted app CONNECT until an explicit
    // acceptance step here. Formal restoration intentionally leaves it closed.
    await admin.query(`GRANT CONNECT ON DATABASE "${targetDatabase}" TO app_production`);
    const restoredPool=new pg.Pool({connectionString:url('app',targetDatabase),ssl:{rejectUnauthorized:true,ca:await readFile(ca,'utf8')}});
    const restoredIdentity=createIdentityService({database:restoredPool,secret:newSecret,localAccounts:true});
    await assert.rejects(restoredIdentity.run('me',{}, {requestId:randomUUID(),sessionToken:author.sessionToken}));
    const login=await restoredIdentity.run('login',{email:'author@example.com',password},{requestId:randomUUID(),address:'recovered-author'});assert.ok(login.sessionToken);
    // Use the next accepted TOTP step without resetting the replay counter.
    const adminLogin=await restoredIdentity.run('login',{email:'admin@example.com',password,code:totp(mfa,Date.now()+30000)},{requestId:randomUUID(),address:'recovered-admin'});assert.ok(adminLogin.sessionToken);
    const recoveredConfig={...config,sessionSecret:newSecret,databaseUrl:url('app',targetDatabase),storage:{...config.storage,root:join(targetRoot,'private'),trustRoot:join(targetRoot,'private')}};
    const recoveredStorage=createPrivateStorage(recoveredConfig,createProductionLocalStorageDriver(recoveredConfig,{aclProbe:{inspect,inspectAsync:async p=>inspect(p)}}));
    const recoveredIsolation=join(root,'restored-isolation');await mkdir(recoveredIsolation);
    separate=await isolatedFixture(recoveredIsolation,recoveredConfig,{servingRoot:join(targetRoot,'serving')});
    await separate.launch('validator');runtime=await startServer({config:recoveredConfig,database:restoredPool,storage:recoveredStorage,isolation:separate.runtime,log:()=>{}});
    game=await separate.launch('game');
    assert.equal((await call('/api/identity/me',undefined,author.sessionToken)).status,401);
    assert.equal((await call('/api/identity/me',undefined,login.sessionToken)).status,200);
    const recoveredPlay=ok(await call('/api/games/play?work='+work.id));
    assert.equal((await call(new URL(recoveredPlay.src).pathname,undefined,undefined,true)).status,200);
    assert.equal((await call(new URL(play.src).pathname,undefined,undefined,true)).status,404,'old play ticket absent after restart');
    const tombstoneId=randomUUID();await migrator.query("INSERT INTO platform.accounts(id,status) VALUES($1,'deleted')",[tombstoneId]);
    assert.equal((await migrator.query("SELECT 1 FROM platform.recovery_ledger WHERE kind='account' AND id=$1",[tombstoneId])).rowCount,1);
    const {createUploadService}=await import('../../backend/src/modules/uploads/service.mjs');
    const recoveredUploads=createUploadService({database:restoredPool,identity:restoredIdentity});
    assert.equal((await recoveredUploads.published(work.id)).id,version.id);
    const manager=await connect(url('migrator',targetDatabase),ca);await manager.query('SET ROLE owner_production');
    await manager.query('UPDATE platform.game_versions SET revoked=true WHERE id=$1',[version.id]);await manager.query('UPDATE platform.works SET published_version=NULL WHERE id=$1',[work.id]);
    await assert.rejects(recoveredUploads.published(work.id));
    assert.equal((await call(new URL(recoveredPlay.src).pathname,undefined,undefined,true)).status,404);
    await manager.end();await runtime.stop();runtime=null;await separate.stop();
    const damaged=join(root,'damaged');await cp(destination,damaged,{recursive:true});await writeFile(join(damaged,'00000000.enc'),'broken');
    await assert.rejects(restoreProduction({backup:damaged,targetRoot:join(root,'must-not-exist'),targetDatabase:'ai_games_restore_'+randomBytes(8).toString('hex'),adminUrl:url('admin','postgres'),migrationUrl:url('migrator'),caFile:ca,pgBin,material,newSecret}));
    const switchPlan={format:1,action:'switch',restoredDatabase:targetDatabase,rollbackDatabase:'ai_games_rollback_'+randomBytes(8).toString('hex')};
    await assert.rejects(switchDatabase(admin,switchPlan,hash(JSON.stringify(switchPlan))),/clients/);
    await migrator.end();migrator=null;
    await switchDatabase(admin,switchPlan,hash(JSON.stringify(switchPlan)));
    const switched=await connect(url('app'),ca);assert.equal((await switched.query('SELECT published_version FROM platform.works WHERE id=$1',[work.id])).rows[0].published_version,null);await switched.end();
    const rollbackPlan={...switchPlan,action:'rollback'};await switchDatabase(admin,rollbackPlan,hash(JSON.stringify(rollbackPlan)));
    const rolledBack=await connect(url('app'),ca);assert.equal((await rolledBack.query('SELECT published_version FROM platform.works WHERE id=$1',[work.id])).rows[0].published_version,version.id);await rolledBack.end();
    evidence.cutoverRollback=true;evidence.laterDeletionOverlay=true;
    evidence.passed=true;evidence.restore=report;evidence.realScanner=true;evidence.sourceSnapshotAt=manifest.snapshotAt;
    evidence.scope=serviceRegistered?'real PostgreSQL virtual-identity service; same-user application and injected application ACL; not dedicated application supervisor or public acceptance':'same-user disposable TLS/ClamAV/HTTP; ACL probe injected; not system service or public acceptance';
  }finally{
    if(runtime)await runtime.stop().catch(()=>{});else await appPool?.end().catch(()=>{});
    await separate?.stop().catch(()=>{});await migrator?.end().catch(()=>{});await admin?.end().catch(()=>{});
    if(scanner&&scanner.exitCode===null){const stopped=once(scanner,'exit');scanner.kill();await stopped;}
    let cleanupError;
    try{if(started||serviceRegistered){
      if(serviceRegistered)await serviceTool(['-NoProfile','-Command',"$ErrorActionPreference='Stop'; $s=Get-Service -Name AGP-PostgreSQL-Acceptance -ErrorAction SilentlyContinue; if($s){if($s.Status -ne 'Stopped'){Stop-Service -Name AGP-PostgreSQL-Acceptance};$s.WaitForStatus('Stopped',[TimeSpan]::FromSeconds(30))}; exit 0"],'stop-service');
      else await runTool(join(pgBin,'pg_ctl.exe'),['-D',cluster,'-m','fast','-w','stop']);
      evidence.databaseStopped=true;
    }
    if(serviceRegistered){await serviceTool(['-NoProfile','-File',resolve('scripts/production-postgres.ps1'),'-Action','Unregister','-ConfigFile',serviceConfig],'unregister');evidence.serviceRemoved=true;}
    }catch(e){cleanupError=e;evidence.cleanupFailed=true;evidence.passed=false;}
    evidence.finishedAt=new Date().toISOString();await writeFile(join(root,'evidence.json'),JSON.stringify(evidence,null,2));
    console.log('Protected acceptance evidence: '+join(root,'evidence.json'));
    if(cleanupError)throw cleanupError;
  }
});
