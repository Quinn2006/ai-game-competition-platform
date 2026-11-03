import { createDiscoveryService } from '../../backend/src/modules/discovery/service.mjs';
import { importCollection } from '../../backend/src/modules/uploads/collection.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createIdentityService } from '../../backend/src/modules/identity/service.mjs';
import { newToken,digest } from '../../backend/src/modules/identity/crypto.mjs';
import { createUploadService,deletionParticipant } from '../../backend/src/modules/uploads/service.mjs';
import { zipFixture } from '../zip-fixture.mjs';
import { createLocalStorage } from '../../backend/src/platform/local-storage.mjs';

export async function collectionCases(database){
  const storage=createLocalStorage('tmp/upload-tests/'+randomUUID(),'test');
  const identity=createIdentityService({database,secret:'synthetic-upload-test-key-32-characters',mail:async()=>{}});
  async function actor(admin=false){
    const id=randomUUID(),token=newToken();
    await database.query("INSERT INTO platform.accounts(id,status,roles,mfa_secret) VALUES ($1,'active',$2,$3)",[id,admin?['admin']:[],admin?'synthetic-test-factor':null]);
    await database.query("INSERT INTO platform.sessions(token_hash,account_id,expires_at) VALUES ($1,$2,CURRENT_TIMESTAMP+interval '1 hour')",[digest(token),id]);
    return {id,sessionToken:token,requestId:randomUUID()};
  }
  const owner=await actor(),other=await actor();
  const collectedService=createUploadService({identity,storage,scan:async()=>({status:'clean'})});
  const collectedWork=await collectedService.run('create',{title:'Collected'},owner);
  const collection={workId:collectedWork.id,sourceId:'synthetic-nutstore-1',zip:zipFixture([['index.html','hello']]),metadata:{licensed:true,orientation:'landscape',saveVersion:'v1'},profile:{title:'Collected',summary:'简介原件',instructions:'Play',category:'益智',tags:[]},screenshots:[{type:'png',bytes:Buffer.from([137,80,78,71,13,10,26,10])}]};
  const dependencies={identity,storage,scan:async()=>({status:'clean'}),limits:{compressed:100000,expanded:300000,files:50}};
  await assert.rejects(importCollection(dependencies,collection,other),/owner/);
  const imported=await importCollection(dependencies,collection,owner);
  assert.equal(imported.files.length,2);
  assert.equal((await storage.get('review',imported.files[0].key)).toString(),'简介原件');
  assert.equal((await importCollection(dependencies,collection,owner)).duplicate,true);
  await assert.rejects(importCollection(dependencies,{...collection,profile:{...collection.profile,summary:'changed'}},owner),/different/);
  assert.equal((await database.query('SELECT status FROM platform.game_versions WHERE id=$1',[imported.id])).rows[0].status,'pending');
  const badWork=await collectedService.run('create',{title:'Bad attachment'},owner);
  await assert.rejects(importCollection({...dependencies,scan:async bytes=>({status:bytes.equals(Buffer.from('简介原件'))?'infected':'clean'})},{...collection,workId:badWork.id},owner),/scan/);
  assert.equal((await database.query('SELECT count(*)::int AS n FROM platform.game_versions WHERE work_id=$1',[badWork.id])).rows[0].n,0);

  const discovery=createDiscoveryService({database,identity,storage});
  await discovery.edit({...collection.profile,summary:'edited summary',workId:collectedWork.id},owner);
  const saved=(await database.query("SELECT detail FROM platform.upload_events WHERE work_id=$1 AND action='profile_files'",[collectedWork.id])).rows[0].detail.files[0];
  assert.equal((await storage.get(saved.area,saved.key)).toString(),'edited summary');
  console.log('PASS: collection import, owner authorization, duplicates, attachment persistence and rollback');
}
