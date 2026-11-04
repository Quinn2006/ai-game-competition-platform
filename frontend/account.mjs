const content = document.querySelector('#content'), message = document.querySelector('#message');
let currentUser = null;
function notice(text, failed = false) { message.textContent = text; message.className = failed ? 'error' : 'success'; }
async function api(action, data) {
  const response = await fetch(`/api/identity/${action}`, data ? { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data) } : {});
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message ?? '请求失败');
  return result;
}
function show(name) {
  if(['roles','admin'].includes(name)&&!currentUser?.roles.includes('admin'))name=currentUser?'profile':'login';
  document.dispatchEvent(new CustomEvent('platform-user',{detail:currentUser}));
  if (currentUser?.roles.includes('admin') && !currentUser.mfaEnabled && ['profile','admin','roles','delete'].includes(name)) name='security';
  const template = document.getElementById(name);
  if (!template || !(template instanceof HTMLTemplateElement)) return;
  content.replaceChildren(template.content.cloneNode(true));
  document.querySelector('#nav').hidden = currentUser !== null;
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('selected', b.dataset.view === name));
  if (name === 'profile' && currentUser) {
    content.querySelector('#email').textContent = currentUser.email;
    content.querySelector('[name=nickname]').value = currentUser.nickname;
    content.querySelector('[name=bio]').value = currentUser.bio;
    if (currentUser.roles.includes('admin')) {
      const button = document.createElement('button'); button.textContent = '管理员资料核查'; button.dataset.view = 'admin'; content.querySelector('#admin-entry').append(button);
      const roles = document.createElement('button'); roles.textContent='账号角色管理';roles.dataset.view='roles';content.querySelector('#admin-entry').append(roles);
    }
  }
  if (name === 'security' && currentUser?.mfaEnabled) { content.querySelector('form').remove(); const p=document.createElement('p');p.textContent='两步验证已开启。请妥善保管恢复码。';content.querySelector('#enroll').append(p); }
}
document.addEventListener('click', async e => {
  const target = e.target.closest('button');
  if (target?.dataset.view) { notice(''); show(target.dataset.view); }
  if (target?.id === 'logout') {
    target.disabled=true;
    try { await api('logout',{}); currentUser=null; show('login'); notice('已退出登录。'); } catch(e) {notice(e.message,true);target.disabled=false;}
  }
});
document.addEventListener('submit', async e => {
  e.preventDefault(); const form=e.target, action=form.dataset.action;
  const data=Object.fromEntries(new FormData(form));
  if(action==='delete') data.confirmed=form.elements.confirmed.checked;
  if(action==='revalidate') {data.action=form.dataset.operation==='roles'?'admin.dangerous':'admin.sensitive';if(form.elements.confirmed)data.confirmed=form.elements.confirmed.checked;}
  const button=form.querySelector('button');button.disabled=true;notice('正在处理…');
  try {
    const result=await api(action,data);
    if(result.user) currentUser=result.user;
    form.querySelectorAll('input[type=password]').forEach(x=>{x.value='';});
    if(action==='login') show(result.setupOnly?'security':'profile');
    if(action==='delete') {currentUser=null;show('login');}
    if(action==='mfa/setup') {
      const area=document.querySelector('#enroll');area.replaceChildren();
      const pre=document.createElement('pre');pre.textContent=`验证器密钥：${result.secret}`;area.append(pre);
      const f=document.createElement('form');f.dataset.action='mfa/enable';
      f.innerHTML='<label>验证器当前验证码<input name="code" inputmode="numeric" autocomplete="one-time-code" required pattern="[0-9]{6}"></label><button class="primary">确认开启</button>';area.append(f);
    }
    if(action==='mfa/enable') {currentUser.mfaEnabled=true;show('security');const pre=document.createElement('pre');pre.textContent='恢复码仅显示一次，请保存在安全位置：\n'+result.recovery.join('\n');document.querySelector('#enroll').append(pre);}
    if(action==='revalidate') {
      if(form.dataset.operation==='roles') {await api('admin/roles',{resourceId:data.resourceId,proof:result.proof,roles:data.roles?[data.roles]:[],confirmed:data.confirmed});}
      else {const sensitive=await api('admin/profile',{resourceId:data.resourceId,proof:result.proof});document.querySelector('#admin-result').textContent=JSON.stringify(sensitive.user,null,2);}
    }
    notice(result.message??'操作完成。');
  } catch(e) {notice(e.message,true);} finally {button.disabled=false;}
});
async function renderRoute() {
const fragment=new URLSearchParams(location.hash.slice(1));
const purpose=['verify','reset','cancel'].find(x=>fragment.has(x));
if(purpose){
  history.replaceState(null,'','/account');show('login');notice('邮箱验证与重置链接已停用，请使用本机管理工具。');
}else{
  show('login');
  try {const result=await api('me');currentUser=result.user;const requested=location.hash.slice(1);show(result.setupOnly?'security':['profile','security','delete','roles','admin'].includes(requested)?requested:'profile');} catch(e) {if(!e.message.includes('登录')) notice(e.message,true);}
}
}
window.addEventListener('hashchange',renderRoute);
await renderRoute();
