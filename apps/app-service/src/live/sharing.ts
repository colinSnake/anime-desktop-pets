import { randomBytes } from 'node:crypto';import {rename,type FileHandle} from 'node:fs/promises';import type {Stats} from 'node:fs';
import {petId,revision} from '../../../../packages/contracts/src/pets.ts';import {recordID} from '../../../../packages/contracts/src/character-records.ts';
import {PrivateDirectory,sameFile} from '../models/private-directory.ts';
export type LiveShareGrant={petID:string;recordID:'identity'|string;recordRevision:number;kind:'identity'|'memory'};
export type LiveShareSnapshot={revision:number;grants:LiveShareGrant[]};
const file='share-grants.json',lockFile='share-grants.lock',limit=16*1024;const invalid=()=>new Error('invalid_live_share');const conflict=()=>new Error('live_share_conflict');
const empty=():LiveShareSnapshot=>({revision:0,grants:[]});
function validGrant(value:unknown):value is LiveShareGrant{
 if(!value||typeof value!=='object'||Array.isArray(value))return false;const g=value as Record<string,unknown>;
 const keys=Object.keys(g).sort().join(',');return keys==='kind,petID,recordID,recordRevision'&&petId(g.petID)&&revision(g.recordRevision)&&g.recordRevision>0&&
 ((g.kind==='identity'&&g.recordID==='identity')||(g.kind==='memory'&&recordID(g.recordID)));
}
function validGrants(value:unknown):value is LiveShareGrant[]{return Array.isArray(value)&&value.length<=96&&value.every(validGrant)&&new Set(value.map(g=>`${g.petID}:${g.kind}:${g.recordID}`)).size===value.length;}
function parse(bytes:Buffer):LiveShareSnapshot{const v:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));if(!v||typeof v!=='object'||Array.isArray(v))throw invalid();const r=v as Record<string,unknown>;if(Object.keys(r).length!==3||r.schemaVersion!==1||!revision(r.revision)||!validGrants(r.grants))throw invalid();return {revision:r.revision,grants:structuredClone(r.grants)};}
export class LiveShareStore{
 private readonly directory:PrivateDirectory;private tail:Promise<unknown>=Promise.resolve();private closing=false;private managementTail:Promise<unknown>=Promise.resolve();
 constructor(root:string){this.directory=new PrivateDirectory(root);}
 private run<T>(fn:()=>Promise<T>):Promise<T>{if(this.closing)return Promise.reject(invalid());const p=this.tail.then(fn);this.tail=p.catch(()=>{});return p;}
 // Serialize binding changes with grants without nesting the file I/O queue.
 manage<T>(fn:()=>Promise<T>):Promise<T>{if(this.closing)return Promise.reject(invalid());const p=this.managementTail.then(fn);this.managementTail=p.catch(()=>{});return p;}
 async close(){this.closing=true;await this.managementTail;await this.tail;}
 read():Promise<LiveShareSnapshot>{return this.run(async()=>{const row=await this.directory.read(file,limit);return row?parse(row.bytes):empty();});}
 write(expectedRevision:number,grants:LiveShareGrant[]):Promise<LiveShareSnapshot>{return this.run(async()=>{
  if(!revision(expectedRevision)||!validGrants(grants))throw invalid();let lock:FileHandle|undefined,lockInfo:Stats|undefined;
  try{try{lock=await this.directory.create(lockFile);}catch{throw conflict();}lockInfo=await lock.stat();await lock.close();lock=undefined;
   const old=await this.directory.read(file,limit),current=old?parse(old.bytes):empty();if(current.revision!==expectedRevision)throw conflict();
   const next={revision:current.revision+1,grants:structuredClone(grants)};await this.persist(next,old);return next;
  }finally{await lock?.close().catch(()=>{});if(lockInfo)await this.directory.removeOwned(lockFile,lockInfo).catch(()=>{});}
 });}
 private async persist(s:LiveShareSnapshot,old:Awaited<ReturnType<PrivateDirectory['read']>>){const temp=`.share-${randomBytes(10).toString('hex')}.tmp`;let h:FileHandle|undefined,identity:Stats|undefined;try{
  h=await this.directory.create(temp);identity=await h.stat();await h.writeFile(JSON.stringify({schemaVersion:1,...s}));await h.sync();await h.close();h=undefined;
  const latest=await this.directory.file(file);if(old?!latest||!sameFile(old.info,latest)||old.info.ctimeMs!==latest.ctimeMs:!!latest)throw conflict();await rename(this.directory.path(temp),this.directory.path(file));await this.directory.sync();
 }finally{await h?.close().catch(()=>{});if(identity)await this.directory.removeOwned(temp,identity).catch(()=>{});}}
}
