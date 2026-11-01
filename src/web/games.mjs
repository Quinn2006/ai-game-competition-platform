const $=selector=>document.querySelector(selector);
const notice=message=>{$('#notice').textContent=message;};
async function api(action,input={}) {
  const response=await fetch('/api/games/'+action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});
  const result=await response.json();if(!response.ok) throw new Error(result.error.message+' ('+result.error.code+')');return result;
}
async function safe(work){try{await work();}catch(error){notice(error.message);}}
function button(label,action){const b=document.createElement('button');b.textContent=label;b.onclick=()=>safe(action);return b;}
if($('#works')) {
  let workId,reviewId,dangerAction,dangerVersion,isAdmin=false,previewPort;
  async function preview(versionId){const p=await api('preview',{workId,versionId});const frame=$('#preview iframe');previewPort?.close();frame.onload=()=>{const channel=new MessageChannel();previewPort=channel.port1;previewPort.onmessage=event=>{if(event.data?.type==='load')previewPort.postMessage({type:'save:loaded',value:null});};frame.contentWindow.postMessage({type:'platform:init'},'*',[channel.port2]);};frame.src=p.src;$('#preview').showModal();}
  async function refresh(){const result=await api('list');$('#works').replaceChildren(...result.works.map(work=>button(work.title,()=>select(work.id))));notice(result.works.length?'请选择作品。':'还没有作品，先创建一件作品。');}
  async function select(id){workId=id;const data=await api('detail',{workId});$('#editor').hidden=false;$('#work-title').textContent=data.work.title;$('#public-link').href='/play?work='+id;
    const actions={created:'创建作品',uploaded:'上传检查',upload_rejected:'上传被拒绝',claim:'领取审核',decide:'审核结论',withdraw:'撤回审核',rollback:'回滚公开版本',revoke:'撤销版本',account_deleted:'账号注销下架'};
    $('#events').textContent=data.events.map(e=>new Date(e.occurred_at).toLocaleString('zh-CN')+' · '+(actions[e.action]??e.action)+(e.detail.reason?'\n'+e.detail.reason:'')).join('\n\n');$('#versions').replaceChildren();
    for(const v of data.versions){const card=document.createElement('article');const info=document.createElement('pre');
      const state=v.revoked?'已撤销':v.withdrawn?'已撤回':({pending:'待审核',reviewing:'审核中',approved:'审核通过',changes:'需要修改',rejected:'审核不通过'})[v.status];
      const scanText={clean:'扫描通过，等待人工复核',infected:'检测到风险，不能预览或审核通过',error:'扫描服务未完成检查，不能预览或审核通过'}[v.scan_status];
      info.textContent=state+' · '+new Date(v.created_at).toLocaleString('zh-CN')+'\n'+scanText+'\n存档版本：'+v.metadata.saveVersion+' · '+(v.metadata.orientation==='portrait'?'竖屏':'横屏')+'\n网络：'+(v.metadata.domains.join('、')||'默认禁网')+'\n代码疑点：'+(v.findings.length?v.findings.map(f=>f.path+'（'+({'dynamic-code':'动态代码',network:'网络请求',navigation:'页面跳转'}[f.kind]??f.kind)+'）').join('、'):'未发现；仍需人工审核');card.append(info);
      const act=async(action,extra={})=>{await api(action,{workId,versionId:v.id,...extra});await select(workId);notice('操作完成。');};
      if(v.scan_status==='clean'&&!v.revoked)card.append(button('隔离预览',()=>preview(v.id)));
      if(['pending','reviewing'].includes(v.status)&&!v.withdrawn)card.append(button('撤回',()=>act('withdraw')));
      if(isAdmin&&v.status==='pending'&&!v.withdrawn)card.append(button('管理员领取',()=>act('claim')));
      if(isAdmin&&v.status==='reviewing'&&!v.withdrawn)card.append(button('管理员审核',()=>{reviewId=v.id;$('#review').showModal();}));
      if(isAdmin&&v.status==='approved'&&!v.revoked)for(const action of ['rollback','revoke'])card.append(button(action==='rollback'?'管理员回滚至此版本':'管理员撤销此版本',async()=>{
        dangerAction=action;dangerVersion=v.id;$('#danger-title').textContent=action==='rollback'?'将公开版本切换到所选历史版本。':'撤销此版本；若当前公开则立即下架。';$('#danger').showModal();
      }));$('#versions').append(card);
    }
  }
  $('#create').onsubmit=event=>{event.preventDefault();safe(async()=>{const result=await api('create',{title:new FormData(event.target).get('title')});await refresh();await select(result.id);});};
  $('#upload').onsubmit=event=>{event.preventDefault();safe(async()=>{const form=event.target,values=new FormData(form),file=values.get('file');const metadata={licensed:values.get('licensed')==='on',orientation:values.get('orientation'),saveVersion:values.get('saveVersion'),domains:values.get('domains').split(/\s+/).filter(Boolean)};form.querySelector('button').disabled=true;$('#progress').hidden=false;
    try{const result=await new Promise((resolve,reject)=>{const xhr=new XMLHttpRequest();xhr.open('POST','/api/games/upload?workId='+workId+'&metadata='+encodeURIComponent(JSON.stringify(metadata)));xhr.setRequestHeader('Content-Type','application/zip');xhr.upload.onprogress=e=>{$('#progress').value=e.lengthComputable?e.loaded/e.total*100:0;notice('正在上传并扫描，请等待…');};xhr.onload=()=>{let result;try{result=JSON.parse(xhr.responseText);}catch{reject(new Error('服务响应无效'));return;}if(xhr.status!==200||result.rejected)reject(new Error(result.code??result.error?.code??'上传失败'));else resolve(result);};xhr.onerror=()=>reject(new Error('网络连接失败'));xhr.send(file);});await select(workId);notice(result.scan==='clean'?'上传及扫描完成，已生成隔离预览。':'上传检查完成。扫描未通过，无法预览或进入人工审核；请查看版本结果。');if(result.scan==='clean')await preview(result.id);}finally{form.querySelector('button').disabled=false;$('#progress').hidden=true;}
  });};
  $('#review-form').onsubmit=event=>{event.preventDefault();safe(async()=>{const v=new FormData(event.target);await api('decide',{workId,versionId:reviewId,status:v.get('status'),category:v.get('category'),reason:v.get('reason'),findingsReviewed:v.get('findingsReviewed')==='on'});$('#review').close();await select(workId);});};
  $('#danger-form').onsubmit=event=>{event.preventDefault();safe(async()=>{const values=new FormData(event.target);const response=await fetch('/api/identity/revalidate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:values.get('password'),code:values.get('code'),action:'admin.dangerous',resourceId:workId})});event.target.reset();const proof=await response.json();if(!response.ok)throw new Error('再验证失败');await api(dangerAction,{workId,versionId:dangerVersion,proof:proof.proof,reason:values.get('reason'),confirmed:values.get('confirmed')==='on'});$('#danger').close();await select(workId);});};
  $('#cancel-danger').onclick=()=>{$('#danger-form').reset();$('#danger').close();};
  $('#cancel-review').onclick=()=>$('#review').close();$('#preview').addEventListener('close',()=>{previewPort?.close();$('#preview iframe').onload=null;$('#preview iframe').src='about:blank';});$('#close-preview').onclick=()=>$('#preview').close();$('#refresh').onclick=()=>safe(refresh);safe(async()=>{const response=await fetch('/api/identity/me');if(response.ok)isAdmin=(await response.json()).user.roles.includes('admin');await refresh();});
} else {
  const frame=$('#game'),workId=new URL(location.href).searchParams.get('work');let port,timer,heartbeat,last=0,seq=0,saveKey,ready=false,rateStart=0,rateCount=0;
  const qr=document.createElement('img');qr.alt='游戏分享二维码';qr.width=160;qr.height=160;qr.src='/api/games/qr?work='+encodeURIComponent(workId);$('#qr').append(qr);
  function stop(){clearTimeout(timer);clearInterval(heartbeat);port?.close();ready=false;}
  function failed(message){stop();frame.src='about:blank';$('#loading').hidden=true;notice(message+'，可点击重试。');}
  async function start(){stop();$('#loading').hidden=false;$('#loading').removeAttribute('value');notice('正在加载…');const response=await fetch('/api/games/play?work='+encodeURIComponent(workId));const config=await response.json();if(!response.ok)throw new Error(config.error.message);$('#title').textContent=config.title;$('#direction').textContent=config.orientation==='portrait'?'建议竖屏游玩':'建议横屏游玩';saveKey='game-save:'+workId+':'+config.saveVersion;seq=0;rateStart=Date.now();rateCount=0;
    frame.onload=()=>{const channel=new MessageChannel();port=channel.port1;port.onmessage=event=>{
      const msg=event.data,now=Date.now();if(now-rateStart>1000){rateStart=now;rateCount=0;}if(++rateCount>60)return;
      if(!msg||!Number.isSafeInteger(msg.seq)||msg.seq<=seq||!['ready','heartbeat','progress','error','save','load','external','sound:blocked'].includes(msg.type))return;seq=msg.seq;
      if(msg.type==='ready'){ready=true;last=now;clearTimeout(timer);$('#loading').hidden=true;notice('游戏已加载。');}
      if(msg.type==='heartbeat')last=now;
      if(msg.type==='error')failed('游戏报告运行错误');
      if(msg.type==='progress'&&Number.isFinite(msg.value)&&msg.value>=0&&msg.value<=100){$('#loading').max=100;$('#loading').value=msg.value;}
      if(msg.type==='sound:blocked')notice('浏览器阻止了自动音效，请点击“开启音效”。');
      if(msg.type==='save')try{const value=JSON.stringify(msg.value);if(value.length<=65536)localStorage.setItem(saveKey,value);else notice('存档过大，未保存。');}catch{notice('浏览器无法保存进度。');}
      if(msg.type==='load')try{port.postMessage({type:'save:loaded',value:JSON.parse(localStorage.getItem(saveKey)??'null')});}catch{notice('无法读取本地存档。');}
      if(msg.type==='external'&&typeof msg.value==='string'&&msg.value.length<=2048){let url;try{url=new URL(msg.value);}catch{return;}if(!['https:','http:'].includes(url.protocol)||url.username||url.password)return;const open=button('打开外部链接：'+url.hostname,()=>{if(confirm('即将离开本站，打开 '+url.href))window.open(url.href,'_blank','noopener,noreferrer');open.remove();});$('#notice').replaceChildren(open);}
    };frame.contentWindow.postMessage({type:'platform:init'},'*',[channel.port2]);};frame.src=config.src;timer=setTimeout(()=>failed('加载超时'),config.loadTimeout);heartbeat=setInterval(()=>{if(ready&&!document.hidden&&Date.now()-last>10000)failed('游戏响应中断');},2000);
  }
  $('#retry').onclick=$('#restart').onclick=()=>safe(start);$('#clear').onclick=()=>{if(saveKey&&confirm('清除当前作品此存档版本的进度？旧版本存档将保留。')){localStorage.removeItem(saveKey);safe(start);}};$('#sound').onclick=()=>port?.postMessage({type:'sound'});$('#fullscreen').onclick=()=>safe(async()=>{if(!document.fullscreenEnabled)throw new Error('当前浏览器不支持全屏');await $('#stage').requestFullscreen();});$('#share').onclick=()=>safe(async()=>{await navigator.clipboard.writeText(location.href);notice('分享链接已复制。');});$('#exit').onclick=()=>{if(confirm('确认退出试玩？')){stop();frame.src='about:blank';notice('已退出试玩。');}};document.addEventListener('visibilitychange',()=>{last=Date.now();});safe(start);
}
