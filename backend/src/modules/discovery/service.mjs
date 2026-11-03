import { AppError } from '../../platform/errors.mjs';
import { createHash, randomUUID } from 'node:crypto';

export const categories = ['动作','射击','益智','冒险','体育','休闲','模拟经营','其他'];
export const sorts = { duration:'(m.duration_ms::numeric / NULLIF(m.plays,0)) DESC NULLS LAST', latest:'COALESCE(pub.published_at,v.created_at) DESC', likes:'m.likes DESC NULLS LAST', plays:'m.plays DESC NULLS LAST', popularity:'m.popularity DESC NULLS LAST' };
const fail = (code,status=400,message='请求无效') => { throw new AppError(code,status,message); };
const uuid = value => typeof value==='string' && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
export function termOf(value='') {
  if(typeof value!=='string' || [...value].length>100) fail('INVALID_QUERY');
  return value.normalize('NFKC').trim().replace(/\s+/gu,' ').toLocaleLowerCase('zh-CN');
}
export function profileOf(input) {
  const result={};
  for(const [key,max] of [['title',100],['summary',10000],['instructions',5000]]) {
    if(typeof input[key]!=='string' || !input[key].trim() || [...input[key]].length>max) fail('INVALID_PROFILE');
    result[key]=input[key].trim();
  }
  if(!categories.includes(input.category) || !Array.isArray(input.tags) || input.tags.length>10 || input.tags.some(t=>typeof t!=='string'||!t.trim()||[...t].length>30)) fail('INVALID_PROFILE');
  // Small raster covers only: no remote trackers, SVG, or script-bearing formats.
  const cover=input.cover??'';
  if(typeof cover!=='string' || cover.length>700000 || (cover && !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(cover))) fail('INVALID_COVER');
  if(cover){const b=Buffer.from(cover.split(',')[1],'base64');const valid=cover.startsWith('data:image/png;')?b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):cover.startsWith('data:image/jpeg;')?b[0]===255&&b[1]===216&&b[2]===255:b.subarray(0,4).toString()==='RIFF'&&b.subarray(8,12).toString()==='WEBP';if(!valid)fail('INVALID_COVER');}
  return {...result,category:input.category,tags:[...new Set(input.tags.map(t=>t.trim()))],cover};
}
const from = `FROM platform.works w JOIN platform.game_versions v ON v.id=w.published_version AND v.work_id=w.id
  JOIN platform.work_profiles p ON p.work_id=w.id JOIN platform.accounts a ON a.id=w.owner_id
  LEFT JOIN LATERAL (SELECT max(occurred_at) AS published_at FROM platform.upload_events e WHERE e.work_id=w.id AND e.version_id=v.id AND (e.action='rollback' OR (e.action='decide' AND e.detail->>'status'='approved'))) pub ON true
  LEFT JOIN platform.discovery_teams t ON t.id=p.team_id LEFT JOIN platform.discovery_metrics m ON m.work_id=w.id`;
const visible = `v.status='approved' AND NOT v.revoked AND NOT v.withdrawn AND v.scan_status='clean' AND a.status='active'`;
const fields = `w.id,p.title,p.summary,p.instructions,p.category,p.tags,p.cover,
  a.id AS author_id,a.nickname AS author_name,t.id AS team_id,t.name AS team_name,
  m.likes,m.plays,m.popularity,COALESCE(pub.published_at,v.created_at) AS published_at`;
export function publicWork(r) {
  return {id:r.id,title:r.title,summary:r.summary,instructions:r.instructions,category:r.category,tags:r.tags,cover:r.cover,
    author:{id:r.author_id,nickname:r.author_name},team:r.team_id?{id:r.team_id,name:r.team_name}:null,
    likes:r.likes===null?null:Number(r.likes),plays:r.plays===null?null:Number(r.plays),popularity:r.popularity,publishedAt:r.published_at};
}
export const deletionParticipant={async check(){},async finalize(c,id){if((await c.query("SELECT to_regclass('platform.search_history') AS name")).rows[0].name)await c.query('DELETE FROM platform.search_history WHERE account_id=$1',[id]);}};

export function createDiscoveryService({database,identity,storage}) {
  const query=(sql,args)=>database.query(sql,args);
  async function transaction(fn) {const c=await database.connect();try{await c.query('BEGIN');const r=await fn(c);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
  async function user(context) {
    if(!identity) fail('AUTH_REQUIRED',401,'请先登录');
    const result=await identity.run('me',{},context);
    if(result.setupOnly || result.user.status!=='active') fail('FORBIDDEN',403);
    return result.user;
  }
  async function settings(){return (await query('SELECT batch_size,blocked_terms FROM platform.discovery_settings WHERE id=true')).rows[0];}
  async function list(input={}) {
    const q=termOf(input.q),category=input.category??'',sort=input.sort??'latest',offset=Number(input.offset??0);
    if(category && !categories.includes(category)) fail('INVALID_CATEGORY');
    if(!Object.hasOwn(sorts,sort)||!Number.isSafeInteger(offset)||offset<0||offset>100000) fail('INVALID_QUERY');
    const {batch_size:limit}=await settings();
    const args=[],where=[visible];
    const add=(sql,value)=>{args.push(value);where.push(sql.replaceAll('?',`$${args.length}`));};
    if(q) add(`(p.title ILIKE ? ESCAPE '\\' OR a.nickname ILIKE ? ESCAPE '\\' OR t.name ILIKE ? ESCAPE '\\' OR array_to_string(p.tags,' ') ILIKE ? ESCAPE '\\' OR p.summary ILIKE ? ESCAPE '\\')`,'%'+q.replace(/[\\%_]/g,'\\$&')+'%');
    if(category) add('p.category=?',category);
    if(input.author){if(!uuid(input.author))fail('NOT_FOUND',404);add('a.id=?',input.author);}
    if(input.team){if(!uuid(input.team))fail('NOT_FOUND',404);add('t.id=?',input.team);}
    if(input.featured==='1') where.push('p.featured');
    args.push(limit+1,offset);
    const rows=(await query(`SELECT ${fields} ${from} WHERE ${where.join(' AND ')} ORDER BY ${sorts[sort]},w.id ASC LIMIT $${args.length-1} OFFSET $${args.length}`,args)).rows;
    return {items:rows.slice(0,limit).map(publicWork),nextOffset:rows.length>limit?offset+limit:null,batchSize:limit};
  }
  return {
    async ready(){return Boolean((await query("SELECT to_regclass('platform.work_profiles') AS name")).rows[0].name);},
    list,
    async draft(input,context){const u=await user(context);if(!uuid(input.id))fail('NOT_FOUND',404);const row=(await query('SELECT p.* FROM platform.work_profiles p JOIN platform.works w ON w.id=p.work_id WHERE w.id=$1 AND w.owner_id=$2',[input.id,u.id])).rows[0];if(!row)fail('NOT_FOUND',404);return row;},
    async settings(input,context){const u=await user(context);if(!u.roles.includes('admin'))fail('FORBIDDEN',403);return settings();},
    async detail(id){if(!uuid(id))fail('NOT_FOUND',404);const row=(await query(`SELECT ${fields} ${from} WHERE ${visible} AND w.id=$1`,[id])).rows[0];if(!row)fail('NOT_FOUND',404);return publicWork(row);},
    async profile(kind,id){
      if(!uuid(id)||!['author','team'].includes(kind))fail('NOT_FOUND',404);
      const row=(await query(kind==='author'?"SELECT id,nickname,bio,avatar FROM platform.accounts WHERE id=$1 AND status='active'":'SELECT id,name,bio,members FROM platform.discovery_teams WHERE id=$1',[id])).rows[0];
      if(!row)fail('NOT_FOUND',404);
      return kind==='author'?{id:row.id,nickname:row.nickname,bio:row.bio,avatar:row.avatar}:{id:row.id,name:row.name,bio:row.bio,members:row.members.map(m=>({nickname:m.nickname}))};
    },
    async history(context){const u=await user(context);return {terms:(await query("SELECT term,searched_at FROM platform.search_history WHERE account_id=$1 AND searched_at>CURRENT_TIMESTAMP-interval '90 days' ORDER BY searched_at DESC,term LIMIT 10",[u.id])).rows};},
    async clear(context){const u=await user(context);await query('DELETE FROM platform.search_history WHERE account_id=$1',[u.id]);return {ok:true};},
    async record(input,context){
      const term=termOf(input.term);if(!term)return {ok:true};
      const u=context.sessionToken?await user(context):null;
      const {blocked_terms}=await settings();
      const allowed=!blocked_terms.some(word=>term.includes(termOf(word)))&&!/[\p{Cc}\p{Cf}]/u.test(term)&&!/(https?:|@|\d{7})/u.test(term);
      await transaction(async c=>{
        if(u){
          await c.query('SELECT id FROM platform.accounts WHERE id=$1 FOR UPDATE',[u.id]);
          await c.query('INSERT INTO platform.search_history(account_id,term) VALUES($1,$2) ON CONFLICT(account_id,term) DO UPDATE SET searched_at=CURRENT_TIMESTAMP',[u.id,term]);
          await c.query(`DELETE FROM platform.search_history WHERE account_id=$1 AND (searched_at<=CURRENT_TIMESTAMP-interval '90 days' OR term NOT IN (SELECT term FROM platform.search_history WHERE account_id=$1 ORDER BY searched_at DESC,term LIMIT 10))`,[u.id]);
        }
        if(allowed) await c.query("INSERT INTO platform.search_counts(day,term,count) VALUES((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date,$1,1) ON CONFLICT(day,term) DO UPDATE SET count=platform.search_counts.count+1",[term]);
      });return {ok:true};
    },
    async hot(){const {blocked_terms}=await settings();return {terms:(await query("SELECT term,sum(count)::integer AS count FROM platform.search_counts WHERE day>=(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date-6 AND NOT EXISTS(SELECT FROM unnest($1::text[]) b WHERE position(lower(b) in term)>0) GROUP BY term ORDER BY sum(count) DESC,term LIMIT 10",[blocked_terms])).rows};},
    async edit(input,context){
      const u=await user(context),p=profileOf(input);if(!uuid(input.workId))fail('NOT_FOUND',404);
      await transaction(async c=>{
        const w=(await c.query('SELECT owner_id FROM platform.works WHERE id=$1 FOR UPDATE',[input.workId])).rows[0];
        if(!w)fail('NOT_FOUND',404);if(w.owner_id!==u.id)fail('FORBIDDEN',403);
        if(storage){
          const files=[];
          for(const [kind,bytes] of [['summary',Buffer.from(input.summary)],...(p.cover?[['cover',Buffer.from(p.cover.split(',')[1],'base64')]]:[])]){
            const sha256=createHash('sha256').update(bytes).digest('hex'),key=`${input.workId}-${kind}-${sha256}`;
            await storage.put('review',key,bytes);files.push({kind,key,area:'review',sha256});
          }
          await c.query("INSERT INTO platform.upload_events(id,work_id,actor_id,action,detail) VALUES($1,$2,$3,'profile_files',$4)",[randomUUID(),input.workId,u.id,{files}]);
        }
        await c.query(`INSERT INTO platform.work_profiles(work_id,title,summary,instructions,category,tags,cover) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(work_id) DO UPDATE SET title=$2,summary=$3,instructions=$4,category=$5,tags=$6,cover=$7`,[input.workId,p.title,p.summary,p.instructions,p.category,p.tags,p.cover]);
        await c.query("INSERT INTO platform.discovery_events(actor_id,action,work_id) VALUES($1,'profile_updated',$2)",[u.id,input.workId]);
      });return {ok:true};
    },
    async admin(input,context){
      const u=await user(context);if(!u.roles.includes('admin'))fail('FORBIDDEN',403);
      await transaction(async c=>{
        if(input.action==='feature'){
          if(!uuid(input.workId)||typeof input.featured!=='boolean')fail('INVALID_INPUT');
          const r=await c.query('UPDATE platform.work_profiles SET featured=$2 WHERE work_id=$1',[input.workId,input.featured]);if(!r.rowCount)fail('NOT_FOUND',404);
        } else if(input.action==='settings'){
          if(!Number.isInteger(input.batchSize)||input.batchSize<1||input.batchSize>60||!Array.isArray(input.blockedTerms)||input.blockedTerms.length>200)fail('INVALID_INPUT');
          const terms=input.blockedTerms.map(termOf);if(terms.some(t=>!t))fail('INVALID_INPUT');
          await c.query('UPDATE platform.discovery_settings SET batch_size=$1,blocked_terms=$2 WHERE id=true',[input.batchSize,terms]);
        } else fail('INVALID_INPUT');
        await c.query('INSERT INTO platform.discovery_events(actor_id,action,work_id) VALUES($1,$2,$3)',[u.id,input.action,input.action==='feature'?input.workId:null]);
      });return {ok:true};
    },
    async cleanup(){if(!(await query("SELECT to_regclass('platform.search_history') AS name")).rows[0].name)return;await query("DELETE FROM platform.search_history WHERE searched_at<=CURRENT_TIMESTAMP-interval '90 days' OR account_id IN (SELECT id FROM platform.accounts WHERE status='deleted')");await query("DELETE FROM platform.search_counts WHERE day<(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date-6");await query("DELETE FROM platform.discovery_events WHERE occurred_at<CURRENT_TIMESTAMP-interval '6 months'");},
  };
}
