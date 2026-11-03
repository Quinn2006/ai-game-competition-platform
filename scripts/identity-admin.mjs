import { randomUUID } from 'node:crypto';
import { loadConfig } from '../backend/src/config.mjs';
import { createDatabase } from '../backend/src/platform/database.mjs';

// Local bootstrap only. No default password, no password creation,
// and no production mutation. The account must already be active.
const config=loadConfig();
if(config.environment!=='development' || !config.databaseUrl || !process.argv[2]) throw new Error('Requires development database and a active account name');
const database=createDatabase(config,()=>{}),client=await database.connect();
try {
  await client.query('BEGIN');
  const environment=await client.query('SELECT environment FROM platform.environment_identity WHERE singleton=true');
  if(environment.rows[0]?.environment!=='development') throw new Error('Wrong database environment');
  const result=await client.query("UPDATE platform.accounts SET roles=ARRAY['admin'] WHERE email=$1 AND status='active' RETURNING id",[process.argv[2].toLowerCase()]);
  if(result.rowCount!==1) throw new Error('Active account required');
  await client.query('DELETE FROM platform.sessions WHERE account_id=$1',[result.rows[0].id]);
  await client.query("INSERT INTO platform.identity_events (id,actor_id,action,request_id,outcome) VALUES ($1,$2,'roles_changed',$3,'success')",[randomUUID(),result.rows[0].id,randomUUID()]);
  await client.query('COMMIT');
  console.log('Development administrator assigned; next login requires TOTP enrollment.');
}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();await database.end();}
