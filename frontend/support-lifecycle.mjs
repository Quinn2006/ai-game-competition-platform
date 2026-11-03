function node(tag,text,parent){const e=document.createElement(tag);e.textContent=text;parent.append(e);return e;}
async function action(button,fn){button.disabled=true;try{await fn();}catch(e){const p=node('p',e.message,button.parentElement);p.setAttribute('role','alert');}finally{button.disabled=false;}}
export async function supportHistory(parent,api){
 const area=node('section','',parent);node('h2','对话与隐私',area);node('p','普通对话最多保存90天。转为正式投诉的记录在结案后保存一年。',area);
 const clear=node('button','清空普通对话',area);clear.type='button';clear.onclick=()=>action(clear,async()=>{const r=await api('chat-delete',{});area.replaceChildren();node('p',r.message,area);});
 for(const chat of (await api('chat-history')).items){const a=node('article','',area);node('p',chat.question,a);node('p',chat.answer,a);if(chat.pending)continue;
 const f=node('form','',a),label=node('label','转为正式投诉：请填写原因',f),reason=node('textarea','',label);reason.required=true;reason.maxLength=2000;
 const b=node('button','提交正式投诉',f);f.onsubmit=e=>{e.preventDefault();action(b,async()=>{await api('complaint',{id:chat.id,reason:reason.value});f.replaceChildren();node('p','正式投诉已提交，可在下方查看处理结果。',f);});};
 }
 node('h3','我的正式投诉',area);for(const c of (await api('my-complaints')).items){node('p',c.reason+'：'+(c.closed_at?c.resolution:'处理中'),area);}
}
export async function complaintInbox(parent,api){
 const area=node('section','',parent);node('h3','正式投诉',area);
 for(const c of (await api('complaints')).items){const f=node('form','',area);node('p',c.reason,f);node('p',c.question+'\n'+c.answer,f);const label=node('label','处理结果',f),answer=node('textarea','',label);answer.required=true;answer.maxLength=2000;const b=node('button','记录结果并结案',f);f.onsubmit=e=>{e.preventDefault();action(b,async()=>{await api('complaint-close',{id:c.id,resolution:answer.value});f.replaceChildren();node('p','已结案，记录将在一年后清理。',f);});};}
}
