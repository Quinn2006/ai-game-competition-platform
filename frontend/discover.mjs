import {mountCommunity} from '/community/ui.mjs';
import {readHistory,saveHistory} from '/catalog/history.mjs';
const $=s=>document.querySelector(s),cats=['动作','射击','益智','冒险','体育','休闲','模拟经营','其他'];
const params=new URLSearchParams(location.search);let next=null,busy=false,user=null,serial=0,savedCover='';
for(const id of ['campus-hero','campus-themes'])document.getElementById(id).hidden=!['/','/discover'].includes(location.pathname);
for(const anchor of document.querySelectorAll('header nav a'))if(anchor.pathname===location.pathname||(anchor.pathname==='/'&&location.pathname==='/discover'))anchor.setAttribute('aria-current','page');
function node(tag,text,cls){const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;}
function link(text,url){const e=node('a',text);e.href=url;return e;}
function message(text,error=false){$('#status').textContent=text;$('#status').className=error?'error':'';}
async function api(action,input,post=false){const r=await fetch('/api/discovery/'+action+(post?'':input?'?'+new URLSearchParams(input):''),post?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input??{})}:{});const data=await r.json();if(!r.ok)throw Error(data.error?.message??'加载失败，请重试');return data;}
function cover(work){const box=node('div',undefined,'cover');box.append(node('span','PLAY'));if(/^data:image\/(png|jpeg|webp);base64,/.test(work.cover??'')){const img=node('img');img.src=work.cover;img.alt=work.title+'封面';img.addEventListener('error',()=>img.remove());box.append(img);}return box;}
function author(work){return work.team?link(work.team.name,'/team?id='+work.team.id):link(work.author.nickname,'/author?id='+work.author.id);}
function card(work){const c=node('article',undefined,'card'),body=node('div',undefined,'card-content');c.append(cover(work),body);const tags=node('div',undefined,'tagline');for(const t of [work.category,...work.tags])tags.append(node('span',t));const title=node('h3');title.append(link(work.title,'/work?id='+work.id));body.append(tags,title,node('p',work.summary,'summary'));const by=node('div',undefined,'byline');by.append(author(work));const stats=node('div',undefined,'stats');stats.append(node('span','点赞 '+(work.likes??'暂无统计')),node('span','有效试玩 '+(work.plays??'暂无统计')));body.append(by,stats);return c;}
function terms(target,items){target.replaceChildren();for(const item of items){const b=node('button',item.term);b.type='button';b.onclick=()=>{$('#query').value=item.term;$('#search').requestSubmit();};target.append(b);}}
async function history(){try{terms($('#history'),user?(await api('history')).terms:readHistory(localStorage));$('#history-note').textContent=user?'仅当前账号可见，最多保存 10 条，90 天到期。':'游客历史保存在此浏览器，最多保存 10 条，90 天到期。';}catch{message('搜索历史暂时不可用',true);}}
async function load(append=false){
  const run=++serial;busy=true;$('#more').disabled=true;$('#retry').hidden=true;message('正在加载作品…');
  try{
    const input={q:$('#query').value,category:$('#category').value,sort:$('#sort').value,offset:append?next??0:0};
    if(location.pathname==='/author')input.author=params.get('id');if(location.pathname==='/team')input.team=params.get('id');
    const data=await api('list',input);if(run!==serial)return;
    if(!append)$('#results').replaceChildren();for(const w of data.items)$('#results').append(card(w));
    next=data.nextOffset;$('#more').hidden=next===null;const count=$('#results').children.length;
    $('#count').textContent=`已展示 ${count} 款`;
    if(!count)$('#results').append(node('p','暂时没有符合条件的作品。试试其他关键词或分类。','empty'));
    message(count?'作品已更新':'暂无作品');
  }catch(e){if(run!==serial)return;message(e.message,true);$('#retry').hidden=false;}
  finally{if(run===serial){busy=false;$('#more').disabled=false;}}
}
for(const c of cats){$('#category').append(new Option(c,c));$('#edit-category').append(new Option(c,c));}
$('#query').value=params.get('q')??'';$('#category').value=params.get('category')??'';
$('#search').onsubmit=async e=>{e.preventDefault();const term=$('#query').value.normalize('NFKC').trim().replace(/\s+/gu,' ').toLocaleLowerCase('zh-CN');$('#query').value=term;const q=new URLSearchParams(location.search);q.set('q',term);q.set('category',$('#category').value);window.history.replaceState(null,'',location.pathname+'?'+q);if(term){if(!user)saveHistory(localStorage,term);try{await api('record',{term},true);terms($('#hot'),(await api('hot')).terms);}catch(err){message(err.message,true);}await history();}await load();};
$('#category').onchange=()=>load();$('#sort').onchange=()=>load();$('#more').onclick=()=>{if(!busy)load(true);};$('#retry').onclick=()=>location.reload();
$('#clear').onclick=async()=>{try{if(user)await api('clear',{},true);else localStorage.removeItem('game-search');await history();message('搜索历史已清空');}catch(e){message(e.message,true);}};
async function submit(form,action,convert){form.onsubmit=async e=>{e.preventDefault();const b=form.querySelector('button');b.disabled=true;try{await api(action,await convert(Object.fromEntries(new FormData(form))),true);message('保存成功');}catch(err){message(err.message,true);}finally{b.disabled=false;}};}
const coverLabel=node('label','自定义封面（PNG/JPEG/WebP，最大 500 KB，可选）'),coverInput=node('input');coverInput.type='file';coverInput.accept='image/png,image/jpeg,image/webp';coverInput.name='coverFile';coverLabel.append(coverInput);$('#edit-form').insertBefore(coverLabel,$('#edit-form button'));
submit($('#edit-form'),'edit',async v=>{let cover=savedCover;if(v.coverFile?.size){if(v.coverFile.size>500000)throw Error('封面不能超过 500 KB');cover=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(Error('无法读取封面'));r.readAsDataURL(v.coverFile);});}const {coverFile,...rest}=v;return {...rest,cover,tags:v.tags.split(/[,，]/).map(t=>t.trim()).filter(Boolean)};});
submit($('#settings-form'),'admin',v=>({...v,action:'settings',batchSize:Number(v.batchSize),blockedTerms:v.blockedTerms.split('\n').map(t=>t.trim()).filter(Boolean)}));
submit($('#feature-form'),'admin',v=>({...v,action:'feature',featured:v.featured==='true'}));
async function init(){
  try{const r=await fetch('/api/identity/me');if(r.ok)user=(await r.json()).user;}catch{}
  const path=location.pathname;
  if(['/work','/rankings','/catalog/edit','/catalog/admin'].includes(path)){$('#browse').hidden=true;$('#results-section').hidden=true;}
  if(path==='/rankings'){$('#title').textContent='公开排行榜';$('#intro').textContent='看见每一份被喜爱的创意';const panel=$('#detail');panel.hidden=false;panel.append(node('h2','人气总榜与分类榜'),node('p','当前尚无已发布榜单。赛事统计接入并经核查发布后，可在这里查看总榜与八类分类榜。'));const list=node('p',cats.join(' · '));panel.append(list);return;}
  if(path==='/catalog/edit'||path==='/catalog/admin'){
    $('#title').textContent=path.endsWith('edit')?'完善作品资料':'发现页管理';$('#intro').textContent='';
    if(!user||(path.endsWith('admin')&&!user.roles.includes('admin'))){message('请使用有权限的账号登录后操作',true);return;}
    $(path.endsWith('edit')?'#editor':'#admin').hidden=false;$('#edit-form').elements.workId.value=params.get('id')??'';if(path.endsWith('edit')&&params.get('id')){try{const draft=await api('draft',{id:params.get('id')});for(const key of ['title','summary','instructions','category'])$('#edit-form').elements[key].value=draft[key];$('#edit-form').elements.tags.value=draft.tags.join(',');savedCover=draft.cover;}catch{message('请填写资料；已有资料无法读取时，请刷新重试。',true);}}if(path.endsWith('admin')){const settings=await api('settings');$('#settings-form').elements.batchSize.value=settings.batch_size;$('#settings-form').elements.blockedTerms.value=settings.blocked_terms.join('\n');}return;
  }
  if(path==='/work'){
    const work=await api('detail',{id:params.get('id')});$('#title').textContent=work.title;document.title=work.title+' · 小游戏实验场';$('#intro').textContent=work.category;
    const panel=$('#detail');panel.hidden=false;panel.append(cover(work),author(work),node('h2','游戏简介'),node('p',work.summary),node('h2','操作说明'),node('p',work.instructions));
    const capabilities=await api('capabilities');
    if(capabilities.play){const frame=node('iframe');frame.title='试玩 '+work.title;frame.src='/play?embed=1&work='+encodeURIComponent(work.id);frame.width='100%';frame.height='650';frame.allow='autoplay; fullscreen';panel.append(frame,link('打开独立试玩页','/play?work='+encodeURIComponent(work.id)));}
    else panel.append(node('p','试玩服务暂未开放。','muted'));
    const community=document.createElement('section');panel.append(community);await mountCommunity(community,work.id);
    return;
  }
  if(path==='/author'||path==='/team'){
    const p=await api('profile',{kind:path.slice(1),id:params.get('id')});$('#title').textContent=p.nickname??p.name;$('#intro').textContent='公开作品';const panel=$('#profile');panel.hidden=false;
    if(p.avatar&&/^\/avatars\/[\w.-]+$/.test(p.avatar)){const img=node('img');img.src=p.avatar;img.alt='作者头像';panel.append(img);}else panel.append(node('span','创作者','muted'));
    panel.append(node('p',p.bio||'还没有填写简介'));if(p.members)panel.append(node('p','团队成员：'+p.members.map(m=>m.nickname).join('、')));
  }else{
    const featured=await api('list',{featured:'1'});if(featured.items.length){$('#featured-section').hidden=false;for(const w of featured.items)$('#featured').append(card(w));}
  }
  await history();terms($('#hot'),(await api('hot')).terms);await load();
}
init().catch(e=>{message(e.message,true);$('#retry').hidden=false;});

if(location.pathname==='/'){
 fetch('/api/competition/awards').then(r=>r.ok?r.json():{items:[]}).then(({items})=>{
  if(!items.length)return;const section=node('section');section.append(node('h2','获奖作品'));
  for(const award of items)section.append(node('p',award.contest+' · '+award.name+' · '+award.title));
  section.append(link('查看比赛与完整成绩','/competitions'));$('#main').append(section);
 }).catch(()=>{});
}
