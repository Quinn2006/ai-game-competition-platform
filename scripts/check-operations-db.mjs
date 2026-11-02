import pg from 'pg';
import assert from 'node:assert/strict';
import {migrate} from '../src/platform/migrations.mjs';
import {operationsCases} from '../tests/integration/operations-cases.mjs';
const url=new URL(process.env.DATABASE_URL);assert.equal(url.hostname,'127.0.0.1');assert.equal(url.pathname,'/ai_games_test');assert.equal(process.env.CONFIRM_DISPOSABLE_DATABASE,'ai_games_test');
const db=new pg.Pool({connectionString:url.href});try{assert.equal((await db.query("SELECT to_regnamespace('platform') AS name")).rows[0].name,null);await migrate(db,'test','up');await migrate(db,'test','down');await migrate(db,'test','up');await operationsCases(db);await assert.rejects(migrate(db,'test','down'),/Operations history is not empty/);}finally{await db.end();}
