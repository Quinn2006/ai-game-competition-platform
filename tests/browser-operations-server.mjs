// Synthetic, local-only fixture. Real routes/database/services; no production entry imports this file.
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {createApp} from '../src/app.mjs';
import {createIdentityService} from '../src/modules/identity/service.mjs';
import {createOperationsService} from '../src/modules/operations/service.mjs';
import {newToken,digest,seal} from '../src/modules/identity/crypto.mjs';
const url=new URL(process.env.DATABASE_URL);if(url.hostname!=='127.0.0.1'||url.pathname!=='/ai_games_test')throw Error('Disposable test database required');
const database=new pg.Pool({connectionString:url.href}),id=randomUUID(),token=newToken(),secret='browser-operations-synthetic-secret';
await database.query("INSERT INTO platform.accounts(id,status,nickname,roles,mfa_secret) VALUES($1,'active','运营测试管理员',ARRAY['admin'],$2)",[id,seal(Buffer.alloc(20,8),secret,id)]);
await database.query("INSERT INTO platform.sessions(token_hash,account_id,expires_at) VALUES($1,$2,CURRENT_TIMESTAMP+interval '2 hours')",[digest(token),id]);
const identity=createIdentityService({database,secret,mail:async()=>{}}),operations=createOperationsService({database,identity});
await operations.notifyBusiness({recipients:[id],key:'browser:welcome',title:'欢迎查看运营工作台',body:'这是一条合成测试通知。'});
const config={mainOrigin:'http://127.0.0.1:4347',environment:'test'};
const app=createApp({config,database,identity,operations:{run:(a,i,c)=>operations.run(a,i,{...c,sessionToken:token})},log:()=>{}});
app.listen(4347,'127.0.0.1',()=>console.log('Synthetic operations fixture: http://127.0.0.1:4347/admin'));
