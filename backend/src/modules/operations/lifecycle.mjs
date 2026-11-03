import {randomUUID} from 'node:crypto';
import {fail,textField,uuid} from './policy.mjs';
export async function eraseChats(c,accountId=null){
 const where=accountId?'account_id=$1':"ended_at<CURRENT_TIMESTAMP-interval '90 days'";
 const args=accountId?[accountId]:[];
 // Lock rows, queue remote deletion and erase locally in the same transaction.
 const rows=(await c.query(`SELECT id,provider_key,pending FROM platform.support_chats WHERE ${where} FOR UPDATE`,args)).rows;
 for(const r of rows){if(r.provider_key)await c.query("INSERT INTO platform.support_deletions(provider_key,next_attempt) VALUES($1,CURRENT_TIMESTAMP+CASE WHEN $2 THEN interval '1 minute' ELSE interval '0 seconds' END) ON CONFLICT DO NOTHING",[r.provider_key,r.pending]);await c.query('DELETE FROM platform.support_chats WHERE id=$1',[r.id]);}
}
export async function lifecycleAction(c,u,action,input){
 if(action==='chat-history')return {items:(await c.query('SELECT id,question,answer,pending,ended_at FROM platform.support_chats WHERE account_id=$1 ORDER BY ended_at DESC LIMIT 100',[u.id])).rows};
 if(action==='chat-delete'){await eraseChats(c,u.id);return {ok:true,message:'普通对话已清空；供应商删除将重试直至成功。正式投诉按结案后一年保留。'};}
 if(action==='complaint'){
  if(!uuid(input.id))fail('INVALID_ID');const reason=textField(input.reason,2000);
  const r=(await c.query('SELECT * FROM platform.support_chats WHERE id=$1 AND account_id=$2 FOR UPDATE',[input.id,u.id])).rows[0];if(!r)fail('NOT_FOUND',404);if(r.pending)fail('CHAT_PENDING',409);
  const id=randomUUID();await c.query('INSERT INTO platform.support_complaints(id,account_id,question,answer,reason) VALUES($1,$2,$3,$4,$5)',[id,u.id,r.question,r.answer,reason]);return {id};
 }
 if(action==='my-complaints')return {items:(await c.query('SELECT id,reason,resolution,closed_at FROM platform.support_complaints WHERE account_id=$1 ORDER BY created_at DESC LIMIT 100',[u.id])).rows};
 if(action==='complaints'||action==='complaint-close'){
  if(!u.roles.includes('admin'))fail('FORBIDDEN',403);
  if(action==='complaints')return {items:(await c.query('SELECT id,question,answer,reason,created_at FROM platform.support_complaints WHERE closed_at IS NULL ORDER BY created_at LIMIT 100')).rows};
  if(!uuid(input.id))fail('INVALID_ID');if(!(await c.query('UPDATE platform.support_complaints SET resolution=$2,closed_at=CURRENT_TIMESTAMP WHERE id=$1 AND closed_at IS NULL',[input.id,textField(input.resolution,2000)])).rowCount)fail('NOT_FOUND',404);return {ok:true};
 }
 return null;
}
export async function cleanupLifecycle(c){
 await eraseChats(c);
 await c.query("DELETE FROM platform.support_complaints WHERE closed_at<CURRENT_TIMESTAMP-interval '1 year'");
 // Closed-at is authoritative and remains NULL during an open appeal. Holds also prevent deletion.
 await c.query(`DELETE FROM platform.notification_archives n WHERE n.contest_id IS NOT NULL
 AND platform.contest_closed_at(n.contest_id)<CURRENT_TIMESTAMP-interval '1 year'
 AND NOT EXISTS(SELECT 1 FROM platform.contest_subjects s JOIN platform.community_risks r ON r.work_id=s.work_id
 WHERE s.contest_id=n.contest_id AND (r.resolved_at IS NULL OR r.hold_until IS NOT NULL))`);
}
