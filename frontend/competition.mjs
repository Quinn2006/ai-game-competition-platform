const $=s=>document.querySelector(s),status=$('#status');let contests=[],current=null,user=null,mine=null,publicResult=null;
const el=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
const notice=s=>{status.textContent=s;};
async function api(action,data={},read=false){const response=await fetch('/api/competition/'+action+(read?'?'+new URLSearchParams(data):''),read?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});const value=await response.json();if(!response.ok)throw Error(value.error?.code??'请求失败');return value;}
function table(parent,rows,columns){if(!rows.length){parent.append(el('p','暂无记录。'));return;}const wrapper=el('div');wrapper.className='table-wrap';const t=el('table'),head=el('tr');for(const [,label]of columns)head.append(el('th',label));t.append(head);for(const row of rows){const tr=el('tr');for(const [key]of columns)tr.append(el('td',typeof key==='function'?key(row):String(row[key]??'—')));t.append(tr);}wrapper.append(t);parent.append(wrapper);}
function field(f,name,label,type='text',options){const l=el('label',label),input=el(options?'select':type==='textarea'?'textarea':'input');input.name=name;if(!options&&type!=='textarea')input.type=type;if(options)for(const [value,text]of options){const o=el('option',text);o.value=value;input.append(o);}if(type!=='checkbox')input.required=true;l.append(input);f.append(l);return input;}
function form(parent,title,action,fields,{defaults={},sensitive=false,onSuccess,read=false}={}){
 const boundContestId=current?.id;
 const detail=el('details'),summary=el('summary',title),f=el('form');detail.open=['register','invite-preview','join','invite','submit','score','create'].includes(action);detail.append(summary,f);parent.append(detail);
 for(const [name,label,type,options]of fields)field(f,name,label,type,options);
 if(sensitive){field(f,'password','管理员密码','password').autocomplete='current-password';field(f,'code','验证器当前验证码').autocomplete='one-time-code';field(f,'confirm','确认执行此操作','checkbox').required=true;}
 if(action==='publish'){
  f.awards=[];const list=el('div'),add=el('button','加入获奖名单');add.type='button';f.append(add,list);
  f.elements.awardName.required=false;f.elements.awardSubject.required=false;
  add.onclick=()=>{const name=f.elements.awardName.value.trim(),subjectId=f.elements.awardSubject.value;if(!name||!subjectId){notice('请选择获奖主体并填写奖项名称。');return;}
   if(f.awards.some(a=>a.name===name&&a.subjectId===subjectId)){notice('该获奖记录已加入。');return;}
   const award={name,subjectId};f.awards.push(award);const row=el('p',name+' · '+f.elements.awardSubject.selectedOptions[0].textContent),remove=el('button','移除');remove.type='button';remove.onclick=()=>{f.awards=f.awards.filter(a=>a!==award);row.remove();};row.append(remove);list.append(row);notice('已加入名单，可继续添加其他奖项和获奖者。');};
 }
 const button=el('button',title);f.append(button);f.onsubmit=async e=>{e.preventDefault();button.disabled=true;notice('正在处理…');
  try{const data={contestId:boundContestId,...defaults,...Object.fromEntries(new FormData(f))};for(const node of f.elements)if(node.type==='checkbox')data[node.name]=node.checked;
   if(data.scores)data.scores=data.scores.split(',').map(x=>x.trim());if(data.teamLimit)data.teamLimit=Number(data.teamLimit);if(data.approved!==undefined)data.approved=data.approved==='true';
   if(action==='publish'){data.awards=f.awards??[];delete data.awardName;delete data.awardSubject;}
   if(sensitive){const response=await fetch('/api/identity/revalidate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:data.password,code:data.code,confirmed:true,action:'admin.dangerous',resourceId:boundContestId})});const proof=await response.json();if(!response.ok)throw Error(proof.error?.code??'再验证失败');data.proof=proof.proof;delete data.password;delete data.code;f.elements.password.value='';f.elements.code.value='';}
   const result=await api(action,data,read);notice('操作成功。');if(onSuccess)await onSuccess(result,detail);else await refresh();
  }catch(error){notice(error.message);}finally{button.disabled=false;}
 };return f;
}
function renderResults(){const box=$('#results');box.replaceChildren();if(!publicResult?.result){box.append(el('p','还没有可公开的排行榜。'));return;}const r=publicResult.result;box.append(el('p',`${r.kind==='final'?'已发布最终成绩':'每日人气快照'} · 版本 ${r.version} · 统计截至 ${new Date(r.cutoff).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}`));
 const entries=r.entries.filter(x=>!$('#category').value||x.category===$('#category').value);table(box,entries,[['rank','名次'],['title','作品'],['name','参赛主体'],[r=>r.popularity.display,'人气分'],...(r.kind==='final'?[[r=>r.average.display,'评委均分'],[r=>r.total.display,'总分']]:[])]);
 table(box,publicResult.awards.map(a=>({...a,title:r.entries.find(e=>e.id===a.subject_id)?.title})),[['name','奖项'],['title','作品']]);}
async function refresh(){
 current=contests.find(c=>c.id===$('#contest').value);if(!current)return;$('#admin-forms').replaceChildren();$('#workspace').replaceChildren();
 $('#schedule').replaceChildren(el('h2',current.title),el('p',`报名截止：${new Date(current.registration_end).toLocaleString('zh-CN')} · 提交截止：${new Date(current.submission_end).toLocaleString('zh-CN')} · 团队最多 ${current.team_limit} 人`));
 publicResult=await api('results',{contestId:current.id},true);renderResults();
 if(!user)return;const box=$('#workspace');box.replaceChildren(el('h2','我的参赛与评审'));mine=await api('mine',{contestId:current.id},true);
 if(!mine.subject){form(box,'报名参赛','register',[['kind','参赛方式','text',[['personal','个人'],['team','团队']]],['name','个人或团队展示名称'],['realName','真实姓名（仅供管理员核验）'],['studentNumber','学号（仅供管理员核验）']]);
  form(box,'查看邀请','invite-preview',[['token','邀请码']],{onSuccess:(r,detail)=>{detail.querySelector('.invite-preview')?.remove();const result=el('div');result.className='invite-preview';result.append(el('p','邀请你加入：'+r.name));detail.append(result);form(result,'确认加入团队','join',[['realName','真实姓名'],['studentNumber','学号'],['confirm','我确认加入此团队','checkbox']],{defaults:{subjectId:r.id,token:detail.querySelector('[name=token]').value}});}});
 }else{const s=mine.subject;box.append(el('p',`${s.name} · ${mine.member.verified?'学生资格已核验':'等待学生资格人工核验'}`));const defaults={subjectId:s.id};
  if(s.captain_id===user.id){if(s.kind==='team')form(box,'生成7天邀请码','invite',[],{defaults,onSuccess:(r,detail)=>{let output=detail.querySelector('.invite-output');if(!output){output=el('div');output.className='invite-output';output.setAttribute('role','status');detail.append(output);}output.replaceChildren(el('p','邀请码（可选中复制）'),el('code',r.token),el('p','有效期至 '+new Date(r.expires).toLocaleString('zh-CN')));notice('邀请码已生成，请在下方邀请码框中查看。');}});
   form(box,'提交参赛作品','submit',[['workId','创作台中的作品编号'],['confirmAnonymous','我已提交去署名版本，并确认作品包、标题及内容不含身份信息','checkbox']],{defaults});
   form(box,'申请转团队 / 换队长 / 退赛','change',[['kind','变更类型','text',[['convert','个人转团队'],['captain','更换队长'],['withdraw','退赛']]],['successorId','新队长账号编号（其他申请填当前账号编号）'],['reason','申请理由','textarea'],['confirmTransfer','我同意将个人参赛作品转为团队作品','checkbox']],{defaults});
  }else form(box,'申请退出团队','change',[['reason','退出理由','textarea']],{defaults:{...defaults,kind:'leave'}});
  table(box,mine.changes,[['id','申请编号'],['kind','类型'],['state','状态']]);
  if(mine.changes.some(c=>c.state==='pending'))form(box,'同意成员退出 / 接受队长交接','consent',[['changeId','申请编号'],['confirm','我同意此次变更','checkbox']],{defaults});
  if(publicResult?.result?.kind==='final')form(box,'提交成绩申诉','appeal',[['kind','申诉类别','text',[['score_calculation','评分计算错误'],['program','程序计算错误'],['procedure','评审流程违规']]],['body','申诉依据','textarea']],{defaults:{...defaults,resultId:publicResult.result.id}});
 }
 if(user.roles.includes('judge')){const assignments=await api('assignments',{contestId:current.id},true);box.append(el('h3','匿名评审任务'),el('p','平台隐藏身份字段；游戏内容或公开资料仍可能使身份可被推断。发现署名或利益冲突请联系管理员。'));
  for(const [i,r]of assignments.items.entries()){const card=el('article');card.className=r.hidden?'work-hidden':r.featured?'work-featured':'work-normal';card.append(el('h3','评审作品 '+(i+1)),el('p',r.hidden?'已下架 · 暂停试玩和评分':r.featured?'精选':'正常'));if(r.hidden){box.append(card);continue;}box.append(card);const play=el('button','开始匿名试玩');card.append(play);play.onclick=async()=>{play.disabled=true;try{const response=await fetch('/api/games/judge-preview',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subjectId:r.subject_id})}),value=await response.json();if(!response.ok)throw Error(value.error?.code??'加载失败');const frame=el('iframe');frame.title='匿名作品试玩';frame.setAttribute('sandbox','allow-scripts');frame.src=value.src;card.append(frame);}catch(e){notice(e.message);}finally{play.disabled=false;}};
   if(r.locked)card.append(el('p','评分已提交并锁定。'));else form(card,'提交评分','score',[['scores','创新 / 游戏性 / 主题 / 视听 / 稳定性，五项0—100分，用英文逗号分隔'],['comment','整体评价（必填）','textarea']],{defaults:{subjectId:r.subject_id}});
  }
 }
 if(user.roles.includes('admin'))await adminForms();
}
async function adminForms(){const box=$('#admin-forms');box.replaceChildren();$('#admin').hidden=false;
 form(box,'创建比赛','create',[['title','比赛名称'],...['registrationStart','registrationEnd','submissionStart','submissionEnd','reviewStart','reviewEnd'].map((key,i)=>[key,['报名开始','报名截止','提交开始','提交截止','评审开始','评审截止'][i],'datetime-local']),['teamLimit','团队人数上限','number']],{onSuccess:async()=>{await load();}});
 if(!current)return;
 const deletion=form(box,'永久删除此比赛','delete',[['title','输入完整比赛名称：'+current.title]],{sensitive:true,onSuccess:async()=>{current=null;await load();}});deletion.prepend(el('p','永久删除报名、团队、邀请、参赛提交关系、评分、成绩、奖项、申诉和关联通知，无法撤销。创作台原始作品仍保留。'));
 const data=await api('admin',{contestId:current.id},true);table(box,data.subjects,[['id','主体编号'],['name','名称'],['kind','形式']]);table(box,data.members,[['account_id','账号编号'],['subject_id','主体编号'],[r=>r.verified?'已核验':'待核验','资格']]);table(box,data.changes,[['id','申请编号'],['kind','类型'],['state','状态']]);
 form(box,'再验证并查看学生身份材料','identities',[],{sensitive:true,onSuccess:(r,detail)=>table(detail,r.members,[['account_id','账号编号'],['real_name','真实姓名'],['student_number','学号']])});
 const subject=['subjectId','参赛主体','text',data.subjects.filter(x=>!x.withdrawn).map(s=>[s.id,s.name])];
 form(box,'学生资格核验','verify',[subject,['accountId','账号编号'],['approved','决定','text',[['true','通过'],['false','不通过']]],['reason','核验依据','textarea']],{sensitive:true});
 form(box,'审批团队变更','decide',[subject,['changeId','申请编号'],['approved','决定','text',[['true','批准'],['false','拒绝']]],['reason','审批理由','textarea']],{sensitive:true});
 form(box,'自动分配评委','assign',[]);
 form(box,'人工补派评委','assign-judge',[subject,['judgeId','评委账号编号'],['reason','调整理由','textarea']],{sensitive:true});
 form(box,'解锁评分','unlock',[subject,['judgeId','评委账号编号'],['reason','解锁理由','textarea']],{sensitive:true});
 form(box,'作废评分','invalidate',[subject,['judgeId','评委账号编号'],['basis','作废依据','text',[['conflict','利益冲突'],['procedure','流程违规'],['violation','违规评分']]],['reason','说明','textarea']],{sensitive:true});
 form(box,'生成每日人气快照','snapshot',[],{defaults:{final:false}});form(box,'生成待核查最终成绩','snapshot',[],{defaults:{final:true}});
 form(box,'查看成绩核查记录','inspection',[],{read:true,onSuccess:(r,detail)=>{table(detail,r.results,[['id','结果编号'],['version','版本'],['kind','类型'],['published_at','发布时间']]);table(detail,r.risks,[['id','风险编号'],['reason','风险'],['resolution','核查结论']]);table(detail,r.appeals,[['id','申诉编号'],['body','内容'],['resolution','处理结果']]);for(const result of r.results){detail.append(el('h3','成绩版本 '+result.version));table(detail,result.entries,[['title','作品'],[x=>x.average?.display??'—','评委均分'],[x=>x.popularity.display,'人气分'],[x=>x.total?.display??'—','总分']]);}}});
 form(box,'排除违规作品并保留理由','exclude',[['workId','作品编号'],['reason','排除依据','textarea']],{sensitive:true});
 form(box,'结案申诉','resolve-appeal',[['appealId','申诉编号'],['reason','核查结论与处理说明','textarea']],{sensitive:true});
 form(box,'核查完成并发布成绩','publish',[['resultId','待发布结果编号'],['reason','核查结论','textarea'],['awardSubject','获奖主体','text',data.subjects.map(s=>[s.id,s.name])],['awardName','自定义奖项名称']],{sensitive:true});
}
async function load(){current=null;$('#workspace').replaceChildren();$('#admin-forms').replaceChildren();$('#schedule').replaceChildren();const data=await api('list',{},true);contests=data.items;const select=$('#contest');select.replaceChildren();for(const c of contests){const o=el('option',c.title);o.value=c.id;select.append(o);}if(!contests.length){select.append(el('option','尚无比赛'));$('#results').replaceChildren(el('p','新比赛公布后将在这里展示。'));if(user?.roles.includes('admin'))await adminForms();return;}await refresh();}
$('#contest').onchange=async()=>{const selector=$('#contest');selector.disabled=true;try{await refresh();}catch(e){notice(e.message);}finally{selector.disabled=false;}};$('#category').onchange=renderResults;
for(const c of ['动作','射击','益智','冒险','体育','休闲','模拟经营','其他']){const o=el('option',c);o.value=c;$('#category').append(o);}
try{const r=await fetch('/api/identity/me');if(r.ok)user=(await r.json()).user;await load();}catch(e){notice(e.message);}

try{const {result}=await api('global',{},true);const section=el('section');section.append(el('h2','全站每日人气榜'));
 if(result){section.append(el('p','统计截至 '+new Date(result.cutoff).toLocaleString('zh-CN')));const filter=el('select');filter.setAttribute('aria-label','全站榜分类');for(const label of ['全部分类','动作','射击','益智','冒险','体育','休闲','模拟经营','其他']){const o=el('option',label);o.value=label==='全部分类'?'':label;filter.append(o);}const rows=el('div');const draw=()=>{rows.replaceChildren();table(rows,result.entries.filter(e=>!filter.value||e.category===filter.value),[['rank','总榜名次'],['title','作品'],[e=>e.popularity.display,'人气分']]);};filter.onchange=draw;section.append(filter,rows);draw();}
 else section.append(el('p','每日北京时间00:10生成榜单，暂无快照。'));document.querySelector('main').append(section);
}catch{}
