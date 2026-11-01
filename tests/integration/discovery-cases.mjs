import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createDiscoveryService,deletionParticipant} from '../../src/modules/discovery/service.mjs';

export async function discoveryCases(db){
  const migration=await readFile(new URL('../../migrations/006_discovery.up.sql',import.meta.url),'utf8');
  const down=await readFile(new URL('../../migrations/006_discovery.down.sql',import.meta.url),'utf8');
  await db.query(down);await db.query(migration);
  const owner=randomUUID(),other=randomUUID(),team=randomUUID(),ids=[];
  for(const id of [owner,other])await db.query("INSERT INTO platform.accounts(id,status,nickname,email,bio) VALUES($1,'active',$2,$3,'公开简介')",[id,id===owner?'星河作者':'其他作者',id+'@example.test']);
  await db.query('INSERT INTO platform.discovery_teams(id,name,bio,members) VALUES($1,$2,$3,$4)',[team,'像素团队','公开团队简介',JSON.stringify([{nickname:'成员',email:'DO_NOT_LEAK'}])]);
  let current={id:owner,status:'active',roles:[]};
  const service=createDiscoveryService({database:db,identity:{run:async()=>({user:current})}});
  for(let i=0;i<15;i++){
    const id=randomUUID(),version=randomUUID();ids.push(id);
    await db.query('INSERT INTO platform.works(id,owner_id,title) VALUES($1,$2,$3)',[id,owner,'作品'+i]);
    await db.query("INSERT INTO platform.game_versions(id,work_id,status,scan_status,digest,metadata,findings,created_at) VALUES($1,$2,$3,'clean','fixture','{}','[]',CURRENT_TIMESTAMP-($4::integer*interval '1 minute'))",[version,id,i===14?'pending':'approved',i]);
    await db.query('UPDATE platform.works SET published_version=$2 WHERE id=$1',[id,version]);
    await service.edit({workId:id,title:'作品'+i,summary:i===0?'全文'.repeat(3000):'说明 '+i,instructions:'方向键移动',category:i%2?'动作':'益智',tags:['光影标签']},{});
    await db.query('INSERT INTO platform.discovery_metrics(work_id,likes,plays,popularity) VALUES($1,$2,$3,$4)',[id,i,30-i,i/2]);
  }
  await db.query('UPDATE platform.work_profiles SET team_id=$2 WHERE work_id=$1',[ids[0],team]);
  assert.equal((await service.list()).items.length,12);assert.equal((await service.list()).nextOffset,12);assert.equal((await service.list({offset:12})).items.length,2);
  for(const q of ['作品','星河','像素','光影','全文'])assert.ok((await service.list({q})).items.length>0,q);
  assert.equal((await service.list({q:'像素',category:'动作'})).items.length,0);
  assert.equal((await service.list({q:'%'})).items.length,0);
  assert.equal((await service.list({sort:'likes'})).items[0].id,ids[13]);
  assert.equal((await service.list({sort:'plays'})).items[0].id,ids[0]);
  assert.equal((await service.list({sort:'popularity'})).items[0].id,ids[13]);
  assert.equal((await service.detail(ids[0])).summary.length,6000);
  await assert.rejects(service.detail(ids[14]),{code:'NOT_FOUND'});
  await db.query('UPDATE platform.game_versions SET revoked=true WHERE work_id=$1',[ids[13]]);await assert.rejects(service.detail(ids[13]),{code:'NOT_FOUND'});
  assert.equal(JSON.stringify(await service.profile('team',team)).includes('DO_NOT_LEAK'),false);
  assert.equal(JSON.stringify(await service.profile('author',owner)).includes('@example'),false);
  await assert.rejects(service.admin({action:'feature',workId:ids[0],featured:true},{}),{code:'FORBIDDEN'});
  current.roles=['admin'];await service.admin({action:'feature',workId:ids[0],featured:true},{});assert.equal((await service.list({featured:'1'})).items.length,1);
  await service.admin({action:'settings',batchSize:3,blockedTerms:['屏蔽']},{});assert.equal((await service.list()).items.length,3);
  for(let i=0;i<12;i++)await service.record({term:'记录'+i},{sessionToken:'test'});
  assert.equal((await service.history({})).terms.length,10);await service.record({term:'屏蔽词'},{});assert.equal((await service.hot()).terms.some(t=>t.term==='屏蔽词'),false);
  await service.record({term:'guest'},{});assert.ok((await service.hot()).terms.some(t=>t.term==='guest'));
  current={id:other,status:'active',roles:[]};assert.equal((await service.history({})).terms.length,0);
  await assert.rejects(service.edit({workId:ids[0],title:'越权',summary:'s',instructions:'i',category:'动作',tags:[]},{}),{code:'FORBIDDEN'});
  current={id:owner,status:'active',roles:['admin']};await service.clear({});assert.equal((await service.history({})).terms.length,0);
  await db.query("INSERT INTO platform.search_history(account_id,term,searched_at) VALUES($1,'old',CURRENT_TIMESTAMP-interval '91 days')",[owner]);await service.cleanup();assert.equal((await db.query('SELECT * FROM platform.search_history')).rowCount,0);
  await service.record({term:'删除测试'},{sessionToken:'test'});await deletionParticipant.finalize(db,owner);assert.equal((await service.history({})).terms.length,0);
  await assert.rejects(db.query(down),/discovery data is not empty/);
  await service.admin({action:'settings',batchSize:12,blockedTerms:['屏蔽']},{});
  return {owner,team,ids};
}
