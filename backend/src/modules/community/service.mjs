import { randomUUID, randomBytes, createHash, createHmac } from 'node:crypto';
import { AppError } from '../../platform/errors.mjs';
import { advance, dayOf } from './timing.mjs';
const fail=(code,status=400,message='请求无法完成')=>{throw new AppError(code,status,message);};
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v);
const digest=v=>createHash('sha256').update(v).digest('hex');
const normalized=v=>v.normalize('NFKC').toLowerCase().replace(/[\p{Cc}\p{Cf}]/gu,'');
export const deletionParticipant={async check(){},async finalize(c,id){
  await c.query('DELETE FROM platform.community_favorites WHERE account_id=$1',[id]);
  await c.query("UPDATE platform.community_comments SET account_id=NULL WHERE account_id=$1",[id]);
}};
export function createCommunityService({database,identity,secret,clock=()=>Date.now()}) {
  const hash=v=>createHmac('sha256',secret).update(v).digest('hex');
  async function tx(fn){const c=await database.connect();try{await c.query('BEGIN');const r=await fn(c);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
  const audit=(c,user,action,target)=>c.query('INSERT INTO platform.community_events(id,actor_id,action,target_id) VALUES($1,$2,$3,$4)',[randomUUID(),user?.id??null,action,target]);
  const risk=(c,work,who,reason)=>c.query('INSERT INTO platform.community_risks(id,work_id,identity_hash,reason,created_at) VALUES($1,$2,$3,$4,$5)',[randomUUID(),work,who,reason,new Date(clock())]);
  async function published(c,id){
    if(!uuid(id))fail('NOT_FOUND',404);
    const w=(await c.query(`SELECT w.id,v.id AS version_id FROM platform.works w JOIN platform.game_versions v ON v.id=w.published_version AND v.work_id=w.id
      JOIN platform.accounts a ON a.id=w.owner_id WHERE w.id=$1 AND a.status='active' AND v.status='approved' AND NOT v.revoked AND NOT v.withdrawn AND v.scan_status='clean' FOR UPDATE OF w`,[id])).rows[0];
    if(!w)fail('NOT_FOUND',404);return w;
  }
  async function metrics(c,id){await c.query(`INSERT INTO platform.discovery_metrics(work_id,likes) VALUES($1,(SELECT count(*) FROM platform.community_likes WHERE work_id=$1 AND active)) ON CONFLICT(work_id) DO UPDATE SET likes=EXCLUDED.likes,updated_at=CURRENT_TIMESTAMP`,[id]);}
  async function merge(c,browser,who,day){
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[browser]);
    const alias=(await c.query('SELECT identity_hash FROM platform.play_aliases WHERE browser_hash=$1 AND day=$2',[browser,day])).rows[0];
    // Shared browsers never transfer one account's history to another account.
    if(alias)return alias.identity_hash===who;
    const rows=(await c.query('SELECT * FROM platform.play_daily WHERE identity_hash=$1 AND day=$2 ORDER BY work_id',[browser,day])).rows;
    for(const row of rows){
      await c.query('SELECT id FROM platform.works WHERE id=$1 FOR UPDATE',[row.work_id]);
      const inserted=await c.query('INSERT INTO platform.play_daily(work_id,day,identity_hash,duration_ms) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[row.work_id,day,who,row.duration_ms]);
      if(!inserted.rowCount)await c.query('UPDATE platform.discovery_metrics SET plays=plays-1,duration_ms=duration_ms-$2 WHERE work_id=$1',[row.work_id,row.duration_ms]);
    }
    await c.query('DELETE FROM platform.play_daily WHERE identity_hash=$1 AND day=$2',[browser,day]);
    await c.query('INSERT INTO platform.play_aliases(browser_hash,day,identity_hash) VALUES($1,$2,$3)',[browser,day,who]);

    return true;
  }
  async function actor(context,fn,required=false){
    if(context.sessionToken){if(!identity)fail('AUTH_REQUIRED',401);return identity.authorized(context,(c,u)=>fn(c,u));}
    if(required)fail('AUTH_REQUIRED',401,'请先登录');return tx(c=>fn(c,null));
  }
  const service={
    async run(action,input,context){return actor(context,async(c,user)=>{
      const now=clock(),day=dayOf(now),browser=hash('browser:'+context.visitor),who=user?hash('account:'+user.id):browser;
      if(action==='merge'){if(user)await merge(c,browser,who,day);return {ok:true};}
      if(action==='favorites'){
        return {items:(await c.query(`SELECT w.id,w.title,f.created_at FROM platform.community_favorites f JOIN platform.works w ON w.id=f.work_id
          JOIN platform.game_versions v ON v.id=w.published_version JOIN platform.accounts a ON a.id=w.owner_id
          WHERE f.account_id=$1 AND a.status='active' AND v.status='approved' AND NOT v.revoked AND NOT v.withdrawn AND v.scan_status='clean'
          ORDER BY f.created_at DESC,w.id LIMIT 50 OFFSET $2`,[user.id,offset(input.offset)])).rows};
      }
      if(['risks','resolve','words','hold'].includes(action)){
        if(!user.roles.includes('admin'))fail('FORBIDDEN',403);
        if(action==='risks')return {items:(await c.query('SELECT id,work_id,reason,created_at,resolved_at,resolution,hold_until FROM platform.community_risks ORDER BY created_at DESC LIMIT 50 OFFSET $1',[offset(input.offset)])).rows,words:(await c.query('SELECT blocked_words FROM platform.community_settings WHERE id=true')).rows[0].blocked_words};
        if(action==='words'){
          if(!Array.isArray(input.words)||input.words.length>200||input.words.some(w=>typeof w!=='string'||!w.trim()||w.length>100))fail('INVALID_WORDS');
          await c.query('UPDATE platform.community_settings SET blocked_words=$1 WHERE id=true',[input.words.map(normalized)]);
        }else{
          if(!uuid(input.id)||typeof input.reason!=='string'||!input.reason.trim()||input.reason.length>1000)fail('INVALID_INPUT');
          if(action==='hold'){
            const until=new Date(input.until);if(!Number.isFinite(+until)||+until<=now||+until>now+30*86400000)fail('INVALID_REVIEW_DATE');
            await c.query('UPDATE platform.community_risks SET hold_until=$2,hold_reason=$3,hold_by=$4 WHERE id=$1',[input.id,until,input.reason,user.id]);
          }else await c.query('UPDATE platform.community_risks SET resolved_at=$2,reviewer_id=$3,resolution=$4,hold_until=NULL WHERE id=$1',[input.id,new Date(now),user.id,input.reason]);
        }
        await audit(c,user,action,input.id??null);return {ok:true};
      }
      // Identity merge locks browser before works, matching concurrent sessions.
      if(action==='start'&&user)await merge(c,browser,who,day);
      if(action==='signal')return signal(c,input,{who,browser,user},now);
      const work=await published(c,input.workId);
      if(action==='state'){
        const counts=(await c.query('SELECT likes,plays,duration_ms FROM platform.discovery_metrics WHERE work_id=$1',[work.id])).rows[0]??{likes:0,plays:0,duration_ms:0};
        return {...counts,liked:user?Boolean((await c.query('SELECT active FROM platform.community_likes WHERE work_id=$1 AND account_id=$2',[work.id,user.id])).rows[0]?.active):false,
          favorite:user?Boolean((await c.query('SELECT 1 FROM platform.community_favorites WHERE work_id=$1 AND account_id=$2',[work.id,user.id])).rowCount):false,userId:user?.id??null,admin:user?.roles.includes('admin')??false};
      }
      if(action==='like'||action==='favorite'){
        if(typeof input.active!=='boolean')fail('INVALID_INPUT');
        if(action==='like'){
          await c.query('INSERT INTO platform.community_likes(work_id,account_id,active) VALUES($1,$2,$3) ON CONFLICT(work_id,account_id) DO UPDATE SET active=$3',[work.id,user.id,input.active]);await metrics(c,work.id);
        }else if(input.active)await c.query('INSERT INTO platform.community_favorites(work_id,account_id,created_at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[work.id,user.id,new Date(now)]);
        else await c.query('DELETE FROM platform.community_favorites WHERE work_id=$1 AND account_id=$2',[work.id,user.id]);
        return {ok:true};
      }
      if(action==='comments'){
        if(input.parentId&&!uuid(input.parentId))fail('INVALID_INPUT');
        return {items:(await c.query(`SELECT c.id,c.parent_id,c.account_id,CASE WHEN c.deleted THEN '' ELSE c.body END AS body,c.deleted,c.created_at,
          COALESCE(a.nickname,'已注销用户') AS nickname,EXISTS(SELECT FROM platform.community_comments ch WHERE ch.parent_id=c.id) AS replies
          FROM platform.community_comments c LEFT JOIN platform.accounts a ON a.id=c.account_id WHERE c.work_id=$1 AND c.parent_id IS NOT DISTINCT FROM $2::uuid
          ORDER BY c.created_at DESC,c.id DESC LIMIT 20 OFFSET $3`,[work.id,input.parentId??null,offset(input.offset)])).rows};
      }
      if(action==='comment'){
        if(typeof input.body!=='string'||!input.body.trim()||input.body.length>16000)fail('INVALID_COMMENT',400,'评论为空或超过请求长度限制');
        const count=(await c.query('SELECT count(*)::integer AS n FROM platform.community_comments WHERE account_id=$1 AND created_at>$2',[user.id,new Date(now-60000)])).rows[0].n;
        if(count>=10)fail('COMMENT_LIMIT',429,'评论和回复每60秒合计最多10条');
        const words=(await c.query('SELECT blocked_words FROM platform.community_settings WHERE id=true')).rows[0].blocked_words;
        if(words.some(w=>normalized(input.body).includes(w)))fail('COMMENT_FILTERED',400,'评论包含被过滤的内容，请修改后重试');
        if(input.parentId&&(!uuid(input.parentId)||!(await c.query('SELECT id FROM platform.community_comments WHERE id=$1 AND work_id=$2',[input.parentId,work.id])).rowCount))fail('INVALID_PARENT');
        const id=randomUUID();await c.query('INSERT INTO platform.community_comments(id,work_id,account_id,parent_id,body,created_at) VALUES($1,$2,$3,$4,$5,$6)',[id,work.id,user.id,input.parentId??null,input.body.trim(),new Date(now)]);return {id};
      }
      if(action==='delete-comment'){
        if(!uuid(input.id))fail('NOT_FOUND',404);
        const comment=(await c.query('SELECT account_id FROM platform.community_comments WHERE id=$1 AND work_id=$2',[input.id,work.id])).rows[0];
        if(!comment)fail('NOT_FOUND',404);if(comment.account_id!==user.id&&!user.roles.includes('admin'))fail('FORBIDDEN',403);
        await c.query("UPDATE platform.community_comments SET body='',deleted=true WHERE id=$1",[input.id]);await audit(c,user,'comment_deleted',input.id);return {ok:true};
      }
      if(action==='start'){
        await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[who]);
        const n=(await c.query('SELECT count(*)::integer AS n FROM platform.play_sessions WHERE identity_hash=$1 AND started_at>$2',[who,new Date(now-60000)])).rows[0].n;
        if(n>=10){await risk(c,work.id,who,'session_burst');return {limited:true};}
        const token=randomBytes(32).toString('hex');
        await c.query('INSERT INTO platform.play_sessions(token_hash,work_id,identity_hash,browser_hash,version_id,started_at,updated_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$6,$7)',[digest(token),work.id,who,browser,work.version_id,new Date(now),new Date(now+30*60000)]);
        return {token,expiresAt:now+30*60000};
      }
      fail('NOT_FOUND',404);
    },!['state','comments','start','signal','merge'].includes(action));},
    async cleanup(){await tx(async c=>{
      await c.query("DELETE FROM platform.play_sessions WHERE expires_at<$1",[new Date(clock()-30*86400000)]);
      await c.query("DELETE FROM platform.play_daily WHERE day<$1::date-30",[dayOf(clock())]);
      await c.query('DELETE FROM platform.play_aliases WHERE day<$1::date',[dayOf(clock())]);
      await c.query("DELETE FROM platform.community_risks WHERE created_at<$1 AND (hold_until IS NULL OR hold_until<$2)",[new Date(clock()-30*86400000),new Date(clock())]);
      await c.query("DELETE FROM platform.community_events WHERE created_at<$1::timestamptz-interval '6 months'",[new Date(clock())]);
    });}
  };
  async function signal(c,input,actor,now){
    if(typeof input.token!=='string'||!/^[a-f0-9]{64}$/.test(input.token))fail('INVALID_SESSION');
    const s=(await c.query('SELECT * FROM platform.play_sessions WHERE token_hash=$1 FOR UPDATE',[digest(input.token)])).rows[0];
    if(!s||s.browser_hash!==actor.browser||+s.expires_at<=now)fail('INVALID_SESSION',403);
    let who=actor.who;
    if(!actor.user){const a=(await c.query('SELECT identity_hash FROM platform.play_aliases WHERE browser_hash=$1 AND day=$2',[actor.browser,dayOf(now)])).rows[0];who=a?.identity_hash??who;}
    if(s.identity_hash!==who&&s.identity_hash!==actor.browser)fail('INVALID_SESSION',403);
    const w=await published(c,s.work_id);
    if(w.version_id!==s.version_id)fail('VERSION_CHANGED',409);
    let next;try{next=advance(s,input,now);}catch(e){await risk(c,s.work_id,who,'replayed_or_invalid_signal');return {rejected:true};}
    if(next.anomaly)await risk(c,s.work_id,who,'heartbeat_gap');
    let counted=s.counted;
    // Settle only at a healthy end. A failed or crashed session never contributes.
    if(input.kind==='end'&&!counted&&next.valid){
      const result=await c.query('INSERT INTO platform.play_daily(work_id,day,identity_hash,duration_ms) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[s.work_id,dayOf(now),who,next.elapsed]);
      if(result.rowCount)await c.query('INSERT INTO platform.discovery_metrics(work_id,plays,duration_ms) VALUES($1,1,$2) ON CONFLICT(work_id) DO UPDATE SET plays=platform.discovery_metrics.plays+1,duration_ms=platform.discovery_metrics.duration_ms+$2,updated_at=CURRENT_TIMESTAMP',[s.work_id,next.elapsed]);
      counted=true;await audit(c,actor.user,result.rowCount?'play_counted':'play_deduplicated',s.work_id);
    }
    await c.query('UPDATE platform.play_sessions SET sequence=$2,updated_at=$3,elapsed_ms=$4,foreground=$5,interacted=$6,failed=$7,counted=$8,expires_at=$9 WHERE token_hash=$1',
      [s.token_hash,input.sequence,new Date(now),next.elapsed,input.foreground,next.interacted,next.failed,counted,['end','error'].includes(input.kind)?new Date(now):s.expires_at]);
    return {counted,elapsedMs:next.elapsed};
  }
  return service;
}
function offset(v=0){const n=Number(v);if(!Number.isSafeInteger(n)||n<0||n>100000)fail('INVALID_OFFSET');return n;}
