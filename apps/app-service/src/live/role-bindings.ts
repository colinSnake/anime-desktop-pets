import { randomBytes } from 'node:crypto';
import { rename, type FileHandle } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { isLiveRoleId, liveRoleIds, type LiveRoleId } from '../../../../packages/contracts/src/live-stage.ts';
import { petId, type PetDefinition } from '../../../../packages/contracts/src/pets.ts';
import { liveRoleForPackage } from '../../../../packages/contracts/src/character-personas.ts';
import { PrivateDirectory, sameFile } from '../models/private-directory.ts';

export type LiveRoleBindings = {longmei:string|null; dafeiyu:string|null};
export type LiveRoleBindingSnapshot = {revision:number; bindings:LiveRoleBindings};
const file='role-bindings.json', lockFile='role-bindings.lock', limit=1024;
const invalid=()=>new Error('invalid_live_role_bindings');
const conflict=()=>new Error('live_role_bindings_conflict');
const blank=():LiveRoleBindingSnapshot=>({revision:0,bindings:{longmei:null,dafeiyu:null}});
function validBindings(value:unknown):value is LiveRoleBindings {
  if(!value||typeof value!=='object'||Array.isArray(value)) return false;
  const row=value as Record<string,unknown>;
  return Object.keys(row).length===2 && Object.keys(row).every(isLiveRoleId) &&
    liveRoleIds.every(role=>row[role]===null||petId(row[role])) &&
    !(typeof row.longmei==='string'&&row.longmei===row.dafeiyu);
}
function parse(bytes:Buffer):LiveRoleBindingSnapshot {
  const value:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  if(!value||typeof value!=='object'||Array.isArray(value)) throw invalid();
  const row=value as Record<string,unknown>;
  if(Object.keys(row).length!==3||row.schemaVersion!==1||!Number.isSafeInteger(row.revision)||Number(row.revision)<0||!validBindings(row.bindings)) throw invalid();
  return {revision:Number(row.revision),bindings:structuredClone(row.bindings)};
}
export class LiveRoleBindingStore {
  private readonly directory:PrivateDirectory;
  private tail:Promise<unknown>=Promise.resolve();
  private closing=false;
  constructor(root:string){this.directory=new PrivateDirectory(root);}
  private run<T>(op:()=>Promise<T>):Promise<T>{if(this.closing)return Promise.reject(invalid());const result=this.tail.then(op);this.tail=result.catch(()=>{});return result;}
  close(){this.closing=true;return this.tail;}
  read():Promise<LiveRoleBindingSnapshot>{return this.run(async()=>{const row=await this.directory.read(file,limit);return row?parse(row.bytes):blank();});}
  write(expectedRevision:number,bindings:LiveRoleBindings):Promise<LiveRoleBindingSnapshot>{return this.run(async()=>{
    if(!Number.isSafeInteger(expectedRevision)||expectedRevision<0||!validBindings(bindings)) throw invalid();
    let lock:FileHandle|undefined; let lockInfo:Stats|undefined;
    try {
      try {lock=await this.directory.create(lockFile);} catch {throw conflict();}
      lockInfo=await lock.stat(); await lock.close(); lock=undefined;
      const old=await this.directory.read(file,limit), current=old?parse(old.bytes):blank();
      if(current.revision!==expectedRevision) throw conflict();
      const next:LiveRoleBindingSnapshot={revision:current.revision+1,bindings:structuredClone(bindings)};
      await this.persist(next,old);
      return next;
    } finally {
      await lock?.close().catch(()=>{});
      if(lockInfo) await this.directory.removeOwned(lockFile,lockInfo).catch(()=>{});
    }
  });}
  async validateInstance(role:LiveRoleId,id:string,instance:PetDefinition):Promise<boolean>{
    return this.run(async()=>instance.id===id&&liveRoleForPackage(instance.package)===role);
  }
  private async persist(snapshot:LiveRoleBindingSnapshot,old:Awaited<ReturnType<PrivateDirectory['read']>>):Promise<void>{
    const temp=`.role-${randomBytes(10).toString('hex')}.tmp`;let handle:FileHandle|undefined;let identity:Stats|undefined;
    try{
      handle=await this.directory.create(temp);identity=await handle.stat();
      await handle.writeFile(JSON.stringify({schemaVersion:1,...snapshot}));await handle.sync();await handle.close();handle=undefined;
      const current=await this.directory.file(file);
      if(old?!current||!sameFile(old.info,current)||old.info.ctimeMs!==current.ctimeMs:!!current) throw conflict();
      await rename(this.directory.path(temp),this.directory.path(file));await this.directory.sync();
    }finally{await handle?.close().catch(()=>{});if(identity)await this.directory.removeOwned(temp,identity).catch(()=>{});}
  }
}
