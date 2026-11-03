import {eraseChats,lifecycleAction,cleanupLifecycle} from './lifecycle.mjs';
import { randomUUID } from 'node:crypto';
import { fail,uuid,textField,dateRange,csv,excelXml } from './policy.mjs';
import { profileOf } from '../discovery/service.mjs';

export const deletionParticipant={async check(){},async finalize(c,id){
 if(!(await c.query("SELECT to_regclass('platform.notifications') AS name")).rows[0].name)return;
 await eraseChats(c,id);
 for(const table of ['notifications','support_feedback'])await c.query(`DELETE FROM platform.${table} WHERE account_id=$1`,[id]);
}};
export function createOperationsService({database,identity,mail,ai,contactEmail='',clock=()=>Date.now(),siteOnly=true}){
 if(ai&&(!ai.privacy||ai.privacy.training!==false||ai.privacy.retentionDays>90||!Number.isInteger(ai.privacy.retentionDays)||ai.privacy.retentionDays<0||typeof ai.delete!=='function'))throw Error('AI privacy contract required');
 const audit=(c,u,action,target,context,detail={})=>c.query('INSERT INTO platform.operations_events(id,actor_id,action,target_id,request_id,detail) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),u?.id??null,action,target,context.requestId,detail]);
 const admin=u=>{if(!u.roles.includes('admin'))fail('FORBIDDEN',403);};
 async function transaction(fn){const c=await database.connect();try{await c.query('BEGIN');const r=await fn(c);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
 async function notify(c,{recipients,key,title,body,important=false,archive=false,archiveUntil=null,contestId=null}){
  for(const accountId of [...new Set(recipients)]){
   const id=randomUUID();const inserted=await c.query(`INSERT INTO platform.notifications(id,account_id,event_key,title,body,important)
    SELECT $1,id,$3,$4,$5,$6 FROM platform.accounts WHERE id=$2 AND status='active' ON CONFLICT(account_id,event_key) DO NOTHING RETURNING id`,[id,accountId,key,title,body,important]);
   if(!inserted.rowCount)continue;
   if(important&&!siteOnly)await c.query('INSERT INTO platform.notification_mail(id) VALUES($1)',[id]);
   if(archive)await c.query('INSERT INTO platform.notification_archives(id,account_id,event_key,title,body,archive_until,contest_id) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING',[randomUUID(),accountId,key,title,body,archiveUntil,contestId]);
  }
 }
 async function announcements(){return {items:(await database.query("SELECT id,title,body,image,importance,pinned,publish_at,expires_at FROM platform.announcements WHERE state='published' AND publish_at<=$1 AND (expires_at IS NULL OR expires_at>$1) ORDER BY pinned DESC,publish_at DESC LIMIT 100",[new Date(clock())])).rows};}
 async function report(c,input){const [start,end]=dateRange(input);return {range:{start,end},totals:(await c.query(`SELECT
  (SELECT count(*) FROM platform.accounts WHERE status='active') AS users,
  (SELECT count(*) FROM platform.competitions) AS competitions,
  (SELECT count(*) FROM platform.contest_members) AS participants,
  (SELECT count(*) FROM platform.contest_reviews WHERE valid AND submitted_at IS NOT NULL) AS reviews,
  (SELECT count(*) FROM platform.works) AS works,
  (SELECT count(*) FROM platform.works WHERE published_version IS NOT NULL) AS published,
  (SELECT count(*) FROM platform.community_comments WHERE NOT deleted) AS comments,
  (SELECT count(*) FROM platform.community_likes WHERE active) AS likes,
  (SELECT COALESCE(sum(plays),0) FROM platform.discovery_metrics) AS plays`)).rows[0],days:(await c.query(`SELECT d::date::text AS day,
  (SELECT count(*) FROM platform.accounts WHERE (created_at AT TIME ZONE 'Asia/Shanghai')::date=d::date) AS users,
  (SELECT count(*) FROM platform.works WHERE (created_at AT TIME ZONE 'Asia/Shanghai')::date=d::date) AS works,
  (SELECT count(*) FROM platform.play_daily WHERE day=d::date) AS plays
  FROM generate_series(($1::timestamptz AT TIME ZONE 'Asia/Shanghai')::date,($2::timestamptz AT TIME ZONE 'Asia/Shanghai')::date-1,interval '1 day') d ORDER BY d`,[start,end])).rows,
  limitations:['有效试玩按保留中的每日明细汇总，超过明细保留期的日期不可重建。','比赛、报名及有效评分数量为当前实时总数。']};}
 async function users(c,input){const q=String(input.q??'').trim();if(q.length>100)fail('INVALID_QUERY');const state=input.status??'',role=input.role??'';
  if(state&&!['active','pending','deleting','deleted','disabled'].includes(state)||role&&!['admin','judge'].includes(role))fail('INVALID_FILTER');
  const [from,to]=dateRange(input),offset=Number(input.offset??0);if(!Number.isSafeInteger(offset)||offset<0||offset>100000)fail('INVALID_OFFSET');
  return {items:(await c.query(`SELECT id,nickname,status,roles,created_at FROM platform.accounts WHERE nickname ILIKE $1 ESCAPE '\\' AND ($2='' OR status=$2) AND ($3='' OR $3=ANY(roles)) AND created_at>=$4 AND created_at<$5 ORDER BY created_at DESC,id LIMIT 100 OFFSET $6`,['%'+q.replace(/[\\%_]/g,'\\$&')+'%',state,role,from,to,offset])).rows};}
 const dangerous=new Set(['batch','announcement-save','announcement-action','settings','sensitive-edit']);
 const service={
  announcements,
  notifyInTransaction:notify,
  async status(){return {platform:'available',mail:siteOnly?'disabled-site-only':mail?'adapter-configured':'unconfigured',ai:ai?'adapter-configured':'unconfigured',contactEmail};},
  // Internal integration only; never accepts arbitrary recipients from a public HTTP route.
  async notifyBusiness(event){if(!Array.isArray(event.recipients)||event.recipients.some(id=>!uuid(id))||!event.key)fail('INVALID_EVENT');await transaction(c=>notify(c,{...event,title:textField(event.title,100),body:textField(event.body,10000)}));},
  async run(action,input,context){
   if(action==='announcements')return announcements();
   if(action==='status')return service.status();
   if(!identity)fail('AUTHENTICATION_REQUIRED',401,'请先登录');
   if(dangerous.has(action)&&(!uuid(input.resourceId)||input.confirmed!==true||!input.proof))fail('CONFIRMATION_REQUIRED',403,'需要二次确认及管理员再验证');
   if(action==='chat'){
    const question=textField(input.question,2000);
    // Provider receives public help only, with no tools, identity, database or admin context.
    const ticket=await identity.authorized(context,async(c,u)=>{await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',['support:'+u.id]);const n=(await c.query("SELECT count(*) FROM platform.support_chats WHERE account_id=$1 AND ended_at>CURRENT_TIMESTAMP-interval '1 minute'",[u.id])).rows[0];if(Number(n.count)>=5)fail('RATE_LIMITED',429);const id=randomUUID();await c.query('INSERT INTO platform.support_chats(id,account_id,question,answer,provider_key,pending) VALUES($1,$2,$3,$4,$5,true)',[id,u.id,question,'客服请求处理中',ai?id:null]);return {id,userId:u.id};});
    let answer='AI 客服暂不可用。请查看帮助中心或提交反馈。',available=false;
    if(ai){try{answer=textField(await ai.answer({requestId:ticket.id,question,knowledge:'上传已授权的小游戏ZIP；审核通过后公开；账号问题通过反馈联系管理员。',signal:AbortSignal.timeout(15000)}),10000);available=true;}catch{answer='AI 客服暂时无法回答，请提交反馈联系管理员。';}}
    if(contactEmail)answer+=' 管理员邮箱：'+contactEmail;
    const saved=await database.query('UPDATE platform.support_chats SET answer=$2,ended_at=$3,pending=false WHERE id=$1 AND account_id=$4',[ticket.id,answer,new Date(clock()),ticket.userId]);
    // A deletion or account closure during a request must not resurrect local or remote content.
    if(!saved.rowCount&&ai)await database.query('INSERT INTO platform.support_deletions(provider_key) VALUES($1) ON CONFLICT DO NOTHING',[ticket.id]);
    return {id:ticket.id,answer:saved.rowCount?answer:'对话已被清空。',available:saved.rowCount?available:false,contactEmail};
   }
   return identity.authorized(context,async(c,u)=>{
    const lifecycle=await lifecycleAction(c,u,action,input);if(lifecycle){if(action==='complaint-close')await audit(c,u,action,input.id,context);return lifecycle;}
    if(action==='notifications'){
     const offset=Number(input.offset??0);if(!Number.isSafeInteger(offset)||offset<0||offset>100000)fail('INVALID_OFFSET');
     const rows=(await c.query('SELECT id,title,body,important,read_at,created_at FROM platform.notifications WHERE account_id=$1 ORDER BY created_at DESC,id LIMIT 101 OFFSET $2',[u.id,offset])).rows;
     return {items:rows.slice(0,100),nextOffset:rows.length>100?offset+100:null};
    }
    if(action==='read'){if(!uuid(input.id))fail('INVALID_ID');await c.query('UPDATE platform.notifications SET read_at=COALESCE(read_at,CURRENT_TIMESTAMP) WHERE id=$1 AND account_id=$2',[input.id,u.id]);return {ok:true};}
    if(action==='feedback'){
     const body=textField(input.body,2000);await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',['feedback:'+u.id]);
     if(Number((await c.query("SELECT count(*) FROM platform.support_feedback WHERE account_id=$1 AND created_at>CURRENT_TIMESTAMP-interval '1 hour'",[u.id])).rows[0].count)>=5)fail('RATE_LIMITED',429);
     const id=randomUUID();await c.query('INSERT INTO platform.support_feedback(id,account_id,body) VALUES($1,$2,$3)',[id,u.id,body]);return {id};
    }
    if(action==='my-feedback')return {items:(await c.query('SELECT id,body,state,reply,created_at FROM platform.support_feedback WHERE account_id=$1 ORDER BY created_at DESC LIMIT 100',[u.id])).rows};
    admin(u);
    if(action==='dashboard')return report(c,input);
    if(action==='users')return users(c,input);
    if(action==='works')return {items:(await c.query(`SELECT w.id,COALESCE(p.title,w.title) AS title,w.published_version,h.work_id IS NOT NULL AS hidden,COALESCE(p.featured,false) AS featured FROM platform.works w LEFT JOIN platform.work_profiles p ON p.work_id=w.id LEFT JOIN platform.operations_hidden h ON h.work_id=w.id ORDER BY w.created_at DESC LIMIT 100`)).rows};
    if(action==='todos')return {reviews:(await c.query("SELECT id,work_id,status FROM platform.game_versions WHERE status IN ('pending','reviewing') AND NOT withdrawn ORDER BY created_at LIMIT 100")).rows,risks:(await c.query('SELECT id,work_id,reason FROM platform.community_risks WHERE resolved_at IS NULL ORDER BY created_at LIMIT 100')).rows,feedback:(await c.query("SELECT id,body,created_at FROM platform.support_feedback WHERE state='open' ORDER BY created_at LIMIT 100")).rows,mail:(await c.query("SELECT count(*) AS pending FROM platform.notification_mail WHERE state='pending'")).rows[0],competition:(await c.query("SELECT (SELECT count(*) FROM platform.contest_members WHERE NOT verified) AS identities,(SELECT count(*) FROM platform.contest_changes WHERE state='pending') AS changes,(SELECT count(*) FROM platform.contest_appeals WHERE resolved_at IS NULL) AS appeals")).rows[0]};
    if(action==='errors'){const [from,to]=dateRange(input);if(input.requestId&&!uuid(input.requestId))fail('INVALID_ID');return {items:(await c.query('SELECT id,action,request_id,outcome,occurred_at FROM platform.audit_events WHERE occurred_at>=$1 AND occurred_at<$2 AND ($3::uuid IS NULL OR request_id=$3) ORDER BY occurred_at DESC LIMIT 100',[from,to,input.requestId||null])).rows};}
    if(action==='audit')return {items:(await c.query('SELECT action,target_id,request_id,detail,created_at FROM platform.operations_events ORDER BY created_at DESC LIMIT 100')).rows};
    if(action==='announcement-list')return {items:(await c.query('SELECT * FROM platform.announcements ORDER BY created_at DESC LIMIT 100')).rows};
    if(action==='settings-read')return (await c.query('SELECT notification_days FROM platform.operations_settings WHERE id')).rows[0];
    if(action==='export'){
     if(!['csv','xml'].includes(input.format)||!['users','daily'].includes(input.kind))fail('INVALID_EXPORT');
     const rows=input.kind==='users'?(await users(c,input)).items:(await report(c,input)).days,columns=input.kind==='users'?['id','nickname','status','roles','created_at']:['day','users','works','plays'];
     await audit(c,u,'export',null,context,{kind:input.kind,format:input.format,count:rows.length});
     return {filename:'operations.'+input.format,contentType:input.format==='csv'?'text/csv':'application/xml',content:input.format==='csv'?csv(rows,columns):excelXml(rows,columns),limitedTo:100};
    }
    if(action==='batch'){
     if(!Array.isArray(input.ids)||input.ids.length<1||input.ids.length>100||input.ids.some(id=>!uuid(id))||new Set(input.ids).size!==input.ids.length||!['hide','restore','feature','unfeature'].includes(input.operation))fail('INVALID_BATCH');
     for(const id of [...input.ids].sort()){
      const w=(await c.query('SELECT * FROM platform.works WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!w)fail('NOT_FOUND',404);
      if(input.operation==='hide'){await c.query('INSERT INTO platform.operations_hidden(work_id,version_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[id,w.published_version]);await c.query('UPDATE platform.works SET published_version=NULL WHERE id=$1',[id]);}
      else if(input.operation==='restore'){
       const h=(await c.query('SELECT version_id FROM platform.operations_hidden WHERE work_id=$1',[id])).rows[0];if(!h)fail('NOT_HIDDEN',409);
       if(h.version_id&&!(await c.query("SELECT v.id FROM platform.game_versions v JOIN platform.accounts a ON a.id=$3 WHERE v.id=$1 AND v.work_id=$2 AND v.status='approved' AND v.scan_status='clean' AND NOT v.revoked AND NOT v.withdrawn AND a.status='active'",[h.version_id,id,w.owner_id])).rowCount)fail('RESTORE_UNSAFE',409);
       await c.query('DELETE FROM platform.operations_hidden WHERE work_id=$1',[id]);await c.query('UPDATE platform.works SET published_version=$2 WHERE id=$1',[id,h.version_id]);
      }else if(!(await c.query('UPDATE platform.work_profiles SET featured=$2 WHERE work_id=$1',[id,input.operation==='feature'])).rowCount)fail('PROFILE_MISSING',409);
      await audit(c,u,'work_'+input.operation,id,context);
     }return {ok:true,count:input.ids.length};
    }
    if(action==='announcement-save'){
     const title=textField(input.title,100),body=textField(input.body,10000);if(!['normal','important','urgent'].includes(input.importance))fail('INVALID_IMPORTANCE');
     const publish=new Date(input.publishAt||clock()),expires=input.expiresAt?new Date(input.expiresAt):null;
     if(!Number.isFinite(+publish)||(expires&&(!Number.isFinite(+expires)||expires<=publish||+expires<=clock())))fail('INVALID_DATE');
     const image=profileOf({title:'a',summary:'a',instructions:'a',category:'其他',tags:[],cover:input.image??''}).cover;
     const old=(await c.query('SELECT * FROM platform.announcements WHERE id=$1 FOR UPDATE',[input.resourceId])).rows[0];
     if(old&&['withdrawn','expired'].includes(old.state))fail('INVALID_TRANSITION',409);
     if(old){await c.query(`UPDATE platform.announcements SET title=$2,body=$3,image=$4,importance=$5,publish_at=$6,expires_at=$7,revision=revision+1,notified_revision=CASE WHEN state='published' AND $8=false THEN revision+1 ELSE notified_revision END WHERE id=$1`,[old.id,title,body,image,input.importance,old.state==='published'?old.publish_at:publish,expires,input.resend===true]);}
     else await c.query("INSERT INTO platform.announcements(id,title,body,image,importance,state,publish_at,expires_at) VALUES($1,$2,$3,$4,$5,'scheduled',$6,$7)",[input.resourceId,title,body,image,input.importance,publish,expires]);
     await audit(c,u,old?'announcement_edited':'announcement_created',input.resourceId,context,{resend:input.resend===true});return {ok:true};
    }
    if(action==='announcement-action'){
     if(!['withdraw','pin','unpin'].includes(input.operation))fail('INVALID_ACTION');
     const row=(await c.query('SELECT state FROM platform.announcements WHERE id=$1 FOR UPDATE',[input.resourceId])).rows[0];if(!row||['withdrawn','expired'].includes(row.state))fail('INVALID_TRANSITION',409);
     await c.query(input.operation==='withdraw'?"UPDATE platform.announcements SET state='withdrawn' WHERE id=$1":'UPDATE platform.announcements SET pinned=$2 WHERE id=$1',input.operation==='withdraw'?[input.resourceId]:[input.resourceId,input.operation==='pin']);
     await audit(c,u,'announcement_'+input.operation,input.resourceId,context);return {ok:true,message:siteOnly?'已更新；已生成的站内通知保留历史记录。':'已更新；已发出的邮件无法收回。'};
    }
    if(action==='settings'){const days=Number(input.days);if(!Number.isInteger(days)||days<30||days>180)fail('INVALID_RETENTION');await c.query('UPDATE platform.operations_settings SET notification_days=$1 WHERE id',[days]);await audit(c,u,'notification_retention',input.resourceId,context,{days});return {ok:true};}
    if(action==='sensitive-edit'){
     // Account state is the editable sensitive field; email changes require the verification flow.
     if(!['active','disabled'].includes(input.status)||input.resourceId===u.id)fail('INVALID_STATUS');
     const target=(await c.query('SELECT roles,status FROM platform.accounts WHERE id=$1 FOR UPDATE',[input.resourceId])).rows[0];if(!target||target.roles.includes('admin')||!['active','disabled'].includes(target.status))fail('FORBIDDEN',403);
     await c.query('UPDATE platform.accounts SET status=$2 WHERE id=$1',[input.resourceId,input.status]);await c.query('DELETE FROM platform.sessions WHERE account_id=$1',[input.resourceId]);await audit(c,u,'account_status',input.resourceId,context,{status:input.status});return {ok:true};
    }
    if(action==='feedback-reply'){
     if(!uuid(input.id))fail('INVALID_ID');const reply=textField(input.reply,2000);const row=(await c.query("UPDATE platform.support_feedback SET reply=$2,state='closed',closed_at=CURRENT_TIMESTAMP WHERE id=$1 AND state='open' RETURNING account_id",[input.id,reply])).rows[0];if(!row)fail('NOT_FOUND',404);
     await notify(c,{recipients:[row.account_id],key:'feedback:'+input.id,title:'反馈已回复',body:reply});await audit(c,u,'feedback_replied',input.id,context);return {ok:true};
    }
    fail('NOT_FOUND',404);
   },dangerous.has(action)?input.proof:null,dangerous.has(action)?input.resourceId:null);
  },
  async tick(){
   await transaction(async c=>{
    await c.query('SELECT pg_advisory_xact_lock(432007)');
    const now=new Date(clock()),context={requestId:randomUUID()};
    const expired=(await c.query("UPDATE platform.announcements SET state='expired' WHERE state IN ('scheduled','published') AND expires_at<=$1 RETURNING id",[now])).rows;
    for(const a of expired)await audit(c,null,'announcement_expired',a.id,context);
    const due=(await c.query("UPDATE platform.announcements SET state='published' WHERE state='scheduled' AND publish_at<=$1 RETURNING id",[now])).rows;
    for(const a of due)await audit(c,null,'announcement_published',a.id,context);
    const pending=(await c.query("SELECT * FROM platform.announcements WHERE state='published' AND notified_revision<revision FOR UPDATE")).rows;
    for(const a of pending){const recipients=(await c.query("SELECT id FROM platform.accounts WHERE status='active'")).rows.map(r=>r.id);await notify(c,{recipients,key:`announcement:${a.id}:${a.revision}`,title:a.title,body:a.body,important:a.importance!=='normal'});await c.query('UPDATE platform.announcements SET notified_revision=revision WHERE id=$1',[a.id]);}
    await c.query("DELETE FROM platform.notifications WHERE created_at<CURRENT_TIMESTAMP-(SELECT notification_days FROM platform.operations_settings WHERE id)*interval '1 day'");
    await c.query('DELETE FROM platform.notification_archives WHERE contest_id IS NULL AND archive_until IS NOT NULL AND archive_until<CURRENT_TIMESTAMP');
    await cleanupLifecycle(c);
    await c.query("DELETE FROM platform.operations_events WHERE created_at<CURRENT_TIMESTAMP-interval '6 months'");
   });
   if(ai)await transaction(async c=>{
    const jobs=(await c.query('SELECT provider_key FROM platform.support_deletions WHERE next_attempt<=CURRENT_TIMESTAMP ORDER BY requested_at LIMIT 20 FOR UPDATE SKIP LOCKED')).rows;
    for(const job of jobs){try{await ai.delete({requestId:job.provider_key,signal:AbortSignal.timeout(15000)});await c.query('DELETE FROM platform.support_deletions WHERE provider_key=$1',[job.provider_key]);}catch{await c.query("UPDATE platform.support_deletions SET attempts=attempts+1,next_attempt=CURRENT_TIMESTAMP+interval '5 minutes' WHERE provider_key=$1",[job.provider_key]);}}
   });
   if(mail&&!siteOnly)await transaction(async c=>{
    const messages=(await c.query("SELECT m.id,n.title,n.body,a.email FROM platform.notification_mail m JOIN platform.notifications n ON n.id=m.id JOIN platform.accounts a ON a.id=n.account_id WHERE m.state='pending' AND m.next_attempt<=CURRENT_TIMESTAMP AND a.status='active' ORDER BY m.next_attempt LIMIT 20 FOR UPDATE OF m SKIP LOCKED")).rows;
    for(const m of messages){try{await mail({idempotencyKey:m.id,to:m.email,subject:m.title,body:m.body,signal:AbortSignal.timeout(15000)});await c.query("UPDATE platform.notification_mail SET state='sent',delivered_at=CURRENT_TIMESTAMP WHERE id=$1",[m.id]);}catch{await c.query("UPDATE platform.notification_mail SET attempts=attempts+1,next_attempt=CURRENT_TIMESTAMP+interval '5 minutes' WHERE id=$1",[m.id]);}}
   });
  },
 };return service;
}
