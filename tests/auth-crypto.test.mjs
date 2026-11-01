import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, newToken, digest, validToken, totp, verifyTotp, seal, unseal, base32 } from '../src/modules/identity/crypto.mjs';

test('password hash salts, verifies unicode without truncation and rejects malformed encodings', async () => {
  const password = '安全测试 pass phrase 123';
  const a = await hashPassword(password), b = await hashPassword(password);
  assert.notEqual(a,b);
  assert.equal(await verifyPassword(password,a),true);
  assert.equal(await verifyPassword(password+'x',a),false);
  assert.equal(await verifyPassword(password,'scrypt1$bad'),false);
});
test('tokens and encrypted MFA secrets are isolated and authenticated', () => {
  const token = newToken(); assert.ok(validToken(token)); assert.notEqual(digest(token), token);
  assert.equal(validToken('../token'),false);
  const sealed = seal(Buffer.from('synthetic'), 'master-key', 'actor-a');
  assert.equal(unseal(sealed,'master-key','actor-a').toString(),'synthetic');
  assert.throws(()=>unseal(sealed,'master-key','actor-b'));
  assert.throws(()=>unseal(sealed,'other-key','actor-a'));
  assert.equal(base32(Buffer.from('foo')),'MZXW6');
});
test('TOTP matches RFC 6238 SHA1 vector and rejects replay', () => {
  const secret=Buffer.from('12345678901234567890');
  assert.equal(totp(secret,59000,8),'94287082');
  assert.equal(totp(secret,1111111109000,8),'07081804');
  const step=verifyTotp(secret,totp(secret,59000),-1,59000);
  assert.equal(step,1);
  assert.equal(verifyTotp(secret,totp(secret,59000),step,59000),null);
  assert.equal(verifyTotp(secret,'bad',-1,59000),null);
});
