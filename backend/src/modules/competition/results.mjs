import {randomUUID} from 'node:crypto';
import {AppError} from '../../platform/errors.mjs';
import {decimal,judgeAverage,popularity,finalScore,rank,serialize} from './scoring.mjs';
const fail=code=>{throw new AppError(code,409,'成绩尚不满足核查或发布条件');};
export async function globalSnapshot(c,cutoff){
 if((await c.query('SELECT 1 FROM platform.global_rankings WHERE cutoff=$1',[cutoff])).rowCount)return;
 const rows=(await c.query(`SELECT w.id,p.title,p.category,COALESCE(sum(d.likes),0)::text AS likes,COALESCE(sum(d.plays),0)::text AS plays
  FROM platform.works w JOIN platform.game_versions v ON v.id=w.published_version JOIN platform.work_profiles p ON p.work_id=w.id
  JOIN platform.accounts a ON a.id=w.owner_id LEFT JOIN platform.ranking_deltas d ON d.work_id=w.id AND d.occurred_at<$1
  WHERE a.status='active' AND v.status='approved' AND v.scan_status='clean' AND NOT v.revoked AND NOT v.withdrawn
  GROUP BY w.id,p.title,p.category`,[cutoff])).rows;
 const max=k=>rows.reduce((m,r)=>BigInt(r[k])>m?BigInt(r[k]):m,0n).toString();
 const entries=rank(rows.map(r=>({...r,total:popularity(r.likes,r.plays,max('likes'),max('plays')),average:decimal(0)}))).map(r=>({id:r.id,title:r.title,category:r.category,rank:r.rank,likes:r.likes,plays:r.plays,popularity:serialize(r.total)}));
 await c.query("INSERT INTO platform.global_rankings VALUES($1,$2,'phase6-v1') ON CONFLICT DO NOTHING",[cutoff,JSON.stringify(entries)]);
}
export async function snapshot(c,contest,{final=false,cutoff,now,persist=true}){
 const end=new Date(Math.min(+new Date(cutoff),+new Date(contest.review_end)));
 if(!Number.isFinite(+end)||+end>now||+end<=+new Date(contest.submission_end))fail('INVALID_CUTOFF');
 if(final&&now<+new Date(contest.review_end))fail('CONTEST_NOT_ENDED');
 if(!final){const old=(await c.query("SELECT id FROM platform.contest_results WHERE contest_id=$1 AND kind='daily' AND cutoff=$2",[contest.id,end])).rows[0];if(old)return old;}
 const subjects=(await c.query(`SELECT s.id,s.work_id,s.version_id,p.category,p.title,s.name FROM platform.contest_subjects s
 JOIN platform.works w ON w.id=s.work_id JOIN platform.game_versions v ON v.id=s.version_id
 JOIN platform.work_profiles p ON p.work_id=s.work_id JOIN platform.accounts a ON a.id=w.owner_id
 WHERE s.contest_id=$1 AND NOT s.withdrawn AND a.status='active' AND w.published_version=s.version_id
 AND v.status='approved' AND v.scan_status='clean' AND NOT v.revoked AND NOT v.withdrawn
 AND NOT EXISTS(SELECT FROM platform.contest_members m WHERE m.subject_id=s.id AND NOT m.verified)
 AND NOT EXISTS(SELECT FROM platform.contest_exclusions e WHERE e.contest_id=s.contest_id AND e.work_id=s.work_id)
 ORDER BY s.id`,[contest.id])).rows;
 if(!subjects.length)fail('NO_ELIGIBLE_ENTRIES');
 const raw=[];
 for(const s of subjects){
  const likes=(await c.query(`SELECT count(*) FROM (SELECT DISTINCT ON(identity_key) active FROM platform.contest_signals
   WHERE work_id=$1 AND kind='like' AND occurred_at>=$2 AND occurred_at<$3 ORDER BY identity_key,occurred_at DESC,id DESC) x WHERE active`,[s.work_id,contest.submission_end,end])).rows[0].count;
  const plays=(await c.query(`SELECT count(*) FROM (SELECT DISTINCT COALESCE(a.identity_hash,e.identity_key),e.day FROM platform.contest_signals e
   LEFT JOIN platform.contest_aliases a ON a.browser_hash=e.identity_key AND a.day=e.day
   WHERE e.work_id=$1 AND e.kind='play' AND e.occurred_at>=$2 AND e.occurred_at<$3) x`,[s.work_id,contest.submission_end,end])).rows[0].count;
  const reviews=final?(await c.query(`SELECT r.judge_id,r.scores FROM platform.contest_reviews r JOIN platform.accounts a ON a.id=r.judge_id
   WHERE r.subject_id=$1 AND r.valid AND r.locked AND r.submitted_at IS NOT NULL AND a.status='active' AND 'judge'=ANY(a.roles)
   AND r.judge_id<>(SELECT owner_id FROM platform.works WHERE id=$2)
   AND NOT EXISTS(SELECT FROM platform.contest_members m WHERE m.subject_id=r.subject_id AND m.account_id=r.judge_id) ORDER BY r.judge_id`,[s.id,s.work_id])).rows:[];
  if(final&&reviews.length<3)fail('INSUFFICIENT_VALID_REVIEWS');
  raw.push({...s,likes,plays,reviews});
 }
 const max=key=>raw.reduce((m,r)=>BigInt(r[key])>m?BigInt(r[key]):m,0n).toString();
 const entries=rank(raw.map(r=>{const popular=popularity(r.likes,r.plays,max('likes'),max('plays')),average=final?judgeAverage(r.reviews.map(j=>j.scores)):decimal(0);
  return {...r,popular,average,total:final?finalScore(average,popular):popular};})).map(r=>({id:r.id,workId:r.work_id,title:r.title,category:r.category,name:r.name,rank:r.rank,likes:r.likes,plays:r.plays,
   popularity:serialize(r.popular),...(final?{average:serialize(r.average),total:serialize(r.total)}:{})}));
 const evidence={subjects:raw,maxLikes:max('likes'),maxPlays:max('plays'),start:contest.submission_end};
 if(!persist)return {entries,evidence:JSON.parse(JSON.stringify(evidence))};
 const id=randomUUID(),kind=final?'final':'daily';
 const version=Number((await c.query('SELECT COALESCE(max(version),0)+1 AS n FROM platform.contest_results WHERE contest_id=$1 AND kind=$2',[contest.id,kind])).rows[0].n);
 await c.query('INSERT INTO platform.contest_results(id,contest_id,version,cutoff,kind,rule_version,entries,evidence) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[id,contest.id,version,end,kind,'phase6-v1',JSON.stringify(entries),JSON.stringify(evidence)]);
 return {id,version,entries};
}
