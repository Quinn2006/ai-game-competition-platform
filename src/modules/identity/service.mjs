import { randomUUID, randomBytes } from 'node:crypto';
import { AppError } from '../../platform/errors.mjs';
import { publicProfile } from './profiles.mjs';
import { builtinLoginName } from './builtin-accounts.mjs';
import { cleanupAudit } from '../audit/retention.mjs';
import { hashPassword, verifyPassword, newToken, digest, validToken, base32, verifyTotp, seal, unseal } from './crypto.mjs';

const error = (code, status = 400, message = '请求无法完成，请检查输入或稍后重试') => new AppError(code, status, message);
const fail = (code, status, message) => { throw error(code, status, message); };
const emailOf = value => {
  if (typeof value !== 'string' || value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) fail('INVALID_EMAIL');
  return value.trim().toLowerCase();
};
const passwordOf = value => {
  if (typeof value !== 'string' || [...value].length < 15 || [...value].length > 128) fail('INVALID_PASSWORD', 400, '密码须为 15—128 个字符');
  return value;
};
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const view = user => ({ ...publicProfile(user), email: user.email, roles: user.roles, mfaEnabled: Boolean(user.mfa_secret), status: user.status });

export function createIdentityService({ database, secret, mail, clock = () => Date.now(), deletionParticipants = [], localAccounts = false }) {
  async function transaction(work) {
    const client = await database.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
  }
  async function audit(c, action, actorId, requestId, outcome = 'success', targetId = null) {
    await c.query('INSERT INTO platform.identity_events (id, actor_id, action, request_id, outcome, target_id) VALUES ($1,$2,$3,$4,$5,$6)',
      [randomUUID(), actorId, action, requestId, outcome, targetId]);
  }
  async function limit(key, max, seconds = 900) {
    const now = new Date(clock());
    const row = (await database.query(`INSERT INTO platform.auth_limits (key_hash, attempts, expires_at) VALUES ($1,1,$2)
      ON CONFLICT (key_hash) DO UPDATE SET attempts = CASE WHEN platform.auth_limits.expires_at <= $3 THEN 1 ELSE platform.auth_limits.attempts + 1 END,
      expires_at = CASE WHEN platform.auth_limits.expires_at <= $3 THEN $2 ELSE platform.auth_limits.expires_at END RETURNING attempts`,
    [digest(`${secret}:${key}`), new Date(clock() + seconds * 1000), now])).rows[0];
    if (row.attempts > max) fail('RATE_LIMITED', 429, '尝试过于频繁，请稍后重试');
  }
  async function token(c, user, purpose, lifetime, extras = {}) {
    const raw = newToken();
    await c.query(`INSERT INTO platform.identity_tokens (token_hash, account_id, purpose, expires_at, action, resource_id, session_hash)
      VALUES ($1,$2,$3,$4,$5,$6,$7)`, [digest(raw), user.id, purpose, new Date(clock() + lifetime), extras.action ?? null, extras.resourceId ?? null, extras.sessionHash ?? null]);
    return raw;
  }
  async function session(c, raw, allowSetup = false) {
    if (!validToken(raw)) fail('AUTHENTICATION_REQUIRED', 401, '请先登录');
    // Lock account before session, matching logout/reset/deletion lock order.
    const found = (await c.query('SELECT account_id FROM platform.sessions WHERE token_hash=$1', [digest(raw)])).rows[0];
    if (!found) fail('AUTHENTICATION_REQUIRED', 401, '请先登录');
    const user = (await c.query('SELECT * FROM platform.accounts WHERE id=$1 FOR UPDATE', [found.account_id])).rows[0];
    const s = (await c.query('SELECT * FROM platform.sessions WHERE token_hash=$1 FOR UPDATE', [digest(raw)])).rows[0];
    const idle = user.roles.includes('admin') ? 15 : 30;
    if (!s || user.status !== 'active' || +s.expires_at <= clock() || +s.last_seen + idle * 60000 <= clock()) fail('AUTHENTICATION_REQUIRED', 401, '会话已失效，请重新登录');
    if ((s.setup_only || (user.roles.includes('admin') && !user.mfa_secret)) && !allowSetup) fail('MFA_REQUIRED', 403, '请先设置管理员两步验证');
    await c.query('UPDATE platform.sessions SET last_seen=$2 WHERE token_hash=$1', [digest(raw), new Date(clock())]);
    return user;
  }
  async function consume(c, raw, purpose) {
    if (!validToken(raw)) fail('INVALID_TOKEN', 400, '链接已失效或已使用');
    const row = (await c.query('SELECT account_id FROM platform.identity_tokens WHERE token_hash=$1', [digest(raw)])).rows[0];
    if (!row) fail('INVALID_TOKEN', 400, '链接已失效或已使用');
    const user = (await c.query('SELECT * FROM platform.accounts WHERE id=$1 FOR UPDATE', [row.account_id])).rows[0];
    const consumed = (await c.query('DELETE FROM platform.identity_tokens WHERE token_hash=$1 AND purpose=$2 AND expires_at>$3 RETURNING *', [digest(raw), purpose, new Date(clock())])).rows[0];
    if (!consumed) fail('INVALID_TOKEN', 400, '链接已失效或已使用');
    return { user, token: consumed };
  }
  async function factor(c, user, code, recovery) {
    if (!user.mfa_secret) return true;
    if (validToken(recovery)) {
      const result = await c.query('DELETE FROM platform.identity_tokens WHERE token_hash=$1 AND account_id=$2 AND purpose=\'recovery\' AND expires_at>$3 RETURNING token_hash', [digest(recovery), user.id, new Date(clock())]);
      return result.rowCount === 1;
    }
    const step = verifyTotp(unseal(user.mfa_secret, secret, user.id), code, user.mfa_step, clock());
    if (step === null) return false;
    await c.query('UPDATE platform.accounts SET mfa_step=$2 WHERE id=$1', [user.id, step]);
    return true;
  }
  async function authenticateAgain(c, user, input) {
    return await verifyPassword(input.password, user.password_hash) && await factor(c, user, input.code, input.recovery);
  }

  const service = {
    async authorized(context, work, proof = null, resourceId = null) {
      return transaction(async c => {
        const user = await session(c, context.sessionToken);
        if (proof !== null) {
          if (!user.roles.includes('admin') || !validToken(proof)) fail('FORBIDDEN', 403);
          const consumed = await c.query(`DELETE FROM platform.identity_tokens WHERE token_hash=$1 AND account_id=$2 AND purpose='revalidate'
            AND action='admin.dangerous' AND resource_id=$3 AND session_hash=$4 AND expires_at>$5 RETURNING token_hash`,
          [digest(proof), user.id, resourceId, digest(context.sessionToken), new Date(clock())]);
          if (!consumed.rowCount) fail('FORBIDDEN', 403);
        }
        return work(c, user);
      });
    },
    async run(action, input = {}, context) {
      try { return await service.execute(action, input, context); }
      catch (e) {
        await audit(database, 'request_failed', null, context.requestId, 'failure');
        throw e;
      }
    },
    async execute(action, input = {}, context) {
      const { requestId, address = 'local', sessionToken } = context;
      if(localAccounts && ['verify','resend','forgot','reset','cancel'].includes(action)) fail('LOCAL_ACCOUNT_ONLY',400,'邮箱仅作账号名，找回密码或取消注销请使用本机管理工具');
      const outbound = [];
      if (['register','resend','forgot','login','verify','reset','cancel'].includes(action)) await limit(`source:${address}`, 60);
      if (['register','resend','forgot','login'].includes(action)) {
        input = { ...input, email: localAccounts && action === 'login' && builtinLoginName(input.email) ? input.email.trim().toLowerCase() : emailOf(input.email) };
        await limit(`account:${input.email}:${action}`, action === 'login' ? 10 : 5);
      }
      if (['mfa/setup','mfa/enable','revalidate','delete'].includes(action)) await limit(`sensitive:${digest(sessionToken ?? '')}`, 10);
      const result = await transaction(async c => {
        if (action === 'register') {
          const password = passwordOf(input.password);
          await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [input.email]);
          const existing = (await c.query('SELECT id FROM platform.accounts WHERE email=$1', [input.email])).rows[0];
          const hash = await hashPassword(password); // Same expensive path for duplicate addresses.
          if (!existing) {
            const user = { id: randomUUID(), email: input.email };
            await c.query("INSERT INTO platform.accounts (id,email,password_hash,status,nickname) VALUES ($1,$2,$3,$4,'新玩家')", [user.id, user.email, hash,localAccounts?'active':'pending']);
            if(!localAccounts) outbound.push({ to: user.email, purpose: 'verify', token: await token(c, user, 'verify', 86400000) });
            await audit(c, 'registered', user.id, requestId);
          }
          return { message: localAccounts?'注册请求已处理。若账号名未被占用，现在可直接登录。':'如果邮箱可用，验证邮件已准备好，请查收。' };
        }
        if (action === 'resend' || action === 'forgot') {
          const user = (await c.query('SELECT * FROM platform.accounts WHERE email=$1 FOR UPDATE', [input.email])).rows[0];
          const purpose = action === 'resend' ? 'verify' : 'reset';
          if (user && user.status === (action === 'resend' ? 'pending' : 'active')) {
            await c.query('DELETE FROM platform.identity_tokens WHERE account_id=$1 AND purpose=$2', [user.id, purpose]);
            outbound.push({ to: user.email, purpose, token: await token(c, user, purpose, purpose === 'verify' ? 86400000 : 1800000) });
          }
          await audit(c, 'reset_requested', null, requestId);
          return { message: '如果账号符合条件，邮件已准备好，请查收。' };
        }
        if (['verify','reset','cancel'].includes(action)) {
          if (action === 'reset') passwordOf(input.password);
          const { user } = await consume(c, input.token, action);
          if (action === 'verify') {
            if (user.status !== 'pending') fail('INVALID_TOKEN');
            await c.query("UPDATE platform.accounts SET status='active' WHERE id=$1", [user.id]);
            await c.query("DELETE FROM platform.identity_tokens WHERE account_id=$1 AND purpose='verify'", [user.id]);
            await audit(c, 'verified', user.id, requestId);
          } else if (action === 'reset') {
            if (user.status !== 'active') fail('INVALID_TOKEN');
            await c.query('UPDATE platform.accounts SET password_hash=$2 WHERE id=$1', [user.id, await hashPassword(input.password)]);
            await c.query('DELETE FROM platform.sessions WHERE account_id=$1', [user.id]);
            await c.query("DELETE FROM platform.identity_tokens WHERE account_id=$1 AND purpose <> 'recovery'", [user.id]);
            await audit(c, 'password_reset', user.id, requestId);
          } else {
            if (user.status !== 'deleting' || +user.deletion_due <= clock()) fail('INVALID_TOKEN');
            await c.query("UPDATE platform.accounts SET status='active',deletion_due=NULL WHERE id=$1", [user.id]);
            await audit(c, 'deletion_cancelled', user.id, requestId);
          }
          return { message: action === 'cancel' ? '已取消注销，请重新登录。' : '操作完成，请登录。' };
        }
        if (action === 'login') {
          const user = (await c.query('SELECT * FROM platform.accounts WHERE email=$1 FOR UPDATE', [input.email])).rows[0];
          const correct = await verifyPassword(input.password, user?.password_hash);
          if (!correct || !user || (user.status !== 'active' && !(localAccounts && user.status==='pending')) || !await factor(c, user, input.code, input.recovery)) {
            await audit(c, 'login_failed', user?.id ?? null, requestId, 'failure');
            return { failure: error('LOGIN_FAILED', 401, '账号、密码或验证信息不正确，或账号不可用') };
          }
          if(localAccounts && user.status==='pending'){await c.query("UPDATE platform.accounts SET status='active' WHERE id=$1",[user.id]);await c.query("DELETE FROM platform.identity_tokens WHERE account_id=$1 AND purpose IN ('verify','reset')",[user.id]);user.status='active';}
          const raw = newToken();
          const setupOnly = user.roles.includes('admin') && !user.mfa_secret;
          await c.query('INSERT INTO platform.sessions (token_hash,account_id,expires_at,setup_only,last_seen,created_at) VALUES ($1,$2,$3,$4,$5,$5)',
            [digest(raw), user.id, new Date(clock() + (user.roles.includes('admin') ? 8 * 3600000 : 7 * 86400000)), setupOnly, new Date(clock())]);
          await audit(c, 'login', user.id, requestId);
          return { sessionToken: raw, user: view(user), setupOnly };
        }
        const user = await session(c, sessionToken, ['me','logout','mfa/setup','mfa/enable'].includes(action));
        if (action === 'me') return { user: view(user), setupOnly: user.roles.includes('admin') && !user.mfa_secret };
        if (action === 'logout') {
          await c.query('DELETE FROM platform.sessions WHERE token_hash=$1', [digest(sessionToken)]);
          await audit(c, 'logout', user.id, requestId);
          return { clearSession: true };
        }
        if (action === 'profile') {
          if (Object.keys(input).some(k => !['nickname','bio'].includes(k))) fail('INVALID_PROFILE');
          if (typeof input.nickname !== 'string' || typeof input.bio !== 'string') fail('INVALID_PROFILE');
          // Transport cap, not a finalized T-18 editorial character limit.
          if (!input.nickname.trim() || Buffer.byteLength(input.nickname) > 1024 || Buffer.byteLength(input.bio) > 8192) fail('INVALID_PROFILE');
          const changed = (await c.query('UPDATE platform.accounts SET nickname=$2,bio=$3 WHERE id=$1 RETURNING *', [user.id, input.nickname.trim(), input.bio])).rows[0];
          await audit(c, 'profile_updated', user.id, requestId);
          return { user: view(changed) };
        }
        if (action === 'mfa/setup') {
          if (user.mfa_secret || !await verifyPassword(input.password, user.password_hash)) fail('VERIFICATION_FAILED', 403);
          const bytes = randomBytes(20);
          await c.query('UPDATE platform.accounts SET mfa_pending=$2 WHERE id=$1', [user.id, seal(bytes, secret, user.id)]);
          await audit(c, 'mfa_setup', user.id, requestId);
          return { secret: base32(bytes), uri: `otpauth://totp/AI%20Games:${encodeURIComponent(user.email)}?secret=${base32(bytes)}&issuer=AI%20Games` };
        }
        if (action === 'mfa/enable') {
          if (user.mfa_secret || !user.mfa_pending) fail('VERIFICATION_FAILED', 403);
          const step = verifyTotp(unseal(user.mfa_pending, secret, user.id), input.code, -1, clock());
          if (step === null) fail('VERIFICATION_FAILED', 403);
          await c.query('UPDATE platform.accounts SET mfa_secret=mfa_pending,mfa_pending=NULL,mfa_step=$2 WHERE id=$1', [user.id, step]);
          await c.query('DELETE FROM platform.sessions WHERE account_id=$1 AND token_hash<>$2', [user.id, digest(sessionToken)]);
          await c.query('UPDATE platform.sessions SET setup_only=false WHERE token_hash=$1', [digest(sessionToken)]);
          const recovery = [];
          // Recovery codes live until consumed or account deletion, bounded here by ten years.
          for (let i = 0; i < 8; i++) recovery.push(await token(c, user, 'recovery', 10 * 366 * 86400000));
          await audit(c, 'mfa_enabled', user.id, requestId);
          return { recovery };
        }
        if (action === 'revalidate') {
          if (!user.roles.includes('admin') || !uuid(input.resourceId) || !['admin.sensitive','admin.dangerous'].includes(input.action) ||
            (input.action === 'admin.dangerous' && input.confirmed !== true)) fail('FORBIDDEN', 403);
          if (!await authenticateAgain(c, user, input)) {
            await audit(c, 'revalidated', user.id, requestId, 'failure');
            return { failure: error('VERIFICATION_FAILED', 403) };
          }
          const proof = await token(c, user, 'revalidate', 300000, { action: input.action, resourceId: input.resourceId, sessionHash: digest(sessionToken) });
          await audit(c, 'revalidated', user.id, requestId);
          return { proof };
        }
        if (action === 'admin/profile') {
          if (!user.roles.includes('admin') || !uuid(input.resourceId) || !validToken(input.proof)) fail('FORBIDDEN', 403);
          const proof = (await c.query(`DELETE FROM platform.identity_tokens WHERE token_hash=$1 AND account_id=$2 AND purpose='revalidate'
            AND action='admin.sensitive' AND resource_id=$3 AND session_hash=$4 AND expires_at>$5 RETURNING token_hash`,
          [digest(input.proof), user.id, input.resourceId, digest(sessionToken), new Date(clock())])).rows[0];
          if (!proof) fail('FORBIDDEN', 403);
          const target = (await c.query('SELECT * FROM platform.accounts WHERE id=$1', [input.resourceId])).rows[0];
          await audit(c, 'sensitive_read', user.id, requestId, 'success', input.resourceId);
          return { user: target && target.status !== 'deleted' ? view(target) : null };
        }
        if (action === 'admin/roles') {
          if (!user.roles.includes('admin') || !uuid(input.resourceId) || !validToken(input.proof) || input.confirmed !== true ||
              !Array.isArray(input.roles) || input.roles.some(role=>!['admin','judge'].includes(role))) fail('FORBIDDEN',403);
          if (input.resourceId === user.id) fail('FORBIDDEN',403,'请由另一管理员变更你的角色');
          const proof = await c.query(`DELETE FROM platform.identity_tokens WHERE token_hash=$1 AND account_id=$2 AND purpose='revalidate'
            AND action='admin.dangerous' AND resource_id=$3 AND session_hash=$4 AND expires_at>$5 RETURNING token_hash`,
          [digest(input.proof),user.id,input.resourceId,digest(sessionToken),new Date(clock())]);
          if (!proof.rowCount) fail('FORBIDDEN',403);
          const changed = await c.query("UPDATE platform.accounts SET roles=$2 WHERE id=$1 AND status='active' RETURNING id",[input.resourceId,[...new Set(input.roles)]]);
          if (!changed.rowCount) fail('NOT_FOUND',404);
          await c.query('DELETE FROM platform.sessions WHERE account_id=$1',[input.resourceId]);
          await audit(c,'roles_changed',user.id,requestId,'success',input.resourceId);
          return {message:'角色已更新，目标账号需重新登录。'};
        }
        if (action === 'delete') {
          if (input.confirmed !== true || !await authenticateAgain(c, user, input)) fail('VERIFICATION_FAILED', 403);
          for (const participant of deletionParticipants) await participant.check(c, user.id);
          const due = new Date(clock() + 7 * 86400000);
          await c.query("UPDATE platform.accounts SET status='deleting',deletion_due=$2 WHERE id=$1", [user.id, due]);
          await c.query('DELETE FROM platform.sessions WHERE account_id=$1', [user.id]);
          await c.query('DELETE FROM platform.identity_tokens WHERE account_id=$1', [user.id]);
          if(!localAccounts) outbound.push({ to: user.email, purpose: 'cancel', token: await token(c, user, 'cancel', 7 * 86400000) });
          await audit(c, 'deletion_requested', user.id, requestId);
          return { clearSession: true, deletionDue: due, message: localAccounts?'已进入7天注销等待期，可使用本机管理工具取消。':'已进入 7 天注销等待期，可通过邮件取消。' };
        }
        fail('NOT_FOUND', 404);
      });
      for (const message of outbound) await mail(message);
      if (result.failure) throw result.failure;
      return result;
    },
    async publicProfile(id) {
      if (!uuid(id)) fail('NOT_FOUND', 404);
      const record = (await database.query("SELECT id,nickname,avatar,bio FROM platform.accounts WHERE id=$1 AND status='active'", [id])).rows[0];
      if (!record) fail('NOT_FOUND', 404);
      return publicProfile(record);
    },
    async cleanup() {
      return transaction(async c => {
        const users = (await c.query("SELECT id FROM platform.accounts WHERE status='deleting' AND deletion_due<=$1 FOR UPDATE SKIP LOCKED", [new Date(clock())])).rows;
        for (const user of users) {
          for (const participant of deletionParticipants) { await participant.check(c, user.id); await participant.finalize(c, user.id); }
          await c.query('DELETE FROM platform.sessions WHERE account_id=$1', [user.id]);
          await c.query('DELETE FROM platform.identity_tokens WHERE account_id=$1', [user.id]);
          await c.query("UPDATE platform.accounts SET email=NULL,password_hash=NULL,nickname='',bio='',avatar='',roles='{}',mfa_secret=NULL,mfa_pending=NULL,status='deleted' WHERE id=$1", [user.id]);
          await audit(c, 'deletion_finalized', user.id, randomUUID());
        }
        await c.query('DELETE FROM platform.identity_tokens WHERE expires_at<=$1', [new Date(clock())]);
        await c.query('DELETE FROM platform.sessions WHERE expires_at<=$1', [new Date(clock())]);
        await c.query('DELETE FROM platform.auth_limits WHERE expires_at<=$1', [new Date(clock())]);
        await cleanupAudit(c,new Date(clock()));
        return users.length;
      });
    },
  };
  return service;
}
