// Local synthetic drill only. Never connects to an existing database.
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { once } from 'node:events';
import pg from 'pg';
import { migrate, databaseReady } from '../backend/src/platform/migrations.mjs';
import { appendAudit } from '../backend/src/modules/audit/repository.mjs';
import { cleanupAudit } from '../backend/src/modules/audit/retention.mjs';

const runtime = resolve(process.argv[2] || 'tmp/missing-postgres-runtime');
const state = resolve('tmp', `ops-drill-${Date.now()}-${randomBytes(4).toString('hex')}`);
const password = randomBytes(32).toString('hex');
const pools = [], running = [];
let logIndex = 0;
async function command(name, args, env = {}) {
  const logFile = openSync(join(state, `${++logIndex}-${name}.log`), 'wx');
  try {
  const child = spawn(join(runtime, name + (process.platform === 'win32' ? '.exe' : '')), args,
    { windowsHide: true, env: { ...process.env, PGPASSWORD: password, ...env }, stdio: ['ignore',logFile,logFile] });
  const [code] = await once(child, 'close');
  if (code !== 0) throw new Error(`${name} failed; inspect ignored drill logs`);
  } finally { closeSync(logFile); }
}
async function cluster(name) {
  const socket = createServer().listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const data = join(state, name);
  await command('initdb', ['-D', data, '-U', 'app_test', '--pwfile', join(state, 'password.tmp'), '--auth=scram-sha-256', '--encoding=UTF8', '--locale=C']);
  await command('pg_ctl', ['-D', data, '-l', join(state, `${name}.log`), '-o', `-h 127.0.0.1 -p ${port}`, '-w', 'start']);
  running.push(data);
  const args = ['-h','127.0.0.1','-p',String(port),'-U','app_test'];
  await command('createdb', [...args, 'ai_games_test']);
  const pool = new pg.Pool({ host:'127.0.0.1', port, user:'app_test', password, database:'ai_games_test' });
  pools.push(pool);
  return { pool, args };
}
try {
  await mkdir(state, { recursive: true });
  await writeFile(join(state, 'password.tmp'), password, { mode: 0o600, flag: 'wx' });
  const source = await cluster('source');
  const target = await cluster('restore');
  await migrate(source.pool, 'test', 'up');
  // Exercise all empty down migrations, then rebuild before adding data.
  let history = await migrate(source.pool, 'test', 'status');
  const migrationCount = history.length;
  while (history.length) history = await migrate(source.pool, 'test', 'down');
  await migrate(source.pool, 'test', 'up');
  const deletedId = await appendAudit(source.pool, { action:'system.error', requestId:randomUUID(), outcome:'failure' });
  const keptId = await appendAudit(source.pool, { action:'system.error', requestId:randomUUID(), outcome:'failure' });
  // Minimal synthetic deletion journal intentionally kept outside the dump.
  const journal = join(state, 'deletions.json');
  const backup = join(state, 'snapshot.dump');
  const started = performance.now();
  await command('pg_dump', [...source.args, '-d','ai_games_test','-Fc','-f',backup]);
  const digest = createHash('sha256').update(await readFile(backup)).digest('hex');
  await writeFile(journal, JSON.stringify([deletedId]), { flag:'wx', mode:0o600 });
  await source.pool.query('DELETE FROM platform.audit_events WHERE id=$1', [deletedId]);
  const restoreStarted = performance.now();
  await command('pg_restore', [...target.args, '-d','ai_games_test','--exit-on-error','--no-owner',backup]);
  if (!await databaseReady(target.pool, 'test')) throw new Error('Restored schema not ready');
  const before = await target.pool.query('SELECT id FROM platform.audit_events');
  if (before.rowCount !== 2) throw new Error('Backup fixture mismatch');
  const client = await target.pool.connect();
  try {
    await client.query('BEGIN');
    for (const id of JSON.parse(await readFile(journal,'utf8'))) await client.query('DELETE FROM platform.audit_events WHERE id=$1',[id]);
    await cleanupAudit(client);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
  const after = await target.pool.query('SELECT id FROM platform.audit_events');
  if (after.rowCount !== 1 || after.rows[0].id !== keptId) throw new Error('Deletion replay mismatch');
  const report = { scope:'synthetic PostgreSQL only; no production RPO/RTO acceptance', migrationCount,
    emptyMigrationRollback:true, restoredSchema:true, deletionReplay:true, preservedRecord:true,
    sha256:digest, restoreAndReplayMs:performance.now()-restoreStarted, backupAndRestoreMs:performance.now()-started };
  await writeFile(join(state, 'report.json'), JSON.stringify(report,null,2));
  console.log(JSON.stringify({ ...report, evidence:state }));
} catch (error) { console.error(error.message); process.exitCode=1; }
finally {
  for (const pool of pools) await pool.end();
  for (const data of running.reverse()) {
    try { await command('pg_ctl', ['-D',data,'-m','fast','-w','stop']); }
    catch { console.error('DRILL_CLUSTER_STOP_FAILED'); process.exitCode=1; }
  }
}
