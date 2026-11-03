import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../../backend/src/config.mjs';
import { createDatabase } from '../../backend/src/platform/database.mjs';
import { migrate } from '../../backend/src/platform/migrations.mjs';
import { builtinAccounts, seedBuiltinAccounts } from '../../backend/src/modules/identity/builtin-accounts.mjs';
import { createIdentityService } from '../../backend/src/modules/identity/service.mjs';
import { hashPassword, verifyPassword } from '../../backend/src/modules/identity/crypto.mjs';

test('built-in accounts: local-only, six roles, logins, MFA and non-destructive reseeding', async () => {
  assert.equal(process.env.CONFIRM_DISPOSABLE_DATABASE, 'ai_games_development');
  const config = loadConfig();
  assert.equal(config.environment, 'development');
  const db = createDatabase(config, () => {});
  try {
    await migrate(db, 'development', 'up');
    assert.equal((await db.query('SELECT count(*) FROM platform.accounts')).rows[0].count, '0', 'Use a new disposable database');
    for (const other of [{...config, environment:'production'}, {...config, databaseUrl:'postgres://app_development@remote.example/ai_games_development'}]) {
      await assert.rejects(seedBuiltinAccounts(db, other), /local development/);
    }
    await db.query("UPDATE platform.environment_identity SET environment='test' WHERE singleton");
    await assert.rejects(seedBuiltinAccounts(db, config), /Wrong database environment/);
    await db.query("UPDATE platform.environment_identity SET environment='development' WHERE singleton");
    const results = await Promise.all([seedBuiltinAccounts(db, config), seedBuiltinAccounts(db, config)]);
    assert.equal(results.reduce((sum, result) => sum + result.created, 0), 6);
    const rows = (await db.query('SELECT * FROM platform.accounts ORDER BY email')).rows;
    assert.equal(rows.length, 6);
    assert.equal(new Set(rows.map(row => row.password_hash)).size, 6);
    const service = createIdentityService({ database:db, secret:'builtin-test-secret', localAccounts:true });
    const ctx = {requestId:randomUUID(),address:'builtin-test'};
    for (const account of builtinAccounts) {
      const result = await service.run('login', {email:` ${account.name.toUpperCase()} `,password:'abcd123456'},ctx);
      assert.deepEqual(result.user.roles, [account.role]);
      assert.equal(result.setupOnly, account.role === 'admin');
      if (account.role === 'admin') await assert.rejects(service.authorized({...ctx,sessionToken:result.sessionToken},async()=>{}),{code:'MFA_REQUIRED'});
    }
    await assert.rejects(service.run('login',{email:'Judge1',password:'incorrect'},ctx),{code:'LOGIN_FAILED'});
    await assert.rejects(service.run('register',{email:'Admin06',password:'ordinary long password'},ctx),{code:'INVALID_EMAIL'});
    await assert.rejects(service.run('register',{email:'short@example.test',password:'abcd123456'},ctx),{code:'INVALID_PASSWORD'});
    await service.run('register',{email:'normal@example.test',password:'ordinary long password'},ctx);
    assert.deepEqual((await service.run('login',{email:'normal@example.test',password:'ordinary long password'},ctx)).user.roles,[]);
    const replacement=await hashPassword('changed local password 123');
    await db.query("UPDATE platform.accounts SET password_hash=$1,roles='{}' WHERE email='judge1'",[replacement]);
    await db.query("UPDATE platform.accounts SET status='disabled' WHERE email='judge2'");
    await db.query("UPDATE platform.accounts SET status='deleted',email=NULL,password_hash=NULL WHERE email='judge3'");
    assert.equal((await seedBuiltinAccounts(db,config)).created,0);
    assert.equal((await db.query('SELECT count(*) FROM platform.accounts')).rows[0].count,'7');
    const judge1=(await db.query("SELECT * FROM platform.accounts WHERE email='judge1'")).rows[0];
    assert.deepEqual(judge1.roles,[]);assert.equal(judge1.password_hash,replacement);
    assert.ok(await verifyPassword('changed local password 123',judge1.password_hash));
    await assert.rejects(service.run('login',{email:'Judge2',password:'abcd123456'},ctx),{code:'LOGIN_FAILED'});
    assert.equal((await db.query("SELECT count(*) FROM platform.identity_events WHERE action='roles_changed'")).rows[0].count,'6');
  } finally { await db.end(); }
});
