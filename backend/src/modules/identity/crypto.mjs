import { randomBytes, scrypt as derive, timingSafeEqual, createHash, createHmac, createCipheriv, createDecipheriv } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(derive);
const options = { N: 131072, r: 8, p: 1, maxmem: 160 * 1024 * 1024 };
let active = 0;
async function key(password, salt) {
  if (active >= 2) throw new Error('Password worker capacity exceeded');
  active++;
  try { return await scrypt(password, salt, 32, options); } finally { active--; }
}
export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  return `scrypt1$${salt}$${(await key(password, salt)).toString('hex')}`;
}
export async function verifyPassword(password, stored) {
  if (typeof password !== 'string' || Buffer.byteLength(password) > 1024) return false;
  const match = /^scrypt1\$([a-f0-9]{32})\$([a-f0-9]{64})$/.exec(stored ?? '');
  const result = await key(password, match?.[1] ?? '0'.repeat(32));
  return match !== null && timingSafeEqual(result, Buffer.from(match[2], 'hex'));
}
export const newToken = () => randomBytes(32).toString('base64url');
export const digest = value => createHash('sha256').update(value).digest('hex');
export const validToken = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32(bytes) {
  let bits = '', result = '';
  for (const byte of bytes) bits += byte.toString(2).padStart(8, '0');
  for (let i = 0; i < bits.length; i += 5) result += alphabet[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return result;
}
export function totp(secret, time = Date.now(), digits = 6) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(time / 30000)));
  const mac = createHmac('sha1', secret).update(counter).digest();
  const offset = mac.at(-1) & 15;
  return ((mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits).toString().padStart(digits, '0');
}
export function verifyTotp(secret, code, lastStep = -1, time = Date.now()) {
  if (!/^\d{6}$/.test(code ?? '')) return null;
  for (const shift of [-1, 0, 1]) {
    const step = Math.floor(time / 30000) + shift;
    if (step > Number(lastStep) && timingSafeEqual(Buffer.from(code), Buffer.from(totp(secret, step * 30000)))) return step;
  }
  return null;
}
export function seal(secret, master, context) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(digest(master), 'hex'), iv);
  cipher.setAAD(Buffer.from(context));
  const data = Buffer.concat([cipher.update(secret), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
}
export function unseal(value, master, context) {
  const data = Buffer.from(value, 'base64');
  const cipher = createDecipheriv('aes-256-gcm', Buffer.from(digest(master), 'hex'), data.subarray(0, 12));
  cipher.setAAD(Buffer.from(context));
  cipher.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]);
}
