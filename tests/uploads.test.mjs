import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { inspectZip } from '../src/modules/uploads/zip.mjs';
import { createScanner } from '../src/modules/uploads/scanner.mjs';
import { networkOrigins } from '../src/modules/uploads/service.mjs';
import { zipFixture } from './zip-fixture.mjs';

test('ZIP stored/deflate, binary resources, root entry and findings',async()=>{
  for(const deflate of [true,false]){const data=await inspectZip(zipFixture([['index.html','<script>fetch("https://example.com")</script>'],['a.png',Buffer.from([0,1,2,3])]],{deflate}));assert.equal(data.files.size,2);assert.equal(data.findings[0].kind,'network');}
  await assert.rejects(inspectZip(zipFixture([['Index.html','x']])),{code:'ROOT_ENTRY_REQUIRED'});
});
test('ZIP blocks traversal, Windows paths, encoded paths, duplicate names, forbidden files and executable disguises',async()=>{
  for(const path of ['../x.js','/x.js','C:/x.js','a\\x.js','%2e%2e/x.js','a/../x.js','a//x.js','aux.js','a./x.js','a.exe','a.zip','a.html:stream','a.js?x'])await assert.rejects(inspectZip(zipFixture([['index.html','x'],[path,'x']])));
  await assert.rejects(inspectZip(zipFixture([['index.html','x'],['INDEX.html','x']])),{code:'DUPLICATE_ZIP_PATH'});
  await assert.rejects(inspectZip(zipFixture([['index.html','MZ executable']])),{code:'DANGEROUS_FILE'});
});
test('ZIP checks exact limits, bomb metadata, CRC, overlapping entries, encryption, links and truncation',async()=>{
  const bytes=zipFixture([['index.html','12345']]);const limits={compressed:bytes.length,expanded:5,files:1};assert.equal((await inspectZip(bytes,limits)).expandedBytes,5);
  for(const key of ['compressed','expanded'])await assert.rejects(inspectZip(bytes,{...limits,[key]:limits[key]-1}));
  await assert.rejects(inspectZip(zipFixture([['index.html','x'],['a.js','x']]),{...limits,compressed:10000}));
  const central=bytes.readUInt32LE(bytes.length-6);
  for(const mutate of [b=>b[40]^=1,b=>b.writeUInt16LE(1,central+8),b=>b.writeUInt32LE(0xa0000000,central+38),b=>b.writeUInt32LE(1,central+42),b=>b.writeUInt32LE(999999999,central+24)]){const bad=Buffer.from(bytes);mutate(bad);await assert.rejects(inspectZip(bad));}
  for(const length of [0,1,20,bytes.length-1])await assert.rejects(inspectZip(bytes.subarray(0,length)));
  const bomb=zipFixture([['index.html','x'.repeat(10000)]],{deflate:true});const c=bomb.readUInt32LE(bomb.length-6);bomb.writeUInt32LE(1,22);bomb.writeUInt32LE(1,c+24);await assert.rejects(inspectZip(bomb),{code:'INVALID_COMPRESSED_DATA'});
});
test('network allowlist accepts only exact HTTPS public domain origins',()=>{
  assert.deepEqual(networkOrigins(['https://assets.example.com']),['https://assets.example.com']);
  for(const item of ['http://assets.example.com','https://*.example.com','https://example.com/path','https://user:pw@example.com','https://127.0.0.1','https://example.com:444','data:x'])assert.throws(()=>networkOrigins([item]));
});
test('Clamd protocol handles clean/infected/error, fragmented replies and deadline over sockets',async t=>{
  const responses=['stream: OK\0','stream: Test FOUND\0','stream: size limit exceeded ERROR\0',null];let call=0;
  const server=createServer(socket=>{const response=responses[call++];socket.on('error',()=>{});socket.on('data',()=>{});if(response){socket.write(response.slice(0,5));setTimeout(()=>socket.end(response.slice(5)),10);}});
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>server.close());
  const scan=createScanner({port:server.address().port,timeout:100});
  for(const status of ['clean','infected','error','error'])assert.equal((await scan(Buffer.from('sample'))).status,status);
});
