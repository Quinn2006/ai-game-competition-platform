export async function communityApi(action,input={},read=false){const r=await fetch('/api/community/'+action+(read?'?'+new URLSearchParams(input):''),read?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});const data=await r.json();if(!r.ok)throw Error(data.error?.message+' ('+data.error?.code+')');return data;}
const node=(tag,text)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;return e;};
export async function mountCommunity(root,workId){
  root.classList.add('community');const status=node('p');status.setAttribute('role','status');const controls=node('nav'),stats=node('p'),thread=node('div'),compose=node('form'),body=node('textarea'),label=node('label','发表评论（登录后可用）');body.id='comment-body';label.htmlFor=body.id;body.required=true;body.maxLength=16000;const submit=node('button','发布评论');compose.append(label,body,submit);root.append(node('h2','玩家社区'),status,stats,controls,compose,thread);
  let state,parentId=null,page=0;const trail=[];
  const safe=async fn=>{try{await fn();status.textContent='';}catch(e){status.textContent=e.message;}};
  function button(text,fn){const b=node('button',text);b.type='button';b.onclick=()=>safe(async()=>{b.disabled=true;try{await fn();}finally{b.disabled=false;}});return b;}
  async function refresh(){state=await communityApi('state',{workId},true);stats.textContent=`${state.likes} 个点赞 · ${state.plays} 次有效试玩`;controls.replaceChildren(button(state.liked?'取消点赞':'点赞',async()=>{await communityApi('like',{workId,active:!state.liked});await refresh();}),button(state.favorite?'取消收藏':'收藏',async()=>{await communityApi('favorite',{workId,active:!state.favorite});await refresh();}));const a=node('a','我的收藏');a.href='/favorites';controls.append(a);if(!state.userId){const login=node('a','登录后参与');login.href='/account';controls.append(login);}body.disabled=submit.disabled=!state.userId;}
  async function comments(){
    const data=await communityApi('comments',{workId,offset:page*20,...(parentId?{parentId}:{})},true);thread.replaceChildren();
    if(parentId)thread.append(node('p','正在查看回复；新评论将回复当前楼层。'),button('返回上层',async()=>{parentId=trail.pop()??null;page=0;await comments();}));
    if(!data.items.length)thread.append(node('p','这里还没有评论。'));
    for(const c of data.items){const card=node('article');card.append(node('small',c.nickname+' · '+new Date(c.created_at).toLocaleString('zh-CN')),node('p',c.deleted?'该评论已删除':c.body));card.append(button(c.replies?'查看回复 / 回复':'回复',async()=>{trail.push(parentId);parentId=c.id;page=0;await comments();body.focus();}));if(!c.deleted&&(state.admin||state.userId===c.account_id))card.append(button('删除',async()=>{if(confirm('删除此评论？已有回复会保留。')){await communityApi('delete-comment',{workId,id:c.id});await comments();}}));thread.append(card);}
    if(page)thread.append(button('上一页',async()=>{page--;await comments();}));if(data.items.length===20)thread.append(button('下一页',async()=>{page++;await comments();}));
  }
  compose.onsubmit=e=>{e.preventDefault();safe(async()=>{submit.disabled=true;try{await communityApi('comment',{workId,body:body.value,parentId});body.value='';page=0;await comments();}finally{submit.disabled=false;}});};
  await safe(async()=>{await communityApi('merge');await refresh();await comments();});
}
async function standalone(){
  const root=document.querySelector('#community');if(!root)return;root.classList.add('community');const status=node('p');status.setAttribute('role','status');root.append(status);let offset=0;
  const more=node('button','加载更多');more.type='button';
  async function load(){more.disabled=true;try{
    const admin=location.pathname==='/community/admin';document.querySelector('h1').textContent=admin?'评论治理与异常队列':'我的收藏';
    const data=await communityApi(admin?'risks':'favorites',{offset},true);
    if(admin&&offset===0){const form=node('form'),label=node('label','过滤词（每行一个）'),words=node('textarea'),save=node('button','保存过滤词');label.append(words);words.value=data.words.join('\n');form.append(label,save);form.onsubmit=async e=>{e.preventDefault();try{await communityApi('words',{words:words.value.split('\n').map(w=>w.trim()).filter(Boolean)});status.textContent='已保存';}catch(e){status.textContent=e.message;}};root.append(form);}
    if(!data.items.length&&offset===0)root.append(node('p',admin?'暂无异常记录':'还没有收藏公开作品。'));
    for(const item of data.items){const card=node('article');if(admin){card.append(node('p',`${item.reason} · ${new Date(item.created_at).toLocaleString()} · ${item.resolved_at?'已处理':'待核查'}`));if(!item.resolved_at){const resolve=node('button','记录核查结论');resolve.onclick=async()=>{const reason=prompt('请输入核查结论');if(!reason)return;try{await communityApi('resolve',{id:item.id,reason});resolve.disabled=true;status.textContent='已记录';}catch(e){status.textContent=e.message;}};card.append(resolve);}}else{const a=node('a',item.title);a.href='/work?id='+item.id;const remove=node('button','取消收藏');remove.onclick=async()=>{try{await communityApi('favorite',{workId:item.id,active:false});card.remove();}catch(e){status.textContent=e.message;}};card.append(a,remove);}root.append(card);}
    offset+=data.items.length;more.hidden=data.items.length<50;root.append(more);
  }catch(e){status.textContent=e.message;}finally{more.disabled=false;}}
  more.onclick=load;await load();
}
standalone();
