// Synthetic local browser fixture. Real identity transactions, no production entry imports this file.
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {createApp} from '../src/app.mjs';
import {createCompetitionService} from '../src/modules/competition/service.mjs';
import {createIdentityService} from '../src/modules/identity/service.mjs';
import {newToken,digest} from '../src/modules/identity/crypto.mjs';
const url=new URL(process.env.DATABASE_URL);if(url.hostname!=='127.0.0.1'||url.pathname!=='/ai_games_test')throw Error('Local test database required');
const database=new pg.Pool({connectionString:url.href}),identity=createIdentityService({database,secret:'synthetic-phase6-browser',mail:async()=>{}});
async function actor(roles=[]){const id=randomUUID(),token=newToken();await database.query("INSERT INTO platform.accounts(id,status,nickname,roles,mfa_secret) VALUES($1,'active','浏览器合成用户',$2,$3)",[id,roles,roles.includes('admin')?'test-factor':null]);await database.query("INSERT INTO platform.sessions(token_hash,account_id,expires_at) VALUES($1,$2,CURRENT_TIMESTAMP+interval '1 hour')",[digest(token),id]);return {id,sessionToken:token,requestId:randomUUID()};}
const owner=await actor(),admin=await actor(['admin']),service=createCompetitionService({database,identity}),now=Date.now();
await service.run('create',{title:'浏览器验收赛',registrationStart:new Date(now-60000),registrationEnd:new Date(now+86400000),submissionStart:new Date(now-60000),submissionEnd:new Date(now+2*86400000),reviewStart:new Date(now+2*86400000),reviewEnd:new Date(now+3*86400000)},admin);
const port=process.env.FIXTURE_ADMIN==='1'?4347:4346,who=process.env.FIXTURE_ADMIN==='1'?admin:owner;
const config={mainOrigin:'http://127.0.0.1:'+port,environment:'test'};
const app=createApp({config,database,log:()=>{},identity:{run:(a,i,c)=>identity.run(a,i,{...c,sessionToken:who.sessionToken})},competition:{...service,run:(a,i,c)=>service.run(a,i,{...c,sessionToken:who.sessionToken})}});
app.listen(port,'127.0.0.1',()=>console.log('Synthetic competition browser fixture ready on '+port));
process.on('SIGINT',()=>app.close(async()=>{await database.end();process.exit();}));
