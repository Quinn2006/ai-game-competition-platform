import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { connect, quote, hash } from './production-database.mjs';

// Database name switching only; neither this command nor restore starts a
// runtime/tunnel. Switching the approved installation is a separate controller
// configuration selection, so either failure leaves ingress closed.
export async function switchDatabase(admin,plan,approval){
  if(approval!==hash(JSON.stringify(plan))||plan.format!==1||!/^ai_games_restore_[a-f0-9]{16}$/.test(plan.restoredDatabase)
    ||!/^ai_games_rollback_[a-f0-9]{16}$/.test(plan.rollbackDatabase)||!['switch','rollback'].includes(plan.action))throw Error('Explicit reviewed switch required');
  const from=plan.action==='switch'?'ai_games_production':plan.rollbackDatabase;
  const to=plan.action==='switch'?plan.rollbackDatabase:'ai_games_production';
  const secondFrom=plan.action==='switch'?plan.restoredDatabase:'ai_games_production';
  const secondTo=plan.action==='switch'?'ai_games_production':plan.restoredDatabase;
  await admin.query('BEGIN');
  try{
    await admin.query('SELECT pg_advisory_xact_lock(432002)');
    const names=plan.action==='switch'?['ai_games_production',plan.restoredDatabase]:['ai_games_production',plan.rollbackDatabase];
    const active=await admin.query('SELECT 1 FROM pg_stat_activity WHERE datname=ANY($1)',[names]);
    if(active.rowCount)throw Error('All source/target clients must exit before switch');
    // Transactional database renames retain both datasets. There is no DROP,
    // directory move or automatic destructive downgrade.
    if(plan.action==='switch'){
      await admin.query(`ALTER DATABASE ${quote(from)} RENAME TO ${quote(to)}`);
      await admin.query(`ALTER DATABASE ${quote(secondFrom)} RENAME TO ${quote(secondTo)}`);
    }else{
      await admin.query(`ALTER DATABASE ${quote(secondFrom)} RENAME TO ${quote(secondTo)}`);
      await admin.query(`ALTER DATABASE ${quote(from)} RENAME TO ${quote(to)}`);
    }
    await admin.query('GRANT CONNECT ON DATABASE ai_games_production TO app_production,backup_production,migrate_production');
    await admin.query(`REVOKE CONNECT ON DATABASE ${quote(plan.action==='switch'?plan.rollbackDatabase:plan.restoredDatabase)} FROM app_production,backup_production`);
    await admin.query('COMMIT');
  }catch(e){await admin.query('ROLLBACK');throw e;}
}
async function main(){
  const [action,planFile]=process.argv.slice(2),plan=JSON.parse(await readFile(planFile,'utf8'));
  if(action==='review'){
    const report=JSON.parse(await readFile(plan.restoreReport,'utf8'));
    if(!report.verified||report.targetDatabase!==plan.restoredDatabase)throw Error('Restore evidence differs');
    console.log('Review switch digest: '+hash(JSON.stringify(plan)));return;
  }
  if(action!=='apply'||!plan.deletionReconciliationEvidence||!plan.runtimeAcceptanceEvidence)throw Error('Deletion and runtime acceptance evidence required');
  // Pin the exact reviewed evidence, not a mutable boolean in configuration.
  for(const [file,digest] of [[plan.restoreReport,plan.restoreReportSha256],[plan.deletionReconciliationEvidence,plan.deletionEvidenceSha256],[plan.runtimeAcceptanceEvidence,plan.runtimeEvidenceSha256]]){
    if(hash(await readFile(file))!==digest)throw Error('Reviewed acceptance evidence changed');
  }
  const admin=await connect(process.env.PRODUCTION_ADMIN_URL,process.env.DATABASE_CA_FILE);
  try{await switchDatabase(admin,plan,process.env.APPROVED_SWITCH_SHA256);}
  finally{await admin.end();}
  await writeFile(plan.resultFile,JSON.stringify({at:new Date().toISOString(),action:plan.action,databasesRetained:true,publicEntryOpened:false}),{flag:'wx'});
  console.log('Database names switched; both datasets retained and public entry remains closed. Select the reviewed installation before managed startup.');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(()=>{console.error('Controlled switch refused/failed. Inspect database names and protected evidence; do not start ingress.');process.exitCode=1;});
