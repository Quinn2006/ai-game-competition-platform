const environments = new Set(['development', 'test', 'production']);

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
  const endpoint = env.OBJECT_STORAGE_ENDPOINT || null;
  const bucket = env.OBJECT_STORAGE_BUCKET || null;
  if (Boolean(endpoint) !== Boolean(bucket)) fail('OBJECT_STORAGE_ENDPOINT/BUCKET');
  if (endpoint) {
    origin(endpoint, 'OBJECT_STORAGE_ENDPOINT', production);
    if (!/^[a-z0-9][a-z0-9-]{2,62}$/.test(bucket) || !bucket.endsWith(`-${environment}`)) fail('OBJECT_STORAGE_BUCKET');
  }
  const sessionSecret = env.SESSION_SECRET || null;
  const localMailPreview = env.LOCAL_MAIL_PREVIEW === '1';
  if (localMailPreview && environment !== 'development') fail('LOCAL_MAIL_PREVIEW');
  if (sessionSecret && Buffer.byteLength(sessionSecret) < 32) fail('SESSION_SECRET');
  if (production && (!databaseUrl || !endpoint || !sessionSecret || !env.MAIN_ORIGIN || !env.GAME_ORIGIN)) fail('production dependencies');
  return Object.freeze({ environment, port, host, mainOrigin, gameOrigin,
    databaseUrl, databaseTls, storage: Object.freeze({ endpoint, bucket }), sessionSecret, localMailPreview });
}
