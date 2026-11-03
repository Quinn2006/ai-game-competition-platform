import { readFile,lstat,realpath } from 'node:fs/promises';
import { resolve,relative,isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../backend/src/config.mjs';
import { createDatabase } from '../backend/src/platform/database.mjs';
import { createIdentityService } from '../backend/src/modules/identity/service.mjs';
import { createLocalStorage } from '../backend/src/platform/local-storage.mjs';
import { createScanner } from '../backend/src/modules/uploads/scanner.mjs';
import { importCollection } from '../backend/src/modules/uploads/collection.mjs';

let database;
try{
 const config=loadConfig();
 if(config.environment!=='development'||new URL(config.databaseUrl).hostname!=='127.0.0.1')throw Error('Local development only');
 const incoming=resolve(config.submissionsRoot,'development/incoming');
 async function localFile(name,max){
  const path=resolve(incoming,name),rel=relative(incoming,path);
  if(!rel||rel.startsWith('..')||isAbsolute(rel))throw Error('File must be inside incoming');
  const stat=await lstat(path),actual=relative(await realpath(incoming),await realpath(path));
  if(!stat.isFile()||stat.isSymbolicLink()||actual.startsWith('..')||isAbsolute(actual)||stat.size>max)throw Error('Invalid collected file');
  return readFile(path);
 }
 const manifest=JSON.parse(await localFile(process.argv[2],64000));
 let token='';for await(const part of process.stdin){token+=part;if(token.length>512)throw Error('Invalid session');}
 database=createDatabase(config,()=>{});
 const identity=createIdentityService({database,secret:config.sessionSecret,localAccounts:true});
 const screenshots=[];for(const s of manifest.screenshots||[])screenshots.push({type:s.type,bytes:await localFile(s.file,500000)});
 const result=await importCollection({identity,storage:createLocalStorage(config.submissionsRoot,config.environment),scan:createScanner({port:config.scannerPort}),limits:config.uploadLimits,deadline:config.submissionDeadline},
  {...manifest,zip:await localFile(manifest.zip,config.uploadLimits.compressed),screenshots},{sessionToken:token.trim(),requestId:randomUUID()});
 console.log(JSON.stringify(result));
 if(result.rejected)process.exitCode=1;
}catch{console.error('Collection import failed: check owner session, manifest, files and scanner. No credentials printed.');process.exitCode=1;}
finally{await database?.end();}
