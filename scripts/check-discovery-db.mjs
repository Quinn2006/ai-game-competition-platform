import pg from 'pg';
import {readFile} from 'node:fs/promises';
import {migrate} from '../src/platform/migrations.mjs';
import {discoveryCases} from '../tests/integration/discovery-cases.mjs';
const url=new URL(process.env.DATABASE_URL??'http://invalid');
if(url.hostname!=='127.0.0.1'||url.pathname!=='/ai_games_test'||process.env.CONFIRM_DISPOSABLE_DATABASE!=='ai_games_test')throw Error('Dedicated disposable local database required');
const db=new pg.Pool({connectionString:url.href});
try{
  if((await db.query("SELECT to_regnamespace('platform') AS name")).rows[0].name)throw Error('Refusing to reuse an existing schema');
  await migrate(db,'test','up');
  await db.query(await readFile(new URL('../tests/integration/discovery-contract.sql',import.meta.url),'utf8'));
  const fixtures=await discoveryCases(db);
  console.log('PASS: real PostgreSQL discovery migration/rollback, published gating, five-field search, pagination, sorting, privacy, ownership, history, filtering and expiry');
  console.log(JSON.stringify(fixtures));
}finally{await db.end();}
