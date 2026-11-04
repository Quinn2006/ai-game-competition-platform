const links=[['发现','/'],['排行榜','/rankings'],['比赛中心','/competitions'],['创作台','/studio'],['我的收藏','/favorites'],['我的账号','/account'],['公告','/announcements'],['通知','/notifications'],['帮助','/help'],['反馈','/feedback'],['AI 客服','/support'],['服务状态','/status']];
const adminLinks=[['运营后台','/admin'],['作品审核','/admin/reviews'],['比赛管理','/competitions#admin'],['账号角色','/account#roles'],['发现页管理','/catalog/admin'],['社区管理','/community/admin']];
const root=document.querySelector('.platform-nav'),row=root.querySelector('.platform-links');
function render(user){
 const items=user?.roles?.includes('admin')?[...links,...adminLinks]:links;
 row.replaceChildren(...items.map(([label,href])=>{const a=document.createElement('a');a.textContent=label;a.href=href;
  const path=location.pathname==='/discover'?'/':location.pathname;
  if(a.pathname===path&&a.hash===location.hash)a.setAttribute('aria-current','page');
  return a;
 }));
 // Keep the selected entry reachable on narrow screens without moving the page.
 const current=row.querySelector('[aria-current]');if(current)row.scrollLeft=Math.max(0,current.offsetLeft-row.offsetLeft-row.clientWidth+current.offsetWidth+16);
}
let user=null,revision=0;
render(user);
document.addEventListener('platform-user',event=>{revision++;user=event.detail;render(user);});
window.addEventListener('hashchange',()=>render(user));
const requestRevision=revision;
fetch('/api/identity/me').then(async response=>response.ok?(await response.json()).user:null).then(value=>{if(revision===requestRevision){user=value;render(user);}}).catch(()=>{});
if(location.pathname==='/play'&&new URLSearchParams(location.search).get('embed')==='1')root.hidden=true;
