import { randomUUID, createHash } from 'node:crypto';
import { AppError } from '../../platform/errors.mjs';
import { inspectZip, defaultLimits } from './zip.mjs';

const fail = (code, status = 400) => { throw new AppError(code, status, '操作未完成，请检查权限、版本状态、扫描结果及必填内容'); };
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
export function networkOrigins(value) {
  if (!Array.isArray(value) || value.length > 20) fail('INVALID_DOMAINS');
  return [...new Set(value.map(item => {
    let url; try { url = new URL(item); } catch { fail('INVALID_DOMAINS'); }
    if (url.protocol !== 'https:' || url.origin !== item || url.username || url.password || url.port ||
      !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(url.hostname)) fail('INVALID_DOMAINS');
    return url.origin;
  }))];
}
export const deletionParticipant = {
  async check() {},
  async finalize(c, accountId) {
    const works = (await c.query('UPDATE platform.works SET published_version=NULL,owner_id=NULL WHERE owner_id=$1 RETURNING id', [accountId])).rows;
    for (const work of works) await c.query('INSERT INTO platform.upload_events (id,work_id,actor_id,action,detail) VALUES ($1,$2,$3,$4,$5)', [randomUUID(),work.id,null,'account_deleted',{}]);
  },
};

export function createUploadService({ database, identity, storage, scan, limits = defaultLimits, deadline = null, clock = () => Date.now() }) {
  let uploading = false;
  const audit = (c, actor, action, work, version, detail = {}) => c.query(
    'INSERT INTO platform.upload_events (id,actor_id,action,work_id,version_id,detail) VALUES ($1,$2,$3,$4,$5,$6)',
    [randomUUID(),actor,action,work,version,detail]);
  async function workFor(c, id) {
    if (!uuid(id)) fail('NOT_FOUND', 404);
    const row = (await c.query('SELECT * FROM platform.works WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!row) fail('NOT_FOUND', 404);
    return row;
  }
  const own = (user, work) => { if (work.owner_id !== user.id) fail('FORBIDDEN', 403); };
  const admin = user => { if (!user.roles.includes('admin')) fail('FORBIDDEN', 403); };
  const beforeDeadline = () => { if (deadline !== null && clock() >= deadline) fail('SUBMISSION_CLOSED', 409); };
  return {
    async run(action, input, context, bytes) {
      if (action === 'upload' && uploading) fail('UPLOAD_BUSY', 429);
      if (action === 'upload') uploading = true;
      try {
        return await identity.authorized(context, async (c, user) => {
          if (action === 'list') {
            const scope=input.scope??'mine';if(!['mine','review'].includes(scope))fail('INVALID_SCOPE');
            if(scope==='review')admin(user);
            return {works:(await c.query(`SELECT w.*,EXISTS(SELECT 1 FROM platform.operations_hidden h WHERE h.work_id=w.id) AS hidden,COALESCE(p.featured,false) AS featured
              FROM platform.works w LEFT JOIN platform.work_profiles p ON p.work_id=w.id
              WHERE ${scope==='review'?"EXISTS(SELECT 1 FROM platform.game_versions v WHERE v.work_id=w.id AND v.status IN ('pending','reviewing') AND NOT v.withdrawn AND v.scan_status='clean')":'w.owner_id=$1'}
              ORDER BY w.created_at DESC LIMIT 100`,scope==='review'?[]:[user.id])).rows};
          }
          if (action === 'create') {
            if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 200) fail('INVALID_TITLE');
            const id = randomUUID();
            await c.query('INSERT INTO platform.works (id,owner_id,title) VALUES ($1,$2,$3)', [id,user.id,input.title.trim()]);
            await audit(c,user.id,'created',id,null);
            return { id };
          }
          const work = await workFor(c,input.workId);
          if (action === 'detail') {
            if (work.owner_id !== user.id) admin(user);
            return { work, versions: (await c.query('SELECT * FROM platform.game_versions WHERE work_id=$1 ORDER BY created_at DESC', [work.id])).rows,
              events: (await c.query('SELECT action,version_id,detail,occurred_at FROM platform.upload_events WHERE work_id=$1 ORDER BY occurred_at DESC', [work.id])).rows };
          }
          if (action === 'upload') {
            own(user, work); beforeDeadline();
            if (input.licensed !== true) fail('LICENSE_REQUIRED');
            if ((await c.query("SELECT id FROM platform.game_versions WHERE work_id=$1 AND status IN ('pending','reviewing') AND NOT withdrawn", [work.id])).rowCount) fail('WITHDRAW_REQUIRED', 409);
            const domains = networkOrigins(input.domains ?? []);
            if (domains.length && !work.published_version) fail('NETWORK_REQUIRES_APPROVED_WORK');
            if (!['landscape','portrait'].includes(input.orientation) || !/^[a-zA-Z0-9_-]{1,40}$/.test(input.saveVersion)) fail('INVALID_METADATA');
            const id = randomUUID(), digest = createHash('sha256').update(bytes).digest('hex');
            await storage.put('quarantine',id,bytes);
            let archive, result;
            try { result = await scan(bytes); } catch { result = { status: 'error', engine: 'unavailable' }; }
            try { archive = await inspectZip(bytes, limits); }
            catch (error) {
              await audit(c,user.id,'upload_rejected',work.id,null,{ objectId:id,digest,scan:result.status,code:error.code ?? 'INVALID_ZIP' });
              return { rejected: true, code: error.code ?? 'INVALID_ZIP' };
            }
            if (result.status === 'clean') {
              for (const data of archive.files.values()) {
                try { result = await scan(data); } catch { result = { status: 'error', engine: 'unavailable' }; }
                if (result.status !== 'clean') break;
              }
            }
            const status = ['clean','infected'].includes(result.status) ? result.status : 'error';
            if (status === 'clean') await storage.put('review',id,bytes);
            const metadata = { domains,orientation:input.orientation,saveVersion:input.saveVersion,licensed:true };
            await c.query('INSERT INTO platform.game_versions (id,work_id,status,digest,metadata,findings,scan_status) VALUES ($1,$2,$3,$4,$5,$6,$7)', [id,work.id,'pending',digest,metadata,JSON.stringify(archive.findings),status]);
            await audit(c,user.id,'uploaded',work.id,id,{ digest,scan:status,engine:result.engine });
            return { id, scan:status, findings:archive.findings };
          }
          if (!uuid(input.versionId)) fail('NOT_FOUND',404);
          const version = (await c.query('SELECT * FROM platform.game_versions WHERE id=$1 AND work_id=$2 FOR UPDATE',[input.versionId,work.id])).rows[0];
          if (!version) fail('NOT_FOUND',404);
          if (action === 'withdraw') {
            own(user,work);
            if (!['pending','reviewing'].includes(version.status) || version.withdrawn) fail('INVALID_TRANSITION',409);
            await c.query('UPDATE platform.game_versions SET withdrawn=true WHERE id=$1',[version.id]);
          } else {
            admin(user);
            if (action === 'claim') {
              if (version.status !== 'pending' || version.withdrawn || version.scan_status !== 'clean') fail('INVALID_TRANSITION',409);
              await c.query("UPDATE platform.game_versions SET status='reviewing' WHERE id=$1",[version.id]);
            } else if (action === 'decide') {
              if (version.status !== 'reviewing' || version.withdrawn || !['approved','changes','rejected'].includes(input.status)) fail('INVALID_TRANSITION',409);
              if (typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 4000) fail('REASON_REQUIRED');
              if (input.status === 'approved') {
                if (version.scan_status !== 'clean' || input.findingsReviewed !== true) fail('REVIEW_REQUIRED');
                await storage.put('release',version.id,await storage.get('review',version.id));
                await c.query('UPDATE platform.works SET published_version=$2 WHERE id=$1',[work.id,version.id]);
              } else if (!['security','structure','content','other'].includes(input.category)) fail('CATEGORY_REQUIRED');
              await c.query('UPDATE platform.game_versions SET status=$2 WHERE id=$1',[version.id,input.status]);
            } else if (action === 'rollback' || action === 'revoke') {
              if (!input.proof || input.confirmed !== true || typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 4000) fail('REVALIDATION_REQUIRED',403);
              if (version.status !== 'approved' || version.revoked) fail('INVALID_TRANSITION',409);
              if (action === 'rollback') await c.query('UPDATE platform.works SET published_version=$2 WHERE id=$1',[work.id,version.id]);
              else {
                await c.query('UPDATE platform.game_versions SET revoked=true WHERE id=$1',[version.id]);
                await c.query('UPDATE platform.works SET published_version=NULL WHERE id=$1 AND published_version=$2',[work.id,version.id]);
              }
            } else fail('NOT_FOUND',404);
          }
          await audit(c,user.id,action,work.id,version.id,{ status:input.status,reason:input.reason,category:input.category });
          return { ok:true };
        }, ['rollback','revoke'].includes(action) ? (input.proof ?? '') : null, input.workId);
      } finally { if (action === 'upload') uploading = false; }
    },
    async published(workId) {
      if (!uuid(workId)) fail('NOT_FOUND',404);
      const row = (await database.query("SELECT w.id AS work_id,w.title,v.* FROM platform.works w JOIN platform.game_versions v ON v.id=w.published_version WHERE w.id=$1 AND v.status='approved' AND NOT v.revoked",[workId])).rows[0];
      if (!row) fail('NOT_FOUND',404);
      return row;
    },
    async preview(context,workId,versionId) {
      return identity.authorized(context, async (c,user) => {
        const work = await workFor(c,workId);
        if (user.id !== work.owner_id) admin(user);
        if (!uuid(versionId)) fail('NOT_FOUND',404);
        const v = (await c.query("SELECT * FROM platform.game_versions WHERE id=$1 AND work_id=$2 AND scan_status='clean' AND NOT revoked",[versionId,workId])).rows[0];
        if (!v) fail('PREVIEW_UNAVAILABLE',409);
        return { ...v,title:work.title };
      });
    },
  };
}
