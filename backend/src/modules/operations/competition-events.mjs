// Called inside the competition transaction: notifications cannot outlive a rolled-back decision.
export function competitionNotifier(operations){return async(c,event)=>{
 const {id,contest,action,target,detail}=event;
 if(!['publish','exclude','resolve-appeal','verify','decide','assign','assign-judge','unlock','invalidate'].includes(action))return;
 let recipients=[];
 if(action==='publish')recipients=(await c.query('SELECT account_id AS id FROM platform.contest_members WHERE contest_id=$1',[contest])).rows;
 else if(action==='exclude')recipients=(await c.query('SELECT m.account_id AS id FROM platform.contest_members m JOIN platform.contest_subjects s ON s.id=m.subject_id WHERE s.contest_id=$1 AND s.work_id=$2',[contest,target])).rows;
 else if(action==='resolve-appeal')recipients=(await c.query('SELECT account_id AS id FROM platform.contest_appeals WHERE id=$1',[target])).rows;
 else if(action==='verify')recipients=[{id:detail.accountId}];
 else if(['assign','assign-judge','unlock','invalidate'].includes(action))recipients=detail.judgeId?[{id:detail.judgeId}]:(await c.query('SELECT DISTINCT r.judge_id AS id FROM platform.contest_reviews r JOIN platform.contest_subjects s ON s.id=r.subject_id WHERE s.contest_id=$1 AND r.valid',[contest])).rows;
 else recipients=(await c.query('SELECT account_id AS id FROM platform.contest_members WHERE subject_id=$1 UNION SELECT requester_id AS id FROM platform.contest_changes WHERE id=$2',[target,detail.changeId??null])).rows;
 const names={publish:'比赛成绩已发布',exclude:'参赛作品资格处理通知','resolve-appeal':'比赛申诉已结案',verify:'参赛身份核验已更新',decide:'团队变更申请已处理',assign:'新的评审任务','assign-judge':'新的评审任务',unlock:'评分已解锁',invalidate:'评分已作废'};
 await operations.notifyInTransaction(c,{recipients:recipients.map(r=>r.id),key:'contest-event:'+id,title:names[action],body:'请登录比赛中心查看本人相关详情。',important:true,archive:true,contestId:contest});
};}
