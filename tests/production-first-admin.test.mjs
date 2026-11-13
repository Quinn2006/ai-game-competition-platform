import test from 'node:test';
import assert from 'node:assert/strict';
import { firstAdministrator } from '../scripts/production-first-admin.mjs';

test('first administrator refuses development and non-migration identities before writes',async()=>{
  for(const identity of [{db:'ai_games_development',role:'migrate_production'},{db:'ai_games_production',role:'app_production'}]) {
    const calls=[];
    await assert.rejects(firstAdministrator({query:async sql=>{calls.push(sql);return {rows:[identity]};}},
      {email:'admin@example.com',passwordFile:'must-not-be-created'}),/migration identity/);
    assert.equal(calls.length,1);
  }
});

test('first administrator refuses nonempty production and rolls back without changing any account',async()=>{
  const calls=[];
  const client={query:async sql=>{
    calls.push(sql);
    if(sql.startsWith('SELECT current_database'))return {rows:[{db:'ai_games_production',role:'migrate_production'}]};
    if(sql.startsWith('SELECT environment'))return {rows:[{environment:'production'}]};
    return {rows:[],rowCount:sql.startsWith('SELECT 1 FROM platform.accounts')?1:0};
  }};
  await assert.rejects(firstAdministrator(client,{email:'admin@example.com',passwordFile:'must-not-be-created'}),/empty accounts/);
  assert.equal(calls.at(-1),'ROLLBACK');assert.equal(calls.some(sql=>sql.startsWith('INSERT')||sql.startsWith('UPDATE')),false);
});
