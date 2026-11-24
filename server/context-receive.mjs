import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {safeDeviceId} from './registry.mjs';
import {idPattern,contextDigest,validRow} from './context-format.mjs';
import {machineRows} from './context-read.mjs';
export {contextDigest};

function atomic(file,data){
  const temp=file+'.'+randomUUID()+'.tmp';
  try{
    fs.writeFileSync(temp,JSON.stringify(data),{mode:0o600,flag:'wx',flush:true});
    fs.renameSync(temp,file);
  }finally{fs.rmSync(temp,{force:true});}
}
export class ContextReceiver{
  constructor(home,now=Date.now){
    this.home=home;this.now=now;this.pending=new Map();
    this.dir=path.join(home,'contexts');fs.mkdirSync(this.dir,{recursive:true,mode:0o700});
  }
  plan(machine,{entries},scope){
    if(!safeDeviceId(machine)||!Array.isArray(entries)||entries.length>25000)throw Error('Invalid context manifest');
    const current=new Map(machineRows(this.home,machine).filter(r=>!scope||scope.sources.includes(r.source)).map(r=>[r.id,r]));
    const staged=new Map();const hashes=new Map();const missing=[];
    for(const entry of entries){
      if(!Array.isArray(entry)||entry.length!==2)throw Error('Invalid manifest entry');
      const [id,hash]=entry;
      if(!idPattern.test(id)||!/^[a-f0-9]{64}$/.test(hash)||hashes.has(id))throw Error('Invalid context digest');
      hashes.set(id,hash);
      const prev=current.get(id);
      if(prev&&contextDigest(prev)===hash)staged.set(id,prev);
      else missing.push(id);
    }
    const generation=randomUUID();
    this.pending.set(machine+'|'+(scope?.target??''),{scope,generation,hashes,staged,changed:missing.length>0||current.size!==hashes.size});
    return {generation,missing};
  }
  stage(machine,generation,scope){
    const p=this.pending.get(machine+'|'+(scope?.target??''));
    if(!p||generation!==p.generation||JSON.stringify(scope?.sources)!==JSON.stringify(p.scope?.sources))throw Error('Expired context refresh');
    return p;
  }
  put(machine,{generation,rows},scope){
    const p=this.stage(machine,generation,scope);
    if(!Array.isArray(rows)||rows.length>100)throw Error('Invalid context batch');
    for(const row of rows){
      if(!validRow(row)||scope&&!scope.sources.includes(row.source)||p.hashes.get(row.id)!==contextDigest(row))throw Error('Invalid context record');
    }
    for(const row of rows)p.staged.set(row.id,row);
    return {accepted:rows.length};
  }
  commit(machine,{generation},scope){
    const p=this.stage(machine,generation,scope);
    if(p.staged.size!==p.hashes.size)throw Error('Incomplete context refresh');
    if(p.changed){
      const untouched=scope?machineRows(this.home,machine).filter(row=>!scope.sources.includes(row.source)):[];
      if(untouched.some(row=>p.staged.has(row.id)))throw Error('Session ID already used by another connector');
      const rows=[...untouched,...p.staged.values()].sort((a,b)=>a.id.localeCompare(b.id));
      atomic(path.join(this.dir,machine+'.json'),rows);
    }
    const lastSyncAt=new Date(this.now()).toISOString();
    const seenFile=path.join(this.dir,machine+'.seen.json');
    const seen=fs.existsSync(seenFile)?JSON.parse(fs.readFileSync(seenFile,'utf8')):{};
    const connectorSync={...seen.connectorSync};
    if(scope)connectorSync[scope.target]=lastSyncAt;
    atomic(seenFile,{lastSyncAt,connectorSync});
    this.pending.delete(machine+'|'+(scope?.target??''));
    return {count:p.hashes.size,lastSyncAt};
  }
}
