import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, lstat, readdir, realpath, copyFile, open } from 'node:fs/promises';
import { join, resolve, dirname, relative, isAbsolute } from 'node:path';
import { randomBytes, randomUUID, createHash, createCipheriv, createDecipheriv } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform, Writable } from 'node:stream';
import { seal, unseal } from '../backend/src/modules/identity/crypto.mjs';

export const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function flush(path){const file=await open(path,'r+');try{await file.sync();}finally{await file.close();}}
export async function plain(path, directory = false) {
  const s = await lstat(path);
  if (s.isSymbolicLink() || (await realpath(path)).toLowerCase()!==resolve(path).toLowerCase()
    || (directory ? !s.isDirectory() : !s.isFile() || s.nlink!==1)) throw Error('Linked or invalid backup path');
  return s;
}
export function inside(root, name) {
  if (typeof name!=='string' || !name || /[\\:\x00-\x1f]/.test(name) || name.split('/').some(p=>!p||p==='.'||p==='..')) throw Error('Invalid relative backup path');
  const path=resolve(root,...name.split('/')),rel=relative(resolve(root),path);
  if(!rel||rel.startsWith('..')||isAbsolute(rel))throw Error('Backup path escaped');
  return path;
}
export async function inventory(root, prefix='') {
  await plain(root,true);
  const entries=[];
  for(const name of (await readdir(root)).sort()) {
    const path=join(root,name),s=await lstat(path),key=prefix+name;
    inside(root,name);
    if(s.isDirectory()&&!s.isSymbolicLink())entries.push(...await inventory(path,key+'/'));
    else {await plain(path);entries.push({path:key,size:s.size,sha256:await digestFile(path)});}
  }
  return entries;
}
export async function digestFile(path) {
  await plain(path);
  const hash=createHash('sha256');
  for await(const chunk of createReadStream(path))hash.update(chunk);
  return hash.digest('hex');
}
export async function recoveryMaterial(file) {
  await plain(file);
  const value=JSON.parse(await readFile(file,'utf8'));
  if(value.format!==1||!/^[a-f0-9]{64}$/.test(value.encryptionKey)||typeof value.sessionSecret!=='string'||value.sessionSecret.length<32||!/^[a-f0-9-]{36}$/.test(value.id))throw Error('Recovery material invalid');
  return value;
}
export async function createRecoveryMaterial(file, sessionSecret) {
  if(typeof sessionSecret!=='string'||sessionSecret.length<32)throw Error('Original application secret required');
  await plain(dirname(file),true);
  const value={format:1,id:randomUUID(),encryptionKey:randomBytes(32).toString('hex'),sessionSecret};
  await writeFile(file,JSON.stringify(value),{flag:'wx',mode:0o600});
  return value;
}
async function encryptFile(source,target,key,aad) {
  await plain(source);
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',Buffer.from(key,'hex'),iv),hash=createHash('sha256');
  cipher.setAAD(Buffer.from(aad));
  let size=0;
  const tap=new Transform({transform(chunk,encoding,callback){hash.update(chunk);size+=chunk.length;callback(null,chunk);}});
  await pipeline(createReadStream(source),tap,cipher,createWriteStream(target,{flags:'wx',mode:0o600}));
  await flush(target);
  return {iv:iv.toString('hex'),tag:cipher.getAuthTag().toString('hex'),size,sha256:hash.digest('hex'),cipherSha256:await digestFile(target)};
}
async function decryptFile(source,key,entry,aad,target) {
  if(!/^[a-f0-9]{24}$/.test(entry.iv)||!/^[a-f0-9]{32}$/.test(entry.tag)||await digestFile(source)!==entry.cipherSha256)throw Error('Encrypted file damaged');
  const cipher=createDecipheriv('aes-256-gcm',Buffer.from(key,'hex'),Buffer.from(entry.iv,'hex')),hash=createHash('sha256');
  cipher.setAAD(Buffer.from(aad));cipher.setAuthTag(Buffer.from(entry.tag,'hex'));
  let size=0;
  const tap=new Transform({transform(chunk,encoding,callback){hash.update(chunk);size+=chunk.length;callback(null,chunk);}});
  await pipeline(createReadStream(source),cipher,tap,target?createWriteStream(target,{flags:'wx',mode:0o600}):new Writable({write(c,e,cb){cb();}}));
  if(size!==entry.size||hash.digest('hex')!==entry.sha256)throw Error('Decrypted content mismatch');
}
export async function writeBundle({directory,sources,metadata,material,beforeComplete=async()=>{}}) {
  await plain(dirname(directory),true);
  await mkdir(directory,{recursive:false,mode:0o700});
  const manifest={format:1,keyId:material.id,...metadata,roots:sources.map(s=>s.prefix),files:[]};
  let index=0;
  const inventories=[];
  for(const {root,prefix} of sources) {
    const before=await inventory(root);
    inventories.push({root,before});
    for(const f of before){
      const name=prefix+'/'+f.path;inside(directory,name);
      const blob=String(index++).padStart(8,'0')+'.enc';
      const entry=await encryptFile(inside(root,f.path),join(directory,blob),material.encryptionKey,name);
      if(entry.sha256!==f.sha256||entry.size!==f.size)throw Error('Source changed while backing up');
      manifest.files.push({path:name,blob,...entry});
    }
    if(JSON.stringify(before)!==JSON.stringify(await inventory(root)))throw Error('Source changed while backing up');
  }
  const encrypted=seal(Buffer.from(JSON.stringify(manifest)),material.encryptionKey,'production-backup-manifest-v1');
  await writeFile(join(directory,'manifest.enc'),encrypted,{flag:'wx',mode:0o600});
  await flush(join(directory,'manifest.enc'));
  for(const f of manifest.files)await decryptFile(join(directory,f.blob),material.encryptionKey,f,f.path);
  for(const {root,before} of inventories)if(JSON.stringify(before)!==JSON.stringify(await inventory(root)))throw Error('Source changed before completion');
  await beforeComplete();
  // Complete is written last; an interrupted bundle remains ineligible forever.
  await writeFile(join(directory,'complete.json'),JSON.stringify({format:1,keyId:material.id,manifestSha256:sha(encrypted)}),{flag:'wx',mode:0o600});
  await flush(join(directory,'complete.json'));
  return manifest;
}
export async function verifyBundle(directory,material) {
  await plain(directory,true);await plain(join(directory,'complete.json'));await plain(join(directory,'manifest.enc'));
  const complete=JSON.parse(await readFile(join(directory,'complete.json'),'utf8')),encrypted=await readFile(join(directory,'manifest.enc'),'utf8');
  if(complete.format!==1||complete.keyId!==material.id||complete.manifestSha256!==sha(encrypted))throw Error('Incomplete or incompatible backup');
  const m=JSON.parse(unseal(encrypted,material.encryptionKey,'production-backup-manifest-v1').toString());
  if(m.format!==1||m.keyId!==material.id||!Array.isArray(m.files)||!Array.isArray(m.roots)||!m.roots.length||new Set(m.roots).size!==m.roots.length)throw Error('Manifest invalid');
  for(const root of m.roots)inside(directory,root);
  const names=new Set(),blobs=new Set();
  for(const f of m.files){
    inside(directory,f.path);
    if(!m.roots.some(root=>f.path.startsWith(root+'/')))throw Error('File outside declared roots');
    if(names.has(f.path.toLowerCase())||blobs.has(f.blob)||!/^\d{8}\.enc$/.test(f.blob))throw Error('Duplicate or invalid manifest entry');
    names.add(f.path.toLowerCase());blobs.add(f.blob);
    await decryptFile(join(directory,f.blob),material.encryptionKey,f,f.path);
  }
  if((await readdir(directory)).sort().join('\n')!==[...blobs,'manifest.enc','complete.json'].sort().join('\n'))throw Error('Unexpected backup files');
  return m;
}
export async function unpackBundle(directory,target,material) {
  const m=await verifyBundle(directory,material);
  await plain(dirname(target),true);await mkdir(target,{mode:0o700});
  for(const root of m.roots)await mkdir(inside(target,root),{recursive:true,mode:0o700});
  for(const f of m.files){const destination=inside(target,f.path);await mkdir(dirname(destination),{recursive:true,mode:0o700});await plain(dirname(destination),true);await decryptFile(join(directory,f.blob),material.encryptionKey,f,f.path,destination);}
  return m;
}
export async function copyBundle(source,target,material) {
  await verifyBundle(source,material);await plain(dirname(target),true);await mkdir(target,{mode:0o700});
  for(const name of (await readdir(source)).filter(n=>n!=='complete.json'))await copyFile(join(source,name),join(target,name),1);
  for(const name of (await readdir(source)).filter(n=>n!=='complete.json'))if(await digestFile(join(source,name))!==await digestFile(join(target,name)))throw Error('Copied file differs');
  for(const name of (await readdir(target)))await flush(join(target,name));
  await copyFile(join(source,'complete.json'),join(target,'complete.json'),1);
  await flush(join(target,'complete.json'));
  return verifyBundle(target,material);
}
