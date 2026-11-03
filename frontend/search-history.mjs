const age=90*86400000;
export function recent(items,now=Date.now()) {
  const seen=new Set();
  return items.filter(x=>x&&typeof x.term==='string'&&typeof x.time==='number'&&x.time<=now&&x.time>now-age)
    .sort((a,b)=>b.time-a.time).filter(x=>{if(seen.has(x.term))return false;seen.add(x.term);return true;}).slice(0,10);
}
export function readHistory(storage,now=Date.now()) {
  try{const value=JSON.parse(storage.getItem('game-search')??'[]');const result=recent(Array.isArray(value)?value:[],now);storage.setItem('game-search',JSON.stringify(result));return result;}catch{return [];}
}
export function saveHistory(storage,term,now=Date.now()) {
  const result=recent([{term,time:now},...readHistory(storage,now)],now);
  try{storage.setItem('game-search',JSON.stringify(result));}catch{}return result;
}
