import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {AppError} from '../../platform/errors.mjs';
import {judgeScore} from './scoring.mjs';
import {snapshot,globalSnapshot} from './results.mjs';
import {cleanupCompetition} from './retention.mjs';
const fail=(code,status=400)=>{throw new AppError(code,status,'操作未完成：请检查权限、赛程及输入');};
const hash=s=>createHash('sha256').update(s).digest('hex');
const uuid=s=>typeof s==='string'&&/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(s);
const text=(v,max=1000)=>{if(typeof v!=='string'||!v.trim()||v.length>max)fail('INVALID_TEXT');return v.trim();};
const admin=u=>{if(!u.roles.includes('admin'))fail('FORBIDDEN',403);};
const sensitive=new Set(['verify','decide','unlock','invalidate','publish','exclude','resolve-appeal','identities','assign-judge']);
export const deletionParticipant={
 async check(c,id){if((await c.query("SELECT 1 FROM platform.contest_subjects s JOIN platform.competitions ct ON ct.id=s.contest_id WHERE s.captain_id=$1 AND s.kind='team' AND NOT s.withdrawn AND ct.archived_at IS NULL",[id])).rowCount)fail('CAPTAIN_TRANSFER_REQUIRED',409);},
 async finalize(c,id){await c.query(`UPDATE platform.discovery_teams t SET members=(SELECT COALESCE(jsonb_agg(jsonb_build_object('nickname',CASE WHEN a.id=$1 OR a.status='deleted' THEN '已注销用户' ELSE a.nickname END)),'[]')
  FROM platform.contest_members m JOIN platform.accounts a ON a.id=m.account_id WHERE m.subject_id=t.id)
  WHERE t.id IN(SELECT subject_id FROM platform.contest_members WHERE account_id=$1)`,[id]);}
};
export function createCompetitionService({database,identity,clock=()=>Date.now()}){
 const event=(c,u,contest,action,target,detail={})=>c.query('INSERT INTO platform.contest_events(id,contest_id,actor_id,action,target_id,detail) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),contest,u.id,action,target,JSON.stringify(detail)]);
 const registration=contest=>{if(clock()<+new Date(contest.registration_start)||clock()>=+new Date(contest.registration_end))fail('REGISTRATION_CLOSED',409);};
 async function subject(c,id,contest){if(!uuid(id))fail('INVALID_ID');const s=(await c.query('SELECT * FROM platform.contest_subjects WHERE id=$1 AND contest_id=$2 AND NOT withdrawn FOR UPDATE',[id,contest])).rows[0];if(!s)fail('NOT_FOUND',404);return s;}
 async function member(c,contest,user){return (await c.query('SELECT * FROM platform.contest_members WHERE contest_id=$1 AND account_id=$2',[contest,user])).rows[0];}
 async function safeWork(c,id,owner,versionId){
  if(!uuid(id))fail('INVALID_WORK');
  const w=(await c.query(`SELECT w.id,w.owner_id,v.id AS version_id FROM platform.works w JOIN platform.game_versions v ON v.id=w.published_version
   JOIN platform.work_profiles p ON p.work_id=w.id JOIN platform.accounts a ON a.id=w.owner_id
   WHERE w.id=$1 AND a.status='active' AND v.status='approved' AND v.scan_status='clean' AND NOT v.revoked AND NOT v.withdrawn FOR UPDATE OF w`,[id])).rows[0];
  if(!w||w.owner_id!==owner)fail('INVALID_WORK',403);if(versionId&&w.version_id!==versionId)fail('SUBMITTED_VERSION_CHANGED',409);return w;
 }
 async function conflict(c,s,judge){return judge===s.captain_id||Boolean((await c.query(`SELECT 1 FROM platform.contest_members WHERE subject_id=$1 AND account_id=$2
  UNION ALL SELECT 1 FROM platform.works WHERE id=$3 AND owner_id=$2`,[s.id,judge,s.work_id])).rowCount);}
 return {
 async globalResults(){return {result:(await database.query('SELECT cutoff,entries FROM platform.global_rankings ORDER BY cutoff DESC LIMIT 1')).rows[0]??null};},
 async awards(){return {items:(await database.query(`SELECT a.name,e->>'title' AS title,r.contest_id,c.title AS contest FROM platform.contest_awards a
 JOIN platform.contest_results r ON r.id=a.result_id JOIN platform.competitions c ON c.id=r.contest_id
 CROSS JOIN LATERAL jsonb_array_elements(r.entries) e WHERE e->>'id'=a.subject_id::text AND r.published_at IS NOT NULL
 AND r.version=(SELECT max(version) FROM platform.contest_results WHERE contest_id=r.contest_id AND published_at IS NOT NULL)
 ORDER BY r.published_at DESC LIMIT 100`)).rows};},
 async cleanup(){const c=await database.connect();try{await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock(432006)');await cleanupCompetition(c);await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}},
 async daily(){
  const now=clock(),midnight=Math.floor((now+8*3600000)/86400000)*86400000-8*3600000;
  if(now<midnight+600000)return;
  const c=await database.connect();try{await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock(432006)');
   const contests=(await c.query('SELECT * FROM platform.competitions WHERE submission_end<$1 AND archived_at IS NULL FOR UPDATE',[new Date(midnight)])).rows;
   for(const contest of contests){try{await c.query('SAVEPOINT daily');await snapshot(c,contest,{cutoff:new Date(midnight),now});await c.query('RELEASE SAVEPOINT daily');}
    catch(e){await c.query('ROLLBACK TO SAVEPOINT daily');if(e.code!=='NO_ELIGIBLE_ENTRIES')throw e;}}
   await globalSnapshot(c,new Date(midnight));await c.query('COMMIT');
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
 },
 async reviewVersion(context,subjectId){return identity.authorized(context,async(c,u)=>{
  if(!uuid(subjectId)||!u.roles.includes('judge'))fail('FORBIDDEN',403);
  const s=(await c.query('SELECT s.* FROM platform.contest_subjects s JOIN platform.contest_reviews r ON r.subject_id=s.id JOIN platform.competitions ct ON ct.id=s.contest_id WHERE s.id=$1 AND r.judge_id=$2 AND r.valid AND NOT s.withdrawn AND ct.review_start<=$3 AND (ct.review_end>$3 OR r.supplemental)',[subjectId,u.id,new Date(clock())])).rows[0];
  if(!s||await conflict(c,s,u.id))fail('FORBIDDEN',403);await safeWork(c,s.work_id,s.captain_id,s.version_id);
  const v=(await c.query('SELECT * FROM platform.game_versions WHERE id=$1',[s.version_id])).rows[0];return {...v,title:'匿名评审作品'};
 });},
 async publicResults(contestId){
  if(!uuid(contestId))fail('INVALID_CONTEST');
  const result=(await database.query(`SELECT id,version,cutoff,kind,entries,published_at FROM platform.contest_results WHERE contest_id=$1
   AND (kind='daily' OR published_at IS NOT NULL) ORDER BY (kind='final') DESC,version DESC LIMIT 1`,[contestId])).rows[0];
  if(result?.published_at){const expiry=new Date(result.published_at);expiry.setUTCFullYear(expiry.getUTCFullYear()+3);if(clock()>=+expiry)result.entries=result.entries.map(e=>({...e,name:'历史参赛主体'}));}
  return {result:result??null,awards:result?(await database.query('SELECT subject_id,name FROM platform.contest_awards WHERE result_id=$1',[result.id])).rows:[]};
 },
 async publicList(){return {items:(await database.query('SELECT id,title,registration_start,registration_end,submission_start,submission_end,review_start,review_end,team_limit FROM platform.competitions ORDER BY registration_start DESC LIMIT 100')).rows};},
 async run(action,input,context){
  if(sensitive.has(action)&&(input.confirm!==true||typeof input.proof!=='string'))fail('REVALIDATION_REQUIRED',403);
  return identity.authorized(context,async(c,u)=>{
   if(action==='create'){
    admin(u);const dates=['registrationStart','registrationEnd','submissionStart','submissionEnd','reviewStart','reviewEnd'].map(k=>new Date(input[k]));
    if(dates.some(d=>!Number.isFinite(+d))||!(dates[0]<dates[1]&&dates[2]<dates[3]&&dates[1]<=dates[3]&&dates[3]<=dates[4]&&dates[4]<dates[5]))fail('INVALID_SCHEDULE');
    if(+dates[3]<=clock())fail('SUBMISSION_MUST_BE_FUTURE');
    const limit=input.teamLimit??3;if(!Number.isInteger(limit)||limit<1||limit>100)fail('INVALID_LIMIT');
    const id=randomUUID();await c.query('INSERT INTO platform.competitions(id,title,registration_start,registration_end,submission_start,submission_end,review_start,review_end,team_limit) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[id,text(input.title,100),...dates,limit]);
    await event(c,u,id,action,id);return {id};
   }
   if(!uuid(input.contestId))fail('INVALID_CONTEST');
   // A per-contest lock serializes membership, capacity, assignment and deadline decisions.
   const contest=(await c.query('SELECT * FROM platform.competitions WHERE id=$1 FOR UPDATE',[input.contestId])).rows[0];if(!contest)fail('NOT_FOUND',404);
   if(action==='snapshot'){
    admin(u);if(typeof input.final!=='boolean')fail('INVALID_INPUT');
    const now=clock(),midnight=Math.floor((now+8*3600000)/86400000)*86400000-8*3600000;
    if(!input.final&&now<midnight+600000)fail('DAILY_NOT_DUE',409);
    const result=await snapshot(c,contest,{final:input.final,cutoff:input.final?contest.review_end:new Date(midnight),now});
    await event(c,u,contest.id,action,result.id,{final:input.final});return result;
   }
   if(action==='inspection'){
    admin(u);return {results:(await c.query('SELECT * FROM platform.contest_results WHERE contest_id=$1 ORDER BY created_at DESC',[contest.id])).rows,
     events:(await c.query('SELECT * FROM platform.contest_events WHERE contest_id=$1 ORDER BY created_at DESC LIMIT 500',[contest.id])).rows,
     appeals:(await c.query('SELECT a.* FROM platform.contest_appeals a JOIN platform.contest_results r ON r.id=a.result_id WHERE r.contest_id=$1',[contest.id])).rows,
     risks:(await c.query('SELECT r.id,r.work_id,r.reason,r.resolved_at,r.resolution FROM platform.community_risks r JOIN platform.contest_subjects s ON s.work_id=r.work_id WHERE s.contest_id=$1',[contest.id])).rows};
   }
   if(action==='publish'){
    admin(u);const reason=text(input.reason);if(!uuid(input.resultId))fail('INVALID_ID');
    const result=(await c.query("SELECT * FROM platform.contest_results WHERE id=$1 AND contest_id=$2 AND kind='final' AND published_at IS NULL FOR UPDATE",[input.resultId,contest.id])).rows[0];if(!result)fail('NOT_FOUND',404);
    if((await c.query('SELECT 1 FROM platform.community_risks r JOIN platform.contest_subjects s ON s.work_id=r.work_id WHERE s.contest_id=$1 AND r.resolved_at IS NULL',[contest.id])).rowCount)fail('UNRESOLVED_RISKS',409);
    if((await c.query('SELECT 1 FROM platform.contest_appeals a JOIN platform.contest_results r ON r.id=a.result_id WHERE r.contest_id=$1 AND a.resolved_at IS NULL',[contest.id])).rowCount)fail('UNRESOLVED_APPEALS',409);
    // Recompute immediately before publication; an intervening invalidation cannot publish a stale draft.
    const fresh=await snapshot(c,contest,{final:true,cutoff:contest.review_end,now:clock(),persist:false});
    if(!isDeepStrictEqual(fresh.entries,result.entries)||!isDeepStrictEqual(fresh.evidence,result.evidence))fail('STALE_RESULT',409);
    if(!Array.isArray(input.awards)||input.awards.length>100)fail('INVALID_AWARDS');
    for(const award of input.awards){if(!result.entries.some(e=>e.id===award.subjectId))fail('INVALID_AWARD_SUBJECT');await c.query('INSERT INTO platform.contest_awards VALUES($1,$2,$3)',[result.id,award.subjectId,text(award.name,100)]);}
    await c.query('UPDATE platform.contest_results SET published_at=$2,published_by=$3,publish_reason=$4 WHERE id=$1',[result.id,new Date(clock()),u.id,reason]);
    await event(c,u,contest.id,action,result.id,{reason});return {ok:true};
   }
   if(action==='exclude'){
    admin(u);if(!uuid(input.workId))fail('INVALID_ID');const reason=text(input.reason);
    await c.query('INSERT INTO platform.contest_exclusions VALUES($1,$2,$3,$4) ON CONFLICT(contest_id,work_id) DO UPDATE SET reason=$3,actor_id=$4',[contest.id,input.workId,reason,u.id]);
    await event(c,u,contest.id,action,input.workId,{reason});return {ok:true};
   }
   if(action==='resolve-appeal'){
    admin(u);if(!uuid(input.appealId))fail('INVALID_ID');const reason=text(input.reason);
    const r=await c.query('UPDATE platform.contest_appeals SET resolution=$2,resolved_at=$3 WHERE id=$1 AND resolved_at IS NULL AND result_id IN(SELECT id FROM platform.contest_results WHERE contest_id=$4)',[input.appealId,reason,new Date(clock()),contest.id]);if(!r.rowCount)fail('NOT_FOUND',404);
    await event(c,u,contest.id,action,input.appealId,{reason});return {ok:true};
   }
   if(action==='mine'){
    const m=await member(c,contest.id,u.id);return {member:m??null,subject:m?await subject(c,m.subject_id,contest.id):null,
     changes:m?(await c.query('SELECT * FROM platform.contest_changes WHERE subject_id=$1 ORDER BY created_at DESC',[m.subject_id])).rows:[]};
   }
   if(action==='admin'){
    admin(u);return {subjects:(await c.query('SELECT * FROM platform.contest_subjects WHERE contest_id=$1',[contest.id])).rows,
     members:(await c.query('SELECT subject_id,account_id,verified FROM platform.contest_members WHERE contest_id=$1',[contest.id])).rows,
     changes:(await c.query('SELECT ch.* FROM platform.contest_changes ch JOIN platform.contest_subjects s ON s.id=ch.subject_id WHERE s.contest_id=$1',[contest.id])).rows};
   }
   if(action==='identities'){admin(u);await event(c,u,contest.id,action,contest.id);return {members:(await c.query('SELECT * FROM platform.contest_members WHERE contest_id=$1',[contest.id])).rows};}
   if(action==='register'){
    registration(contest);if(await member(c,contest.id,u.id))fail('ALREADY_REGISTERED',409);
    if(!['personal','team'].includes(input.kind))fail('INVALID_KIND');
    const id=randomUUID();await c.query('INSERT INTO platform.contest_subjects(id,contest_id,captain_id,name,kind) VALUES($1,$2,$3,$4,$5)',[id,contest.id,u.id,text(input.name,100),input.kind]);
    await c.query('INSERT INTO platform.contest_members(contest_id,subject_id,account_id,real_name,student_number) VALUES($1,$2,$3,$4,$5)',[contest.id,id,u.id,text(input.realName,100),text(input.studentNumber,100)]);
    await event(c,u,contest.id,action,id);return {id};
   }
   if(action==='invite-preview'||action==='join'){
    if(typeof input.token!=='string'||!/^[a-f0-9]{64}$/.test(input.token))fail('INVALID_INVITE');
    const inv=(await c.query('SELECT subject_id FROM platform.contest_invites WHERE token_hash=$1 AND expires_at>$2',[hash(input.token),new Date(clock())])).rows[0];if(!inv)fail('INVALID_INVITE');
    const s=await subject(c,inv.subject_id,contest.id);registration(contest);
    if(action==='invite-preview')return {id:s.id,name:s.name};
    if(input.confirm!==true||input.subjectId!==s.id)fail('CONFIRM_REQUIRED');
    if(await member(c,contest.id,u.id))fail('ALREADY_REGISTERED',409);
    if(Number((await c.query('SELECT count(*) FROM platform.contest_members WHERE subject_id=$1',[s.id])).rows[0].count)>=contest.team_limit)fail('TEAM_FULL',409);
    await c.query('INSERT INTO platform.contest_members(contest_id,subject_id,account_id,real_name,student_number) VALUES($1,$2,$3,$4,$5)',[contest.id,s.id,u.id,text(input.realName,100),text(input.studentNumber,100)]);
    await event(c,u,contest.id,action,s.id);return {ok:true};
   }
   if(action==='assign'){
    admin(u);if(clock()<+new Date(contest.submission_end))fail('REVIEW_CLOSED',409);
    const subjects=(await c.query(`SELECT s.* FROM platform.contest_subjects s WHERE contest_id=$1 AND NOT withdrawn AND work_id IS NOT NULL
     AND NOT EXISTS(SELECT FROM platform.contest_members m WHERE m.subject_id=s.id AND NOT m.verified) ORDER BY s.id`,[contest.id])).rows;
    const judges=(await c.query("SELECT id FROM platform.accounts WHERE status='active' AND 'judge'=ANY(roles) ORDER BY id")).rows;
    for(const s of subjects){await safeWork(c,s.work_id,s.captain_id,s.version_id);let assigned=Number((await c.query('SELECT count(*) FROM platform.contest_reviews WHERE subject_id=$1 AND valid',[s.id])).rows[0].count);
     for(const j of judges){if(assigned>=3)break;if(await conflict(c,s,j.id))continue;
      const added=await c.query('INSERT INTO platform.contest_reviews(subject_id,judge_id,supplemental) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[s.id,j.id,clock()>=+new Date(contest.review_end)]);assigned+=added.rowCount;
     }if(assigned<3)fail('INSUFFICIENT_JUDGES',409);
    }await event(c,u,contest.id,action,contest.id);return {count:subjects.length};
   }
   if(action==='assignments'){
    if(!u.roles.includes('judge'))fail('FORBIDDEN',403);
    return {items:(await c.query(`SELECT r.subject_id,r.scores,r.comment,r.locked FROM platform.contest_reviews r
     JOIN platform.contest_subjects s ON s.id=r.subject_id WHERE s.contest_id=$1 AND r.judge_id=$2 AND r.valid AND NOT s.withdrawn`,[contest.id,u.id])).rows};
   }
   const s=await subject(c,input.subjectId,contest.id),m=await member(c,contest.id,u.id),captain=s.captain_id===u.id;
   if(action==='assign-judge'){
    admin(u);if(clock()<+new Date(contest.submission_end))fail('REVIEW_CLOSED',409);
    if(!uuid(input.judgeId)||!(await c.query("SELECT 1 FROM platform.accounts WHERE id=$1 AND status='active' AND 'judge'=ANY(roles)",[input.judgeId])).rowCount||await conflict(c,s,input.judgeId))fail('JUDGE_CONFLICT',403);
    const r=await c.query('INSERT INTO platform.contest_reviews(subject_id,judge_id,supplemental) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[s.id,input.judgeId,clock()>=+new Date(contest.review_end)]);if(!r.rowCount)fail('ALREADY_ASSIGNED',409);
    await event(c,u,contest.id,action,s.id,{judgeId:input.judgeId,reason:text(input.reason)});return {ok:true};
   }
   if(action==='appeal'){
    if(m?.subject_id!==s.id)fail('FORBIDDEN',403);if(!uuid(input.resultId)||!['score_calculation','program','procedure'].includes(input.kind))fail('INVALID_APPEAL');
    const r=(await c.query('SELECT published_at FROM platform.contest_results WHERE id=$1 AND contest_id=$2 AND published_at IS NOT NULL',[input.resultId,contest.id])).rows[0];
    if(!r||clock()>=+new Date(r.published_at)+7*86400000)fail('APPEAL_CLOSED',409);
    const id=randomUUID();await c.query('INSERT INTO platform.contest_appeals(id,result_id,subject_id,account_id,kind,body) VALUES($1,$2,$3,$4,$5,$6)',[id,input.resultId,s.id,u.id,input.kind,text(input.body,5000)]);
    await event(c,u,contest.id,action,id);return {id};
   }
   if(action==='invite'){
    registration(contest);if(!captain||s.kind!=='team')fail('FORBIDDEN',403);
    const token=randomBytes(32).toString('hex'),expires=new Date(Math.min(clock()+7*86400000,+new Date(contest.registration_end)));
    await c.query('INSERT INTO platform.contest_invites VALUES($1,$2,$3)',[hash(token),s.id,expires]);await event(c,u,contest.id,action,s.id);return {token,expires};
   }
   if(action==='verify'){
    admin(u);if(!uuid(input.accountId)||typeof input.approved!=='boolean')fail('INVALID_INPUT');
    const reason=text(input.reason);const r=await c.query('UPDATE platform.contest_members SET verified=$3 WHERE subject_id=$1 AND account_id=$2',[s.id,input.accountId,input.approved]);if(!r.rowCount)fail('NOT_FOUND',404);
    await event(c,u,contest.id,action,s.id,{accountId:input.accountId,approved:input.approved,reason});return {ok:true};
   }
   if(action==='submit'){
    if(input.confirmAnonymous!==true)fail('ANONYMOUS_PACKAGE_REQUIRED');
    if(!captain)fail('FORBIDDEN',403);if(clock()<+new Date(contest.submission_start)||clock()>=+new Date(contest.submission_end))fail('SUBMISSION_CLOSED',409);
    if((await c.query('SELECT 1 FROM platform.contest_members WHERE subject_id=$1 AND NOT verified',[s.id])).rowCount)fail('VERIFICATION_REQUIRED',409);
    const w=await safeWork(c,input.workId,u.id);await c.query('UPDATE platform.contest_subjects SET work_id=$2,version_id=$3 WHERE id=$1',[s.id,w.id,w.version_id]);
    await event(c,u,contest.id,action,s.id,{workId:w.id,versionId:w.version_id});return {ok:true};
   }
   if(action==='change'){
    registration(contest);if(m?.subject_id!==s.id)fail('FORBIDDEN',403);
    if(!['convert','leave','captain','withdraw'].includes(input.kind))fail('INVALID_KIND');
    if(input.kind!=='leave'&&!captain)fail('FORBIDDEN',403);
    if(input.kind==='convert'&&(s.kind!=='personal'||input.confirmTransfer!==true))fail('TRANSFER_CONSENT_REQUIRED');
    if(input.kind==='leave'&&captain)fail('CAPTAIN_TRANSFER_REQUIRED');
    if(input.kind==='captain'&&(!uuid(input.successorId)||input.successorId===u.id||(await member(c,contest.id,input.successorId))?.subject_id!==s.id))fail('INVALID_SUCCESSOR');
    const id=randomUUID();await c.query('INSERT INTO platform.contest_changes(id,subject_id,requester_id,kind,successor_id,reason) VALUES($1,$2,$3,$4,$5,$6)',[id,s.id,u.id,input.kind,input.kind==='captain'?input.successorId:null,text(input.reason)]);
    await event(c,u,contest.id,action,s.id,{changeId:id,kind:input.kind});return {id};
   }
   if(['consent','decide'].includes(action)){
    registration(contest);if(!uuid(input.changeId))fail('INVALID_ID');
    const ch=(await c.query("SELECT * FROM platform.contest_changes WHERE id=$1 AND subject_id=$2 AND state='pending' FOR UPDATE",[input.changeId,s.id])).rows[0];if(!ch)fail('NOT_FOUND',404);
    if(action==='consent'){
     if(input.confirm!==true)fail('CONFIRM_REQUIRED');
     if(ch.kind==='captain'&&ch.successor_id===u.id)await c.query('UPDATE platform.contest_changes SET accepted=true WHERE id=$1',[ch.id]);
     else if(ch.kind==='leave'&&captain)await c.query('UPDATE platform.contest_changes SET captain_approved=true WHERE id=$1',[ch.id]);else fail('FORBIDDEN',403);
    }else{
     admin(u);if(typeof input.approved!=='boolean')fail('INVALID_INPUT');const reason=text(input.reason);
     if(input.approved){
      const requester=await member(c,contest.id,ch.requester_id);if(requester?.subject_id!==s.id)fail('STALE_CHANGE',409);
      if(ch.kind==='leave'){if(!ch.captain_approved||ch.requester_id===s.captain_id)fail('CAPTAIN_CONSENT_REQUIRED');await c.query('DELETE FROM platform.contest_members WHERE contest_id=$1 AND account_id=$2',[contest.id,ch.requester_id]);}
      else {if(ch.requester_id!==s.captain_id)fail('STALE_CHANGE',409);
       if(ch.kind==='convert'){if(s.kind!=='personal')fail('STALE_CHANGE',409);await c.query("UPDATE platform.contest_subjects SET kind='team' WHERE id=$1",[s.id]);}
       if(ch.kind==='captain'){if(!ch.accepted||(await member(c,contest.id,ch.successor_id))?.subject_id!==s.id)fail('SUCCESSOR_CONSENT_REQUIRED');await c.query('UPDATE platform.contest_subjects SET captain_id=$2 WHERE id=$1',[s.id,ch.successor_id]);if(s.work_id)await c.query('UPDATE platform.works SET owner_id=$2 WHERE id=$1',[s.work_id,ch.successor_id]);}
       if(ch.kind==='withdraw'){await c.query('UPDATE platform.contest_subjects SET withdrawn=true,work_id=NULL,version_id=NULL WHERE id=$1',[s.id]);await c.query('DELETE FROM platform.contest_members WHERE subject_id=$1',[s.id]);}
      }
     }await c.query('UPDATE platform.contest_changes SET state=$2,decision=$3 WHERE id=$1',[ch.id,input.approved?'approved':'rejected',reason]);
    }await event(c,u,contest.id,action,s.id,{changeId:ch.id,approved:input.approved??null});return {ok:true};
   }
   if(action==='score'){
    if(!u.roles.includes('judge')||await conflict(c,s,u.id))fail('FORBIDDEN',403);
    if(clock()<+new Date(contest.review_start)||(clock()>=+new Date(contest.review_end)&&!(await c.query('SELECT 1 FROM platform.contest_reviews WHERE subject_id=$1 AND judge_id=$2 AND supplemental',[s.id,u.id])).rowCount))fail('REVIEW_CLOSED',409);
    await safeWork(c,s.work_id,s.captain_id,s.version_id);try{judgeScore(input.scores);}catch{fail('INVALID_SCORES');}const comment=text(input.comment,5000);
    const r=await c.query('UPDATE platform.contest_reviews SET scores=$3,comment=$4,locked=true,submitted_at=$5 WHERE subject_id=$1 AND judge_id=$2 AND valid AND NOT locked',[s.id,u.id,JSON.stringify(input.scores),comment,new Date(clock())]);if(!r.rowCount)fail('REVIEW_LOCKED',409);
    await event(c,u,contest.id,action,s.id,{scores:input.scores,comment});return {ok:true};
   }
   if(action==='unlock'||action==='invalidate'){
    admin(u);if(!uuid(input.judgeId))fail('INVALID_ID');const reason=text(input.reason);
    if(action==='invalidate'&&!['conflict','procedure','violation'].includes(input.basis))fail('INVALID_BASIS');
    const r=await c.query(`UPDATE platform.contest_reviews SET ${action==='unlock'?'locked=false,supplemental=true':'valid=false'} WHERE subject_id=$1 AND judge_id=$2`,[s.id,input.judgeId]);if(!r.rowCount)fail('NOT_FOUND',404);
    await event(c,u,contest.id,action,s.id,{judgeId:input.judgeId,reason,basis:input.basis??null});return {ok:true};
   }
   fail('NOT_FOUND',404);
  },sensitive.has(action)?input.proof:null,input.contestId).catch(error=>{if(error.code==='23505')fail('ALREADY_EXISTS',409);throw error;});
 }
 };
}
