import {communityApi} from '/community/ui.mjs';
const $=selector=>document.querySelector(selector);
const notice=message=>{$('#notice').textContent=message;};
async function api(action,input={}) {
  const response=await fetch('/api/games/'+action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});
  const result=await response.json();if(!response.ok) throw new Error(result.error.message+' ('+result.error.code+')');return result;
}
async function safe(work){try{await work();}catch(error){notice(error.message);}}
function button(label,action){const b=document.createElement('button');b.textContent=label;b.onclick=()=>safe(action);return b;}
if($('#works')) {
  let workId,reviewId,dangerAction,dangerVersion,isAdmin=false,userId=null,selection=0,previewPort,profile=null,uploading=false,uploadLimits;
  async function preview(versionId){const p=await api('preview',{workId,versionId});const frame=$('#preview iframe');previewPort?.close();frame.onload=()=>{const channel=new MessageChannel();previewPort=channel.port1;previewPort.onmessage=event=>{if(event.data?.type==='load')previewPort.postMessage({type:'save:loaded',value:null});};frame.contentWindow.postMessage({type:'platform:init'},'*',[channel.port2]);};frame.src=p.src;$('#preview').showModal();}
  const reviewMode=location.pathname==='/admin/reviews';document.body.classList.toggle('review-workspace',reviewMode);
  async function refresh(){const result=await api('list',{scope:reviewMode?'review':'mine'});$('#works').replaceChildren(...result.works.map(work=>{const b=button((reviewMode?'审核作品：':'编辑作品：')+work.title+' · '+(work.hidden?'已下架':reviewMode?'待审核 / 审核中':work.featured?'精选':work.published_version?'已发布':'未发布'),()=>select(work.id));b.className=work.hidden?'work-hidden':work.featured?'work-featured':'work-normal';if(work.hidden)b.title='作品已被管理员下架，暂时无法公开试玩。请查看通知或联系管理员。';return b;}));notice(result.works.length?(reviewMode?'选择作品开始审核。':'选择作品编辑或查看审核进度。'):(reviewMode?'暂无待审核作品。':'你还没有创建作品，可以在左侧开始创作。'));}
  async function select(id){const run=++selection;$('#editor').hidden=true;const data=await api('detail',{workId:id});if(run!==selection)return;workId=id;$('#editor').hidden=false;$('#work-title').textContent=data.work.title;$('#public-link').href='/work?id='+id;$('#public-link').hidden=!data.work.published_version;$('#upload').hidden=reviewMode||data.work.owner_id!==userId;const edit=document.createElement('a');edit.href='/catalog/edit?id='+id;edit.textContent='编辑公开资料';edit.hidden=reviewMode||data.work.owner_id!==userId;document.querySelector('#catalog-edit')?.remove();edit.id='catalog-edit';$('#public-link').after(edit);
    profile=data.profile;
    const form=$('#upload');
    for(const [field,value] of Object.entries({publicTitle:profile?.title??data.work.title,summary:profile?.summary??'',instructions:profile?.instructions??'',category:profile?.category??'其他'}))form.elements[field].value=value;
    const latest=data.versions[0];if(latest){form.elements.orientation.value=latest.metadata.orientation;form.elements.saveVersion.value=latest.metadata.saveVersion;form.elements.domains.value=latest.metadata.domains.join('\n');}
    $('#publication-status').textContent=!profile?'请补齐公开资料，管理员才能审核发布。':data.work.published_version?'已发布：所有玩家无需登录即可查看和游玩。':'公开资料已齐全；扫描和审核通过后将自动出现在发现页。';
    if(reviewMode&&profile)$('#publication-status').textContent+='\n'+profile.title+' · '+profile.category+'\n简介：'+profile.summary+'\n操作说明：'+profile.instructions;
    const pending=data.versions.some(v=>['pending','reviewing'].includes(v.status)&&!v.withdrawn);
    $('#upload-fields').disabled=pending;
    $('#upload-status').textContent=pending?'已有待审核版本；如需重新上传，请先撤回。':'';
    const actions={created:'创建作品',profile_files:'保存公开资料',uploaded:'上传检查',upload_rejected:'上传被拒绝',claim:'领取审核',decide:'审核结论',withdraw:'撤回审核',rollback:'回滚公开版本',revoke:'撤销版本',account_deleted:'账号注销下架'};
    $('#events').textContent=data.events.map(e=>new Date(e.occurred_at).toLocaleString('zh-CN')+' · '+(actions[e.action]??e.action)+(e.detail.reason?'\n'+e.detail.reason:'')).join('\n\n');$('#versions').replaceChildren();
    for(const v of data.versions){const card=document.createElement('article');const info=document.createElement('pre');
      const state=v.revoked?'已撤销':v.withdrawn?'已撤回':({pending:'待审核',reviewing:'审核中',approved:'审核通过',changes:'需要修改',rejected:'审核不通过'})[v.status];
      const scanText={clean:'扫描通过',infected:'检测到风险，不能预览或审核通过',error:'扫描服务未完成检查，不能预览或审核通过'}[v.scan_status];
      info.textContent=state+' · '+new Date(v.created_at).toLocaleString('zh-CN')+'\n'+scanText+'\n存档版本：'+v.metadata.saveVersion+' · '+(v.metadata.orientation==='portrait'?'竖屏':'横屏')+'\n网络：'+(v.metadata.domains.join('、')||'默认禁网')+'\n代码疑点：'+(v.findings.length?v.findings.map(f=>f.path+'（'+({'dynamic-code':'动态代码',network:'网络请求',navigation:'页面跳转'}[f.kind]??f.kind)+'）').join('、'):'未发现；仍需人工审核');card.append(info);
      const act=async(action,extra={})=>{await api(action,{workId,versionId:v.id,...extra});await select(workId);notice('操作完成。');};
      if(v.scan_status==='clean'&&!v.revoked)card.append(button('隔离预览',()=>preview(v.id)));
      if(!reviewMode&&data.work.owner_id===userId&&['pending','reviewing'].includes(v.status)&&!v.withdrawn)card.append(button('撤回',()=>act('withdraw')));
      if(reviewMode&&isAdmin&&v.status==='pending'&&!v.withdrawn&&v.scan_status==='clean')card.append(button('管理员领取',()=>act('claim')));
      if(reviewMode&&isAdmin&&v.status==='reviewing'&&!v.withdrawn)card.append(button('管理员审核',()=>{reviewId=v.id;$('#review').showModal();}));
      if(reviewMode&&isAdmin&&v.status==='approved'&&!v.revoked)for(const action of ['rollback','revoke'])card.append(button(action==='rollback'?'管理员回滚至此版本':'管理员撤销此版本',async()=>{
        dangerAction=action;dangerVersion=v.id;$('#danger-title').textContent=action==='rollback'?'将公开版本切换到所选历史版本。':'撤销此版本；若当前公开则立即下架。';$('#danger').showModal();
      }));$('#versions').append(card);
    }
    if(!data.versions.length)$('#versions').textContent=reviewMode?'此作品尚未上传可审核版本。':'还没有上传版本，请使用上方表单上传 ZIP。';
    $('#editor').focus({preventScroll:true});$('#editor').scrollIntoView({block:'start'});
  }
  $('#create').onsubmit=event=>{event.preventDefault();safe(async()=>{const result=await api('create',{title:new FormData(event.target).get('title')});await refresh();await select(result.id);});};
  $('#upload').onsubmit=event=>{event.preventDefault();if(uploading)return;safe(async()=>{
    const form=event.target,values=new FormData(form),file=values.get('file'),target=workId;
    if(!file?.size||!file.name.toLowerCase().endsWith('.zip'))throw new Error('请选择非空 ZIP 游戏包。');
    if(!uploadLimits)throw new Error('无法读取上传限额，请刷新后重试。');
    if(file.size>uploadLimits.compressed)throw new Error('游戏包超过上传限额：'+(uploadLimits.compressed/1000000)+' MB。');
    const metadata={licensed:values.get('licensed')==='on',orientation:values.get('orientation'),saveVersion:values.get('saveVersion'),domains:values.get('domains').split(/\s+/).filter(Boolean)};
    const controls=[...document.querySelectorAll('#works button,#create input,#create button,#refresh,#versions button')];
    const disabled=controls.map(control=>control.disabled);controls.forEach(control=>control.disabled=true);
    uploading=true;$('#upload-fields').disabled=true;$('#progress').hidden=false;$('#progress').value=0;
    const status=text=>{$('#upload-status').textContent=text;notice(text);};
    try{
      status('正在保存公开资料…');
      const response=await fetch('/api/discovery/edit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({workId:target,title:values.get('publicTitle'),summary:values.get('summary'),instructions:values.get('instructions'),category:values.get('category'),tags:profile?.tags??[],cover:profile?.cover??''})});
      const saved=await response.json();if(!response.ok)throw new Error(saved.error?.message??'公开资料保存失败');
      const result=await new Promise((resolve,reject)=>{
        const xhr=new XMLHttpRequest();xhr.open('POST','/api/games/upload?workId='+target+'&metadata='+encodeURIComponent(JSON.stringify(metadata)));xhr.setRequestHeader('Content-Type','application/zip');xhr.timeout=600000;
        xhr.upload.onprogress=e=>{const percent=e.lengthComputable?Math.round(e.loaded/e.total*100):0;$('#progress').value=percent;status('正在上传：'+percent+'%');};
        xhr.upload.onload=()=>{$('#progress').removeAttribute('value');status('文件已传输，正在扫描和检查结构，请勿关闭页面…');};
        xhr.onload=()=>{let result;try{result=JSON.parse(xhr.responseText);}catch{reject(new Error('服务响应无效，请刷新作品检查结果后重试。'));return;}if(xhr.status!==200||result.rejected){const code=result.code??result.error?.code;const messages={ROOT_ENTRY_REQUIRED:'ZIP 根目录必须包含 index.html。',ZIP_LIMIT:'压缩包超过大小或文件数量限制。',FILE_TYPE:'压缩包包含不支持的文件类型。',UPLOAD_BUSY:'其他作品正在上传，请稍后重试。',WITHDRAW_REQUIRED:'请先撤回已有的待审核版本。',SUBMISSION_CLOSED:'作品提交已截止。'};reject(new Error(messages[code]??(result.error?.message??'上传失败')+'（'+(code??xhr.status)+'）'));}else resolve(result);};
        xhr.onerror=()=>reject(new Error('网络连接失败，请刷新作品检查是否已接收，再重试。'));
        xhr.ontimeout=()=>reject(new Error('上传或扫描超时，请刷新作品检查结果，避免重复提交。'));
        xhr.onabort=()=>reject(new Error('上传已中断。'));xhr.send(file);
      });
      await refresh();await select(target);form.elements.file.value='';form.elements.licensed.checked=false;
      status(result.scan==='clean'?'上传及扫描通过，已提交管理员审核；通过后自动公开。':'扫描未通过，无法发布。请查看版本结果；扫描服务异常时请联系管理员检查 ClamAV。');
      if(result.scan==='clean')await preview(result.id);
    }catch(error){$('#upload-fields').disabled=false;status(error.message);}
    finally{uploading=false;controls.forEach((control,i)=>control.disabled=disabled[i]);$('#progress').hidden=true;}
  });};
  $('#review-form').onsubmit=event=>{event.preventDefault();safe(async()=>{const v=new FormData(event.target);await api('decide',{workId,versionId:reviewId,status:v.get('status'),category:v.get('category'),reason:v.get('reason'),findingsReviewed:v.get('findingsReviewed')==='on'});$('#review').close();await refresh();await select(workId);});};
  $('#danger-form').onsubmit=event=>{event.preventDefault();safe(async()=>{const values=new FormData(event.target);const response=await fetch('/api/identity/revalidate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:values.get('password'),code:values.get('code'),action:'admin.dangerous',resourceId:workId,confirmed:values.get('confirmed')==='on'})});event.target.reset();const proof=await response.json();if(!response.ok)throw new Error('再验证失败');await api(dangerAction,{workId,versionId:dangerVersion,proof:proof.proof,reason:values.get('reason'),confirmed:values.get('confirmed')==='on'});$('#danger').close();await select(workId);});};
  $('#cancel-danger').onclick=()=>{$('#danger-form').reset();$('#danger').close();};
  $('#cancel-review').onclick=()=>$('#review').close();$('#preview').addEventListener('close',()=>{previewPort?.close();$('#preview iframe').onload=null;$('#preview iframe').src='about:blank';});$('#close-preview').onclick=()=>$('#preview').close();$('#refresh').onclick=()=>safe(refresh);safe(async()=>{const response=await fetch('/api/identity/me');if(response.ok){const user=(await response.json()).user;isAdmin=user.roles.includes('admin');userId=user.id;}$('#review-entry').hidden=!isAdmin;
    if(reviewMode){document.querySelector('.campus-page-heading .campus-kicker').textContent='运营后台 / 作品审核';$('#works-panel .campus-kicker').textContent='审核队列';document.title='作品审核 · 运营后台';document.querySelector('h1').textContent='作品审核';document.querySelector('.campus-page-heading>p:last-child').textContent='领取待审核版本，隔离试玩并提交技术审核结论。';$('#create-panel').hidden=true;$('#works-heading').textContent='待审核作品';$('#works-help').textContent='这里只列出扫描通过、等待审核或审核中的作品。';$('#review-entry').href='/admin';$('#review-entry').textContent='返回运营后台';if(!isAdmin){$('#works-help').textContent='请使用管理员账号登录后审核。';notice('此页面仅向管理员开放。');return;}}
    if(!reviewMode){const response=await fetch('/api/games/limits');if(!response.ok)throw new Error('上传服务尚未就绪，请联系管理员检查数据库和扫描服务配置。');uploadLimits=await response.json();$('#upload-limits').textContent='根目录须包含 index.html。限额：压缩 '+uploadLimits.compressed/1000000+' MB / 解压 '+uploadLimits.expanded/1000000+' MB / '+uploadLimits.files+' 个条目。';}
    await refresh();const requested=new URLSearchParams(location.search).get('work');if(requested)await select(requested);});
} else {
  const frame=$('#game'),workId=new URL(location.href).searchParams.get('work');let port,timer,heartbeat,last=0,seq=0,saveKey,ready=false,rateStart=0,rateCount=0,generation=0;
  const qr=document.createElement('img');qr.alt='游戏分享二维码';qr.width=160;qr.height=160;qr.src='/api/games/qr?work='+encodeURIComponent(workId);$('#qr').append(qr);
  let playToken=null,playSequence=0,interacted=false,signalChain=Promise.resolve();
  function signal(kind='tick'){const token=playToken;if(!token)return;const input={token,sequence:++playSequence,kind,foreground:!document.hidden,interacted,healthy:ready&&Date.now()-last<5000};signalChain=signalChain.then(()=>communityApi('signal',input)).catch(()=>{});if(kind!=='tick')playToken=null;}
  function stop(){signal('end');generation++;clearTimeout(timer);clearInterval(heartbeat);port?.close();frame.onload=null;ready=false;}
  function failed(message){signal('error');stop();frame.src='about:blank';$('#loading').hidden=true;notice(message+'，可点击重试。');}
  async function start(){stop();const current=generation;frame.src='about:blank';$('#loading').hidden=false;$('#loading').removeAttribute('value');notice('正在加载…');let config;try{const response=await fetch('/api/games/play?work='+encodeURIComponent(workId));config=await response.json();if(!response.ok)throw new Error(config.error.message);const session=await communityApi('start',{workId});if(current!==generation){const token=session.token;if(token)communityApi('signal',{token,sequence:1,kind:'error',foreground:false,interacted:false,healthy:false}).catch(()=>{});return;}playToken=session.token;playSequence=0;interacted=false;}catch(error){if(current===generation)failed(error.message);return;}if(current!==generation)return;$('#title').textContent=config.title;$('#direction').textContent=config.orientation==='portrait'?'建议竖屏游玩':'建议横屏游玩';saveKey='game-save:'+workId+':'+config.saveVersion;seq=0;rateStart=Date.now();rateCount=0;
    frame.onload=()=>{if(current!==generation)return;port?.close();const channel=new MessageChannel();port=channel.port1;port.onmessage=event=>{
      if(current!==generation)return;
      const msg=event.data,now=Date.now();if(now-rateStart>1000){rateStart=now;rateCount=0;}if(++rateCount>60)return;
      if(!msg||!Number.isSafeInteger(msg.seq)||msg.seq<=seq||!['interaction','ready','heartbeat','progress','error','save','load','external','sound:blocked'].includes(msg.type))return;seq=msg.seq;
      if(msg.type==='interaction')interacted=true;
      if(msg.type==='ready'){ready=true;last=now;clearTimeout(timer);$('#loading').hidden=true;notice('游戏已加载。');}
      if(msg.type==='heartbeat')last=now;
      if(msg.type==='error')failed('游戏报告运行错误');
      if(msg.type==='progress'&&Number.isFinite(msg.value)&&msg.value>=0&&msg.value<=100){$('#loading').max=100;$('#loading').value=msg.value;}
      if(msg.type==='sound:blocked')notice('浏览器阻止了自动音效，请点击“开启音效”。');
      if(msg.type==='save')try{const value=JSON.stringify(msg.value);if(value.length<=65536)localStorage.setItem(saveKey,value);else notice('存档过大，未保存。');}catch{notice('浏览器无法保存进度。');}
      if(msg.type==='load')try{port.postMessage({type:'save:loaded',value:JSON.parse(localStorage.getItem(saveKey)??'null')});}catch{notice('无法读取本地存档。');}
      if(msg.type==='external'&&typeof msg.value==='string'&&msg.value.length<=2048){let url;try{url=new URL(msg.value);}catch{return;}if(!['https:','http:'].includes(url.protocol)||url.username||url.password)return;const open=button('打开外部链接：'+url.hostname,()=>{if(confirm('即将离开本站，打开 '+url.href))window.open(url.href,'_blank','noopener,noreferrer');open.remove();});$('#notice').replaceChildren(open);}
    };frame.contentWindow.postMessage({type:'platform:init'},'*',[channel.port2]);};frame.src=config.src;timer=setTimeout(()=>failed('加载超时'),config.loadTimeout);heartbeat=setInterval(()=>{if(ready)signal();if(ready&&!document.hidden&&Date.now()-last>10000)failed('游戏响应中断');},2000);
  }
  $('#retry').onclick=$('#restart').onclick=()=>safe(start);$('#clear').onclick=()=>{if(saveKey&&confirm('清除当前作品此存档版本的进度？旧版本存档将保留。')){localStorage.removeItem(saveKey);safe(start);}};$('#sound').onclick=()=>port?.postMessage({type:'sound'});$('#fullscreen').onclick=()=>safe(async()=>{if(!document.fullscreenEnabled)throw new Error('当前浏览器不支持全屏');await $('#stage').requestFullscreen();});$('#share').onclick=()=>safe(async()=>{await navigator.clipboard.writeText(location.href);notice('分享链接已复制。');});$('#exit').onclick=()=>{if(confirm('确认退出试玩？')){stop();frame.src='about:blank';$('#loading').hidden=true;notice('已退出试玩。');}};document.addEventListener('visibilitychange',()=>{signal();last=Date.now();});window.addEventListener('pagehide',()=>signal('end'));safe(start);
}
