import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {migrate} from '../../backend/src/platform/migrations.mjs';
import {competitionCases} from './competition-cases.mjs';
import {operationsCases} from './operations-cases.mjs';
import {localIdentityCases} from './local-identity-cases.mjs';
import {createCompetitionService} from '../../backend/src/modules/competition/service.mjs';
import {createOperationsService} from '../../backend/src/modules/operations/service.mjs';
import {competitionNotifier} from '../../backend/src/modules/operations/competition-events.mjs';
import {createIdentityService} from '../../backend/src/modules/identity/service.mjs';
import {digest,newToken} from '../../backend/src/modules/identity/crypto.mjs';

test('management: password, paging, hide notifications and permanent contest deletion on isolated PostgreSQL',async()=>{
 const url=new URL(process.env.DATABASE_URL);
 assert.equal(url.hostname,'127.0.0.1');assert.equal(url.pathname,'/ai_games_test');
 assert.equal(process.env.CONFIRM_DISPOSABLE_DATABASE,'ai_games_test');
 const db=new pg.Pool({connectionString:url.href});
 try{
  await migrate(db,'test','up');
  await localIdentityCases(db);
  await operationsCases(db);
  const identity=createIdentityService({database:db,secret:'management-test-secret',localAccounts:true});
  const operations=createOperationsService({database:db,identity});
  const {contestId,subjectId,workId}=await competitionCases(db,competitionNotifier(operations));
  const id=randomUUID(),sessionToken=newToken(),context={sessionToken,requestId:randomUUID()};
  await db.query("INSERT INTO platform.accounts(id,status,nickname,roles,mfa_secret) VALUES($1,'active','删除测试',ARRAY['admin'],'test-factor')",[id]);
  await db.query("INSERT INTO platform.sessions(token_hash,account_id,expires_at) VALUES($1,$2,CURRENT_TIMESTAMP+interval '1 hour')",[digest(sessionToken),id]);
  async function proof(){const token=newToken();await db.query("INSERT INTO platform.identity_tokens(token_hash,account_id,purpose,action,resource_id,session_hash,expires_at) VALUES($1,$2,'revalidate','admin.dangerous',$3,$4,CURRENT_TIMESTAMP+interval '5 minutes')",[digest(token),id,contestId,digest(sessionToken)]);return {proof:token,confirm:true};}
  await db.query("INSERT INTO platform.accounts(id,status,nickname,created_at) SELECT gen_random_uuid(),'active','分页用户',CURRENT_TIMESTAMP-interval '2 years' FROM generate_series(1,105)");
  const first=await operations.run('users',{q:'分页用户'},context),second=await operations.run('users',{q:'分页用户',offset:100},context);
  assert.equal(first.items.length,100);assert.equal(first.nextOffset,100);assert.equal(second.items.length,5);assert.equal(second.nextOffset,null);
  assert.equal(new Set([...first.items,...second.items].map(u=>u.id)).size,105);
  const service=createCompetitionService({database:db,identity});
  await assert.rejects(service.run('delete',{contestId,title:'阶段6测试赛'},context),{code:'REVALIDATION_REQUIRED'});
  await assert.rejects(service.run('delete',{contestId,title:'错误名称',...await proof()},context),{code:'TITLE_CONFIRMATION_REQUIRED'});
  const count=Number((await db.query('SELECT count(*) FROM platform.competitions')).rows[0].count);
  await service.run('delete',{contestId,title:'阶段6测试赛',...await proof()},context);
  assert.equal(Number((await db.query('SELECT count(*) FROM platform.competitions')).rows[0].count),count-1);
  for(const table of ['contest_subjects','contest_members','contest_results','contest_events','contest_exclusions','notification_archives'])assert.equal((await db.query(`SELECT count(*) FROM platform.${table} WHERE contest_id=$1`,[contestId])).rows[0].count,'0');
  for(const table of ['contest_reviews','contest_invites','contest_changes','contest_awards','contest_appeals'])assert.equal((await db.query(`SELECT count(*) FROM platform.${table} WHERE subject_id=$1`,[subjectId])).rows[0].count,'0');
  assert.equal((await db.query('SELECT team_id FROM platform.work_profiles WHERE work_id=$1',[workId])).rows[0].team_id,null);
  assert.equal((await db.query('SELECT 1 FROM platform.works WHERE id=$1',[workId])).rowCount,1);
  assert.equal((await db.query("SELECT 1 FROM platform.operations_events WHERE action='competition_deleted' AND target_id=$1",[contestId])).rowCount,1);
  assert.equal((await service.publicList()).items.some(c=>c.id===contestId),false);
  assert.equal((await service.publicResults(contestId)).result,null);
 }finally{await db.end();}
});
