import { randomUUID } from 'node:crypto';
import { hashPassword } from './crypto.mjs';

// Public local demo credentials requested by the project owner; never seed production.
export const builtinAccounts = Object.freeze(['Admin06', 'Judge1', 'Judge2', 'Judge3', 'Judge4', 'Judge5'].map((name, index) => Object.freeze({
  id: `f3124d55-9b80-4ef1-9854-00000000000${index}`,
  name, role: index === 0 ? 'admin' : 'judge',
})));
export const builtinLoginName = value => typeof value === 'string' && builtinAccounts.some(account => account.name.toLowerCase() === value.trim().toLowerCase());

export async function seedBuiltinAccounts(database, config) {
  const url = new URL(config.databaseUrl);
  if (config.environment !== 'development' || url.hostname !== '127.0.0.1' || url.pathname !== '/ai_games_development') {
    throw new Error('Built-in accounts require the local development database');
  }
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    const identity = await client.query('SELECT environment FROM platform.environment_identity WHERE singleton=true');
    if (identity.rows[0]?.environment !== 'development') throw new Error('Wrong database environment');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('local-builtin-accounts'))");
    let created = 0;
    for (const account of builtinAccounts) {
      // Stable IDs also prevent recreating an account after deletion has cleared its login name.
      const existing = await client.query('SELECT id FROM platform.accounts WHERE id=$1 OR email=$2', [account.id, account.name.toLowerCase()]);
      if (existing.rowCount) continue;
      const inserted = await client.query(`INSERT INTO platform.accounts(id,email,password_hash,status,nickname,roles)
        VALUES($1,$2,$3,'active',$4,$5) ON CONFLICT DO NOTHING RETURNING id`,
      [account.id, account.name.toLowerCase(), await hashPassword('abcd123456'), account.name, [account.role]]);
      if (!inserted.rowCount) continue;
      await client.query(`INSERT INTO platform.identity_events(id,actor_id,target_id,action,request_id,outcome)
        VALUES($1,NULL,$2,'registered',$3,'success'),($4,NULL,$2,'roles_changed',$3,'success')`,
      [randomUUID(), account.id, randomUUID(), randomUUID()]);
      created++;
    }
    await client.query('COMMIT');
    return { created };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
