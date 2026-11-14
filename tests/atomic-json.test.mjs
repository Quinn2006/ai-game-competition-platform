import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir,mkdtemp,readFile,writeFile,rename,readdir } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { writeAtomicJson } from '../scripts/atomic-json.mjs';

async function fixture(){await mkdir(resolve('tmp'),{recursive:true});return mkdtemp(resolve('tmp/atomic-json-'));}
const psQuote=value=>"'"+value.replaceAll("'","''")+"'";
async function reader(script){
  const child=spawn('pwsh.exe',['-NoProfile','-EncodedCommand',Buffer.from("$ErrorActionPreference='Stop';"+script,'utf16le').toString('base64')],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  let stderr='';child.stderr.on('data',chunk=>{stderr+=chunk;});
  await Promise.race([once(child.stdout,'data'),once(child,'exit').then(()=>{throw Error(stderr||'Reader exited before ready');})]);
  return child;
}
async function release(child){const exited=once(child,'exit');child.stdin.end();await exited;assert.equal(child.exitCode,0);}

test('Windows lease publication survives concurrent shared JSON reads without partial data',{skip:process.platform!=='win32',timeout:30000},async()=>{
  const dir=await fixture(),file=join(dir,'lease.json'),stop=join(dir,'stop');await writeAtomicJson(file,{sequence:0});
  const child=await reader(`. ${psQuote(resolve('scripts/read-shared-json.ps1'))};[Console]::WriteLine('ready');while(-not [IO.File]::Exists(${psQuote(stop)})){$value=Read-AgpSharedJson ${psQuote(file)};if($null -eq $value.sequence){throw 'Partial JSON'}}`);
  try{for(let i=1;i<=250;i++)await writeAtomicJson(file,{sequence:i});assert.equal(JSON.parse(await readFile(file,'utf8')).sequence,250);}
  finally{const exited=once(child,'exit');await writeFile(stop,'stop');await exited;assert.equal(child.exitCode,0);}
});

test('atomic JSON retries a transient Windows sharing lock without exposing partial content',{skip:process.platform!=='win32',timeout:10000},async()=>{
  const dir=await fixture(),file=join(dir,'lease.json');await writeAtomicJson(file,{sequence:0});
  const child=await reader(`$f=[IO.File]::Open(${psQuote(file)},[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite);try{[Console]::WriteLine('ready');[void][Console]::In.ReadLine()}finally{$f.Dispose()}`);
  const old=join(dir,'old.json');await writeFile(old,'{}');await assert.rejects(rename(old,file),{code:'EPERM'});
  let completed=false;const writing=writeAtomicJson(file,{sequence:1}).then(()=>{completed=true;});
  await new Promise(r=>setTimeout(r,100));assert.equal(completed,false);assert.deepEqual(JSON.parse(await readFile(file,'utf8')),{sequence:0});
  await release(child);await writing;assert.deepEqual(JSON.parse(await readFile(file,'utf8')),{sequence:1});
  assert.equal((await readdir(dir)).some(name=>name.endsWith('.tmp')),false);
});

test('persistent Windows sharing denial fails within budget and retains the prior JSON',{skip:process.platform!=='win32',timeout:10000},async()=>{
  const dir=await fixture(),file=join(dir,'lease.json');await writeAtomicJson(file,{sequence:0});
  const child=await reader(`$f=[IO.File]::Open(${psQuote(file)},[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite);try{[Console]::WriteLine('ready');[void][Console]::In.ReadLine()}finally{$f.Dispose()}`);
  try{const started=performance.now();await assert.rejects(writeAtomicJson(file,{sequence:1},{retryMs:80}),{code:'EPERM'});assert.ok(performance.now()-started<1500);assert.deepEqual(JSON.parse(await readFile(file,'utf8')),{sequence:0});assert.deepEqual(await readdir(dir),['lease.json']);}
  finally{await release(child);}
});
