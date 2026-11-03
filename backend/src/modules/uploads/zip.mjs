import { inflateRaw, crc32 as checksum } from 'node:zlib';
import { promisify } from 'node:util';
import { AppError } from '../../platform/errors.mjs';

const inflate = promisify(inflateRaw);
const extensions = new Set('html css js json txt png jpg jpeg gif webp svg ico mp3 ogg wav m4a mp4 webm woff woff2 ttf wasm'.split(' '));
export const defaultLimits = Object.freeze({ compressed: 100000000, expanded: 300000000, files: 500 });
const reject = (code = 'INVALID_ZIP') => { throw new AppError(code, 400, '压缩包格式、路径、类型或大小不符合上传要求'); };
export function crc32(bytes) {
  return checksum(bytes);
}
function pathOf(bytes) {
  let path;
  try { path = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { reject(); }
  if (!path || path.length > 240 || /[\\:%?#\x00-\x1f\x7f]/.test(path) || path.startsWith('/') || path !== path.normalize('NFC')) reject('UNSAFE_ZIP_PATH');
  const segments = path.replace(/\/$/, '').split('/');
  if (segments.some(s => !s || s === '.' || s === '..' || /[. ]$/.test(s) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i.test(s))) reject('UNSAFE_ZIP_PATH');
  return path;
}

// Parse into memory; never write attacker-controlled paths to the filesystem.
// ZIP64, spanning, encryption and unsupported compression fail closed.
export async function inspectZip(bytes, limits = defaultLimits) {
  if (!Buffer.isBuffer(bytes)) reject();
  for (const key of ['compressed', 'expanded', 'files']) if (!Number.isSafeInteger(limits[key]) || limits[key] < 1) throw new Error('Invalid upload limits');
  if (bytes.length > limits.compressed) reject('ZIP_LIMIT');
  const range = (offset, size) => { if (offset < 0 || size < 0 || offset + size > bytes.length) reject(); };
  const u16 = offset => { range(offset, 2); return bytes.readUInt16LE(offset); };
  const u32 = offset => { range(offset, 4); return bytes.readUInt32LE(offset); };
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65557) && (u32(end) !== 0x06054b50 || end + 22 + u16(end + 20) !== bytes.length)) end--;
  if (end < 0 || u32(end) !== 0x06054b50) reject();
  const count = u16(end + 10), centralSize = u32(end + 12), central = u32(end + 16);
  if (u16(end + 4) || u16(end + 6) || u16(end + 8) !== count || count === 65535 || central + centralSize !== end) reject();
  if (count > limits.files || !count) reject('ZIP_LIMIT');
  let cursor = central, total = 0, localEnd = 0;
  const entries = [], names = new Set();
  for (let i = 0; i < count; i++) {
    if (u32(cursor) !== 0x02014b50) reject();
    range(cursor, 46);
    const flags = u16(cursor + 8), method = u16(cursor + 10), crc = u32(cursor + 16);
    const packed = u32(cursor + 20), size = u32(cursor + 24), nameLength = u16(cursor + 28), extra = u16(cursor + 30), comment = u16(cursor + 32);
    const offset = u32(cursor + 42), mode = u32(cursor + 38) >>> 16;
    if ((flags & ~0x808) || ![0, 8].includes(method) || u16(cursor + 34) || ((mode & 0xf000) && ![0x8000, 0x4000].includes(mode & 0xf000))) reject();
    range(cursor + 46, nameLength + extra + comment);
    const rawName = bytes.subarray(cursor + 46, cursor + 46 + nameLength), name = pathOf(rawName);
    const directory = name.endsWith('/');
    const normalized = name.replace(/\/$/, '').toLowerCase();
    if (names.has(normalized)) reject('DUPLICATE_ZIP_PATH');
    names.add(normalized);
    if (!directory && !extensions.has(name.split('.').at(-1).toLowerCase())) reject('FILE_TYPE');
    if (directory && size !== 0) reject();
    total += size;
    if (total > limits.expanded || size === 0xffffffff || packed === 0xffffffff) reject('ZIP_LIMIT');
    if (offset !== localEnd || u32(offset) !== 0x04034b50 || u16(offset + 6) !== flags || u16(offset + 8) !== method || u16(offset + 26) !== nameLength) reject();
    const start = offset + 30 + nameLength + u16(offset + 28);
    if (!bytes.subarray(offset + 30, offset + 30 + nameLength).equals(rawName) || start + packed > central) reject();
    localEnd = start + packed;
    if (flags & 8) {
      if (u32(localEnd) === 0x08074b50) localEnd += 4;
      if (u32(localEnd) !== crc || u32(localEnd + 4) !== packed || u32(localEnd + 8) !== size) reject();
      localEnd += 12;
    } else if (u32(offset + 14) !== crc || u32(offset + 18) !== packed || u32(offset + 22) !== size) reject();
    entries.push({ name, size, packed, start, method, crc, directory });
    cursor += 46 + nameLength + extra + comment;
  }
  if (cursor !== end || localEnd !== central || !entries.some(e => e.name === 'index.html' && !e.directory)) reject('ROOT_ENTRY_REQUIRED');
  const fileNames=new Set(entries.filter(e=>!e.directory).map(e=>e.name.toLowerCase()));
  for(const entry of entries){const parts=entry.name.toLowerCase().split('/');parts.pop();while(parts.length){if(fileNames.has(parts.join('/')))reject('DUPLICATE_ZIP_PATH');parts.pop();}}
  const files = new Map(), findings = [];
  for (const entry of entries) {
    const packed = bytes.subarray(entry.start, entry.start + entry.packed);
    let data;
    try { data = entry.method === 0 ? Buffer.from(packed) : await inflate(packed, { maxOutputLength: Math.max(1, entry.size) }); }
    catch { reject('INVALID_COMPRESSED_DATA'); }
    if (data.length !== entry.size || crc32(data) !== entry.crc) reject('ZIP_INTEGRITY');
    if (entry.directory) continue;
    if (data.subarray(0, 2).toString() === 'MZ' || data.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) || (data.length >= 4 && data.readUInt32LE(0) === 0x04034b50)) reject('DANGEROUS_FILE');
    if (/\.(html|js|css|svg)$/i.test(entry.name)) {
      const source = data.toString('utf8');
      for (const [kind, pattern] of [['dynamic-code', /\beval\s*\(|\bnew\s+Function\s*\(/], ['network', /\b(fetch|XMLHttpRequest|WebSocket|sendBeacon)\b|https?:\/\//], ['navigation', /window\.(open|top)|location\s*[.=]/]]) {
        if (pattern.test(source)) findings.push({ path: entry.name, kind });
      }
    }
    files.set(entry.name, data);
  }
  return { files, findings, expandedBytes: total };
}
