import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import {decodeAttachment} from './handoff.mjs';

import {Registry} from './registry.mjs';
const terminal = ['succeeded','failed','interrupted','cancelled'];
const now = () => new Date().toISOString();
function requireValue(ok, message) { if (!ok) throw new Error(message); }

export class Queue {
  constructor(path,localDeviceId) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, requestId TEXT UNIQUE, target TEXT, prompt TEXT, mode TEXT,
        state TEXT, cancelRequested INTEGER DEFAULT 0, result TEXT DEFAULT '', workspace TEXT DEFAULT '',
        created TEXT, updated TEXT);
      CREATE TABLE IF NOT EXISTS workers (target TEXT PRIMARY KEY, seen TEXT, status TEXT);
      CREATE TABLE IF NOT EXISTS stopped_handoffs(requestId TEXT PRIMARY KEY,created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_artifacts(taskId TEXT PRIMARY KEY, size INTEGER NOT NULL,
        sha256 TEXT NOT NULL, content BLOB NOT NULL);`);
    const columns=this.db.prepare('PRAGMA table_info(tasks)').all().map(c=>c.name);
    this.registry=new Registry(this.db,localDeviceId);
    this.db.exec('BEGIN IMMEDIATE');
    try{
      if(!this.db.prepare('PRAGMA table_info(workers)').all().some(c=>c.name==='isolatedRead'))
        this.db.exec('ALTER TABLE workers ADD COLUMN isolatedRead INTEGER NOT NULL DEFAULT 0');
      for(const field of ['startedAt','lastHeartbeatAt','finishedAt','progress','workerState']){
        if(!columns.includes(field))this.db.exec('ALTER TABLE tasks ADD COLUMN '+field+' TEXT');
      }
      if(!columns.includes('finishedAt'))this.db.exec("UPDATE tasks SET finishedAt=updated WHERE state IN ('succeeded','failed','interrupted','cancelled')");
      if(!columns.includes('inputTaskId'))this.db.exec('ALTER TABLE tasks ADD COLUMN inputTaskId TEXT');
      if(!columns.includes('exportFile'))this.db.exec('ALTER TABLE tasks ADD COLUMN exportFile INTEGER NOT NULL DEFAULT 0');
      if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='task_receipts'").get()) {
        this.db.exec(`CREATE TABLE task_receipts(seq INTEGER PRIMARY KEY AUTOINCREMENT, taskId TEXT NOT NULL UNIQUE);
          INSERT INTO task_receipts(taskId) SELECT id FROM tasks WHERE finishedAt IS NOT NULL ORDER BY finishedAt,rowid;`);
      }
      this.db.exec(`CREATE TRIGGER IF NOT EXISTS track_task_receipt AFTER UPDATE OF state ON tasks
        WHEN OLD.state != NEW.state AND NEW.state IN ('succeeded','failed','interrupted','cancelled')
        BEGIN INSERT OR IGNORE INTO task_receipts(taskId) VALUES (NEW.id); END;`);
      this.db.exec('COMMIT');
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  close() { this.db.close(); }
  describe(row) {
    const artifact=this.db.prepare('SELECT size,sha256 FROM task_artifacts WHERE taskId=?').get(row.id);
    return {...row,exportFile:Boolean(row.exportFile),attachment:artifact?{...artifact}:null};
  }
  get(id) {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
    requireValue(row, 'Unknown task'); return this.describe(row);
  }
  getByRequestId(requestId) {
    requireValue(typeof requestId==='string' && requestId.length>0 && requestId.length<=160,'Invalid request ID');
    const row=this.db.prepare('SELECT id FROM tasks WHERE requestId=?').get(requestId);
    return row?this.get(row.id):null;
  }
  cancelByRequestId(requestId) {
    requireValue(typeof requestId==='string' && requestId.length<=160 && /^(?:handoff|personal):[^\s\u0000-\u001f]+$/.test(requestId),'Expected an assignment request ID');
    this.db.exec('BEGIN IMMEDIATE');
    try{
      this.db.prepare('INSERT OR IGNORE INTO stopped_handoffs VALUES(?,?)').run(requestId,now());
      const row=this.getByRequestId(requestId);
      const task=row?this.cancel(row.id):null;
      this.db.exec('COMMIT');
      return {cancelled:true,task};
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  list() {
    return this.db.prepare('SELECT id,target,substr(prompt,1,140) AS title,mode,state,cancelRequested,inputTaskId,exportFile,created,updated,startedAt,lastHeartbeatAt,finishedAt,progress FROM tasks ORDER BY rowid DESC LIMIT 60').all().map(row=>this.describe(row));
  }
  wakeEvents({after=null,limit=100}={}) {
    if(after===null){
      const {cursor}=this.db.prepare('SELECT coalesce(max(seq),0) AS cursor FROM task_receipts').get();
      return {items:[],cursor,hasMore:false};
    }
    requireValue(Number.isSafeInteger(after)&&after>=0,'Invalid wake cursor');
    requireValue(Number.isInteger(limit)&&limit>=1&&limit<=250,'Invalid wake page size');
    const rows=this.db.prepare(`SELECT r.seq,t.id,t.target,t.requestId,t.state,t.finishedAt,substr(t.prompt,1,140) AS title
      FROM task_receipts r JOIN tasks t ON t.id=r.taskId WHERE r.seq>? ORDER BY r.seq LIMIT ?`).all(after,limit+1);
    const items=rows.slice(0,limit);
    return {items,cursor:items.at(-1)?.seq??after,hasMore:rows.length>limit};
  }
  workers() {
    return this.registry.list().map(worker => {
      const {target}=worker;
      const row = this.db.prepare('SELECT seen,status,isolatedRead FROM workers WHERE target=?').get(target);
      const last=this.db.prepare("SELECT state,result FROM tasks WHERE target=? AND state IN ('succeeded','failed') ORDER BY updated DESC LIMIT 1").get(target);
      const needsCredentials=last?.state==='failed' && /MISSING_CREDENTIAL|no API key|unauthorized|not logged in/i.test(last.result);
      return {...worker,seen:null,status:'offline',...row,isolatedRead:row?.isolatedRead===1,online:!!row && Date.now()-Date.parse(row.seen)<45000,needsCredentials:Boolean(needsCredentials)};
    });
  }
  submit({target, prompt, mode='read-only', requestId=randomUUID(),inputTaskId=null,exportFile=false}) {
    const worker=this.registry.get(target);
    requireValue(typeof prompt==='string' && prompt.trim() && prompt.length<=32000, 'Prompt must be 1–32000 characters');
    requireValue(['read-only','workspace-write'].includes(mode), 'Unsupported mode');
    if(/^personal:(?:wake|candidate):/.test(requestId)){
      requireValue(mode==='read-only'&&!exportFile&&inputTaskId===null,'Expected an isolated read without artifacts');
      requireValue(this.db.prepare('SELECT isolatedRead FROM workers WHERE target=?').get(target)?.isolatedRead===1,'Worker has no isolated read capability');
    }
    requireValue(typeof requestId==='string' && requestId.length>0 && requestId.length<=160, 'Invalid request ID');
    requireValue(typeof exportFile==='boolean'&&(!exportFile||mode==='workspace-write'),'Export requires a workspace-write task');
    requireValue(inputTaskId===null||typeof inputTaskId==='string'&&inputTaskId.length<=64,'Invalid source task');
    requireValue(!this.db.prepare('SELECT 1 FROM stopped_handoffs WHERE requestId=?').get(requestId),'Handoff has been stopped');
    const old=this.db.prepare('SELECT * FROM tasks WHERE requestId=?').get(requestId);
    if (old) {
      requireValue(old.target===target && old.prompt===prompt && old.mode===mode && old.inputTaskId===inputTaskId && Boolean(old.exportFile)===exportFile,'Request ID already used for different input');
      return this.describe(old);
    }
    requireValue(worker.capabilities.includes(mode),'Worker does not support requested mode');
    if(inputTaskId!==null || exportFile)requireValue(worker.capabilities.includes('handoff'),'Worker does not support file handoffs');
    if(inputTaskId!==null){
      const producer=this.get(inputTaskId);
      requireValue(producer.state==='succeeded'&&producer.attachment,'Source task has no completed handoff');
    }
    const id=randomUUID(), stamp=now();
    this.db.prepare('INSERT INTO tasks(id,requestId,target,prompt,mode,state,created,updated,inputTaskId,exportFile) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(id,requestId,target,prompt,mode,'queued',stamp,stamp,inputTaskId,Number(exportFile));
    return this.get(id);
  }
  claim(target) {
    // A synchronous operation on the sole broker connection. Re-deliver unacknowledged claims.
    const active=this.db.prepare("SELECT * FROM tasks WHERE target=? AND state='running'").get(target);
    const isolated=this.db.prepare('SELECT isolatedRead FROM workers WHERE target=?').get(target)?.isolatedRead===1;
    if (active) return isolated||!/^personal:(?:wake|candidate):/.test(active.requestId)?active:null;
    const stamp=now();
    return this.db.prepare(`UPDATE tasks SET state='running',updated=?,startedAt=?,progress='claimed' WHERE id=(
      SELECT id FROM tasks WHERE target=? AND state='queued'
      AND (? OR (requestId NOT GLOB 'personal:wake:*' AND requestId NOT GLOB 'personal:candidate:*')) ORDER BY rowid LIMIT 1) RETURNING *`).get(stamp,stamp,target,Number(isolated)) ?? null;
  }
  beat(target,id,status,progress,isolatedRead=false) {
    const stamp=now();
    this.db.prepare('INSERT OR REPLACE INTO workers(target,seen,status,isolatedRead) VALUES(?,?,?,?)').run(target,stamp,String(status||'ready').slice(0,180),Number(isolatedRead===true));
    if(id){
      const stage=['preparing_workspace','running_executor','collecting_result','sending_result'].includes(progress)?progress:status==='working'?'working':null;
      this.db.prepare("UPDATE tasks SET lastHeartbeatAt=?,progress=COALESCE(?,progress) WHERE id=? AND target=? AND state='running'").run(stamp,stage,id,target);
    }
    const row=id && this.db.prepare('SELECT cancelRequested FROM tasks WHERE id=? AND target=?').get(id,target);
    return {cancel:!!row?.cancelRequested};
  }
  input(target,id) {
    const row=this.get(id);
    requireValue(row.target===target && row.state==='running' && !row.cancelRequested && row.inputTaskId,'No authorized handoff for this claim');
    const blob=this.db.prepare('SELECT size,sha256,content FROM task_artifacts WHERE taskId=?').get(row.inputTaskId);
    requireValue(blob,'Source file unavailable');
    return {size:blob.size,sha256:blob.sha256,data:Buffer.from(blob.content).toString('base64')};
  }
  finish(target,{id,state,result='',workspace='',attachment=null}) {
    requireValue(terminal.includes(state),'Invalid task result');
    const row=this.get(id);requireValue(row.target===target,'Worker does not own task');
    if(terminal.includes(row.state)){
      if(row.state==='succeeded' && row.attachment){
        requireValue(attachment?.sha256===row.attachment.sha256 && attachment.size===row.attachment.size,'Conflicting artifact receipt');
      }
      return {ack:true};
    }
    requireValue(row.state==='running','Task has no active claim');
    const accepted=row.cancelRequested?'cancelled':state;
    let bytes=null;
    if(accepted==='succeeded'){
      requireValue(Boolean(attachment)===row.exportFile,'Expected explicitly requested output file');
      if(attachment)bytes=decodeAttachment(attachment);
    }else if(!row.cancelRequested){
      requireValue(!attachment,'Failed task cannot publish an artifact');
    }
    this.db.exec('BEGIN IMMEDIATE');
    try{
      if(bytes!==null)this.db.prepare('INSERT INTO task_artifacts VALUES(?,?,?,?)').run(id,bytes.length,attachment.sha256,bytes);
      const stamp=now();
      this.db.prepare('UPDATE tasks SET state=?,workerState=?,result=?,workspace=?,updated=?,finishedAt=?,progress=NULL WHERE id=?')
        .run(accepted,state,String(result).slice(0,128000),String(workspace).slice(0,1024),stamp,stamp,id);
      this.db.exec('COMMIT');
    }catch(e){this.db.exec('ROLLBACK');throw e;}
    return {ack:true};
  }
  cancel(id) {
    const stamp=now();
    this.db.prepare(`UPDATE tasks SET cancelRequested=1,finishedAt=CASE WHEN state='queued' THEN ? ELSE finishedAt END,
      state=CASE WHEN state='queued' THEN 'cancelled' ELSE state END,updated=?
      WHERE id=? AND state IN ('queued','running')`).run(stamp,stamp,id);
    return this.get(id);
  }
}
