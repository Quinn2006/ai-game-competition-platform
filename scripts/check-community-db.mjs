import pg from 'pg';
import {migrate,migrationFiles} from '../backend/src/platform/migrations.mjs';
import {communityCases} from '../tests/integration/community-cases.mjs';
const url=new URL(process.env.DATABASE_URL);if(url.hostname!=='127.0.0.1'||url.pathname!=='/ai_games_test'||process.env.CONFIRM_DISPOSABLE_DATABASE!=='ai_games_test')throw Error('Dedicated test database required');
const db=new pg.Pool({connectionString:url.href});try{
 if((await db.query("SELECT to_regnamespace('platform') AS name")).rows[0].name)throw Error('Fresh database required');
 await migrate(db,'test','up');for(const _ of await migrationFiles())await migrate(db,'test','down');await migrate(db,'test','up');
 console.log(JSON.stringify(await communityCases(db)));
}finally{await db.end();}
