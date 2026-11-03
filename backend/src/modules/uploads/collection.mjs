import { createHash } from 'node:crypto';
import { createUploadService } from './service.mjs';
import { profileOf } from '../discovery/service.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
// Imported material follows exactly the existing owner's upload/scanning/review gates.
export async function importCollection({identity,storage,scan,limits,deadline},input,context) {
  if(typeof input.sourceId!=='string'||!input.sourceId.trim()||input.sourceId.length>200)throw Error('Source identifier required');
  if(!Buffer.isBuffer(input.zip)||input.zip.length>limits.compressed)throw Error('ZIP size invalid');
  if(!Array.isArray(input.screenshots)||input.screenshots.length>8)throw Error('At most eight screenshots');
  const profile=profileOf({...input.profile,cover:''});
  const attachments=[{kind:'summary',bytes:Buffer.from(input.profile.summary),extension:'txt'}];
  for(const shot of input.screenshots){
    if(!Buffer.isBuffer(shot.bytes)||shot.bytes.length>500000||!['png','jpeg','webp'].includes(shot.type))throw Error('Invalid screenshot');
    profileOf({...profile,cover:`data:image/${shot.type};base64,${shot.bytes.toString('base64')}`});
    attachments.push({kind:'screenshot',bytes:shot.bytes,extension:shot.type});
  }
  const digest=hash(Buffer.from(JSON.stringify({zip:hash(input.zip),profile,metadata:input.metadata,files:attachments.map(a=>hash(a.bytes))})));
  return identity.authorized(context,async(c,user)=>{
    // Serializes retries across processes; no remote collection path is treated as an identity.
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`collection:${input.workId}:${input.sourceId}`]);
    const work=(await c.query('SELECT owner_id FROM platform.works WHERE id=$1 FOR UPDATE',[input.workId])).rows[0];
    if(work?.owner_id!==user.id)throw Error('Only the work owner may import');
    const prior=(await c.query("SELECT version_id,detail FROM platform.upload_events WHERE work_id=$1 AND action='collection_import' AND detail->>'sourceId'=$2",[input.workId,input.sourceId])).rows[0];
    if(prior){if(prior.detail.digest!==digest)throw Error('Source identifier already used for different material');return {id:prior.version_id,duplicate:true};}
    // Use the same authorization transaction for the version and its source/attachment record.
    const uploads=createUploadService({identity:{authorized:async(_,fn)=>fn(c,user)},storage,scan,limits,deadline});
    const result=await uploads.run('upload',{...input.metadata,workId:input.workId},context,input.zip);
    if(result.rejected)return result;
    const files=[];
    for(const [index,a] of attachments.entries()){
      const key=`${result.id}-${index}-${a.extension}`;
      await storage.put('quarantine',key,a.bytes);
      const verdict=await scan(a.bytes);
      if(verdict.status!=='clean')throw Error('Attachment scan did not pass');
      await storage.put('review',key,a.bytes);
      files.push({kind:a.kind,key,area:'review',sha256:hash(a.bytes),bytes:a.bytes.length});
    }
    // Preserve existing published/editorial profiles; initial imported summary seeds only a missing profile.
    await c.query('INSERT INTO platform.work_profiles(work_id,title,summary,instructions,category,tags) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(work_id) DO NOTHING',[input.workId,profile.title,profile.summary,profile.instructions,profile.category,profile.tags]);
    await c.query("INSERT INTO platform.upload_events(id,work_id,version_id,actor_id,action,detail) VALUES(gen_random_uuid(),$1,$2,$3,'collection_import',$4)",[input.workId,result.id,user.id,{provider:'nutstore',sourceId:input.sourceId,digest,files}]);
    return {...result,files};
  });
}
