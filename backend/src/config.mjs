import { parse, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
const projectRoot = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const environments = new Set(['development', 'test', 'production']);

function under(child, parent) {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function fail(field) {
  // Never include raw configuration values: URLs may contain credentials.
  throw new Error(`Invalid configuration: ${field}`);
}

function origin(value, field, production) {
  let url;
  try { url = new URL(value); } catch { fail(field); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash || (production && url.protocol !== 'https:')) fail(field);
  return url.origin;
}

export function loadConfig(env = process.env) {
  const environment = env.APP_ENV || 'development';
  if (!environments.has(environment)) fail('APP_ENV');
  const production = environment === 'production';
  const port = Number(env.PORT || 4320);
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail('PORT');
  const host = env.HOST || '127.0.0.1';
  if (!['127.0.0.1', '::1', '0.0.0.0'].includes(host)) fail('HOST');
  if (!production && host === '0.0.0.0') fail('HOST');
  const mainOrigin = origin(env.MAIN_ORIGIN || `http://127.0.0.1:${port}`, 'MAIN_ORIGIN', production);
  const gameOrigin = origin(env.GAME_ORIGIN || 'http://127.0.0.2:4321', 'GAME_ORIGIN', production);
  const mainHost = new URL(mainOrigin).hostname;
  const gameHost = new URL(gameOrigin).hostname;
  if (mainHost === gameHost || mainHost.endsWith(`.${gameHost}`) || gameHost.endsWith(`.${mainHost}`)) fail('GAME_ORIGIN');
  // Full registrable-domain validation and per-work hostnames belong to phase 3.
  const databaseUrl = env.DATABASE_URL || null;
  if (databaseUrl) {
    let url;
    try { url = new URL(databaseUrl); } catch { fail('DATABASE_URL'); }
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname ||
        decodeURIComponent(url.pathname) !== `/ai_games_${environment}` ||
        !decodeURIComponent(url.username).endsWith(`_${environment}`) || url.search || url.hash) fail('DATABASE_URL');
  }
  const databaseTls = env.DATABASE_TLS || (production ? 'verify-full' : 'disable');
  if (!['verify-full', 'disable'].includes(databaseTls) || (production && databaseTls !== 'verify-full')) fail('DATABASE_TLS');
  const storageDriver = env.PRIVATE_STORAGE_DRIVER || 'object';
  if (!['object', 'local'].includes(storageDriver)) fail('PRIVATE_STORAGE_DRIVER');
  const endpoint = env.OBJECT_STORAGE_ENDPOINT || null;
  const bucket = env.OBJECT_STORAGE_BUCKET || null;
  if (Boolean(endpoint) !== Boolean(bucket)) fail('OBJECT_STORAGE_ENDPOINT/BUCKET');
  if (endpoint) {
    origin(endpoint, 'OBJECT_STORAGE_ENDPOINT', production);
    if (!/^[a-z0-9][a-z0-9-]{2,62}$/.test(bucket) || !bucket.endsWith(`-${environment}`)) fail('OBJECT_STORAGE_BUCKET');
  }
  // A local NTFS private store is an explicit, production-only driver branch.
  // Object-storage credentials must not be mixed in, and no default path is fabricated.
  const localDriver = storageDriver === 'local';
  if (localDriver && !production) fail('PRIVATE_STORAGE_DRIVER');
  if (localDriver && (endpoint || bucket)) fail('PRIVATE_STORAGE_DRIVER/OBJECT_STORAGE');
  if (!localDriver && env.PRIVATE_STORAGE_ROOT) fail('PRIVATE_STORAGE_ROOT');
  if (!localDriver && env.PRIVATE_STORAGE_TRUST_ROOT) fail('PRIVATE_STORAGE_TRUST_ROOT');
  let privateStorageRoot = null;
  let privateStorageTrustRoot = null;
  let storageAccount = null;
  let storageAccountSid = null;
  let storageExtraSids = Object.freeze([]);
  if (localDriver) {
    if (!env.PRIVATE_STORAGE_ROOT) fail('PRIVATE_STORAGE_ROOT');
    privateStorageRoot = resolve(projectRoot, env.PRIVATE_STORAGE_ROOT);
    const forbidden = [resolve(projectRoot, 'frontend'), resolve(projectRoot, 'backend'),
      resolve(projectRoot, 'data/postgres'), resolve(projectRoot, 'data/backups')];
    if (privateStorageRoot === projectRoot || forbidden.some(dir => under(privateStorageRoot, dir))) fail('PRIVATE_STORAGE_ROOT');
    // Optional trusted storage boundary: the guard chain stops at (and always
    // includes) this directory, which must itself be hardened. Ancestors above
    // the boundary stay unvalidated: actors there can at most remove or rename
    // the whole store (availability), never inject or read content. The
    // boundary must be a real directory, an ancestor of the storage root and
    // never a volume root (a volume root would guard exactly what the default
    // already guards, so pretending to trust it gains nothing).
    if (env.PRIVATE_STORAGE_TRUST_ROOT) {
      privateStorageTrustRoot = resolve(projectRoot, env.PRIVATE_STORAGE_TRUST_ROOT);
      if (!under(privateStorageRoot, privateStorageTrustRoot)) fail('PRIVATE_STORAGE_TRUST_ROOT');
      if (privateStorageTrustRoot === parse(privateStorageTrustRoot).root) fail('PRIVATE_STORAGE_TRUST_ROOT');
    }
    // Dedicated Windows service account (or its SID). The ACL check fails closed
    // unless it equals the running process identity and owns the root.
    if (!env.PRIVATE_STORAGE_ACCOUNT || !/^[^\s\x00-\x1f]{1,128}$/.test(env.PRIVATE_STORAGE_ACCOUNT)) fail('PRIVATE_STORAGE_ACCOUNT');
    storageAccount = env.PRIVATE_STORAGE_ACCOUNT;
    if (env.PRIVATE_STORAGE_ACCOUNT_SID) {
      if (!/^S-1-\d+(?:-\d+)+$/i.test(env.PRIVATE_STORAGE_ACCOUNT_SID)) fail('PRIVATE_STORAGE_ACCOUNT_SID');
      storageAccountSid = env.PRIVATE_STORAGE_ACCOUNT_SID.toUpperCase();
    }
    // Optional additional trusted SIDs (for example a read-only backup account).
    if (env.PRIVATE_STORAGE_EXTRA_SIDS) {
      const list = env.PRIVATE_STORAGE_EXTRA_SIDS.split(',').map(value => value.trim()).filter(Boolean);
      if (!list.length || list.length > 8 || list.some(value => !/^S-1-\d+(?:-\d+)+$/i.test(value))) fail('PRIVATE_STORAGE_EXTRA_SIDS');
      storageExtraSids = Object.freeze(list.map(value => value.toUpperCase()));
    }
  }
  const sessionSecret = env.SESSION_SECRET || null;
  const localMailPreview = env.LOCAL_MAIL_PREVIEW === '1';
  const localGames = env.LOCAL_GAMES === '1';
  const gameListenOrigin = origin(env.GAME_LISTEN_ORIGIN || (production ? 'http://127.0.0.2:4321' : gameOrigin), 'GAME_LISTEN_ORIGIN', false);
  const gameListen = new URL(gameListenOrigin);
  if(localGames && (environment !== 'development' || !['127.0.0.2','127.0.0.3'].includes(gameListen.hostname) || gameListen.protocol !== 'http:' || !gameListen.port)) fail('LOCAL_GAMES');
  if(production && (!['127.0.0.2','127.0.0.3'].includes(gameListen.hostname) || gameListen.protocol !== 'http:' || !gameListen.port)) fail('GAME_LISTEN_ORIGIN');
  const positive = (key,fallback) => { const value=Number(env[key]||fallback);if(!Number.isSafeInteger(value)||value<1)fail(key);return value; };
  const uploadLimits=Object.freeze({compressed:positive('UPLOAD_MAX_BYTES',100000000),expanded:positive('UPLOAD_MAX_EXPANDED_BYTES',300000000),files:positive('UPLOAD_MAX_FILES',500)});
  const scannerPort=positive('CLAMD_PORT',3310);if(scannerPort>65535)fail('CLAMD_PORT');
  const gameLoadTimeout=positive('GAME_LOAD_TIMEOUT_MS',30000);
  const submissionDeadline=env.SUBMISSION_DEADLINE?Date.parse(env.SUBMISSION_DEADLINE):null;
  if(submissionDeadline!==null&&(!Number.isFinite(submissionDeadline)||!/(Z|[+-]\d{2}:\d{2})$/.test(env.SUBMISSION_DEADLINE)))fail('SUBMISSION_DEADLINE');
  if (localMailPreview && environment !== 'development') fail('LOCAL_MAIL_PREVIEW');
  if (sessionSecret && Buffer.byteLength(sessionSecret) < 32) fail('SESSION_SECRET');
  if (production && (!databaseUrl || !sessionSecret || !env.MAIN_ORIGIN || !env.GAME_ORIGIN ||
      (localDriver ? (!privateStorageRoot || !storageAccount) : !endpoint))) fail('production dependencies');
  return Object.freeze({ environment, port, host, mainOrigin, gameOrigin, gameListenOrigin,
    databaseUrl, databaseTls, databaseCaFile: env.DATABASE_CA_FILE ? resolve(env.DATABASE_CA_FILE) : null, storage: Object.freeze({ driver: storageDriver, endpoint, bucket, root: privateStorageRoot,
      trustRoot: privateStorageTrustRoot, account: storageAccount, accountSid: storageAccountSid, extraSids: storageExtraSids }), submissionsRoot:resolve(projectRoot,env.SUBMISSIONS_ROOT || 'data/submissions'), exportsRoot:resolve(projectRoot,env.EXPORTS_ROOT || 'data/exports'), sessionSecret, localMailPreview,localGames,uploadLimits,scannerPort,gameLoadTimeout,submissionDeadline });
}
