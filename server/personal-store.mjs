import {WorkJournal} from './personal-work.mjs';
import {WorkContinuity} from './continuity.mjs';
import {idPattern} from './context-format.mjs';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID,createHash} from 'node:crypto';

const iso = () => new Date().toISOString();
const fingerprint = s => createHash('sha256').update(s).digest('hex');
export class PersonalStore {
  constructor(file) {
    this.db=new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=4000;
      CREATE TABLE IF NOT EXISTS messages(seq INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL,role TEXT NOT NULL,text TEXT NOT NULL,createdAt TEXT NOT NULL,parent TEXT);
      CREATE TABLE IF NOT EXISTS turns(id TEXT PRIMARY KEY, requestId TEXT UNIQUE NOT NULL, signature TEXT NOT NULL,state TEXT NOT NULL,plan TEXT, attempts INTEGER NOT NULL DEFAULT 0,nextTry INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS prefs(id TEXT PRIMARY KEY,key TEXT NOT NULL,text TEXT NOT NULL,scope TEXT NOT NULL,source TEXT NOT NULL,updatedAt TEXT,UNIQUE(key,scope));
      CREATE TABLE IF NOT EXISTS pref_provenance(key TEXT,scope TEXT,turnId TEXT,versionText TEXT,PRIMARY KEY(key,scope,turnId));
      CREATE TABLE IF NOT EXISTS memory_exclusions(id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS forgotten_keys(key TEXT,scope TEXT,turnId TEXT,PRIMARY KEY(key,scope));
      CREATE TABLE IF NOT EXISTS forgotten(hash TEXT PRIMARY KEY,stamp TEXT);
      CREATE TABLE IF NOT EXISTS commitments(id TEXT PRIMARY KEY,text TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'open',dueAt TEXT,intervalDays INTEGER DEFAULT 0,source TEXT NOT NULL,createdAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS action_receipts(turnId TEXT,position INTEGER,result TEXT NOT NULL,PRIMARY KEY(turnId,position));
      CREATE TABLE IF NOT EXISTS assignments(id TEXT PRIMARY KEY,turnId TEXT NOT NULL,notify INTEGER NOT NULL,reported INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS notices(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,createdAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS watches(id TEXT PRIMARY KEY,machine TEXT,sessionId TEXT,watermark TEXT,text TEXT,source TEXT,active INTEGER DEFAULT 1);
      CREATE TABLE IF NOT EXISTS turn_sources(turnId TEXT PRIMARY KEY,machine TEXT NOT NULL,sessionId TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS contextlinks(id TEXT PRIMARY KEY,machine TEXT NOT NULL,sessionId TEXT NOT NULL,turnId TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS observed(id TEXT PRIMARY KEY,machine TEXT,sessionId TEXT,text TEXT,sourceTime TEXT,status TEXT NOT NULL,reason TEXT);
      CREATE TABLE IF NOT EXISTS diagnostics(kind TEXT,id TEXT,PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS device_aliases(alias TEXT COLLATE NOCASE,scope TEXT,deviceId TEXT,source TEXT,PRIMARY KEY(alias,scope));
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
    this.continuity=new WorkContinuity(this);
    this.work=new WorkJournal(this.db,this.continuity);
  }
  transact(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {const value=fn();this.db.exec('COMMIT');return value;}
    catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  receive({requestId,text,context,workId},selectedRow=null) {
    if(typeof requestId!=='string'||!requestId.trim()||requestId.length>150)throw Error('缺少有效消息编号');
    if(typeof text!=='string'||!text.trim()||text.length>16000)throw Error('请输入 1–16000 字的消息');
    text=text.trim();
    if(context!=null&&((typeof context.machine!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(context.machine))||typeof context.id!=='string'||!/^[a-f0-9-]{36}$/i.test(context.id)))throw Error('无效的会话引用');
    if(workId!=null&&(!context||typeof workId!=='string'||!idPattern.test(workId)))throw Error('需要选择会话和有效的工作编号');
    const parts=context?[text,context.machine,context.id]:null;
    if(workId)parts.push(workId);
    const signature=fingerprint(parts?JSON.stringify(parts):text);
    return this.transact(()=>{
      const old=this.db.prepare('SELECT * FROM turns WHERE requestId=?').get(requestId);
      if(old){
        if(old.signature!==signature)throw Error('这条消息编号已经用于其他内容');
        const linked=this.continuity.workForTurn(old.id);
        return linked?{id:old.id,workId:linked}:{id:old.id};
      }
      const id=randomUUID();
      this.message(id,'user',text);
      this.db.prepare("INSERT INTO turns(id,requestId,signature,state) VALUES(?,?,?,'new')").run(id,requestId,signature);
      if(context)this.db.prepare('INSERT INTO turn_sources VALUES(?,?,?)').run(id,context.machine,context.id);
      const linked=this.continuity.receive(id,text,context,selectedRow,workId);
      return linked?{id,workId:linked}:{id};
    });
  }
  message(id,role,text,parent=null,notify=false) {
    const stamp=iso();
    this.db.prepare('INSERT OR IGNORE INTO messages(id,role,text,createdAt,parent) VALUES(?,?,?,?,?)').run(id,role,text,stamp,parent);
    if(notify)this.db.prepare('INSERT OR IGNORE INTO notices(id,createdAt) VALUES(?,?)').run(id,stamp);
  }
  pending() {
    return this.db.prepare("SELECT t.*,m.text,m.seq FROM turns t JOIN messages m ON m.id=t.id WHERE t.state!='done' ORDER BY m.seq LIMIT 1").get();
  }
  heldForInput(parent) {
    // A phone message may revise the result that is being synthesized. Let the
    // router classify it first. Other explicitly linked works stay independent.
    return Boolean(this.db.prepare(`SELECT 1 FROM messages original JOIN messages newer ON newer.seq>original.seq
      JOIN turns t ON t.id=newer.id LEFT JOIN continuity_turns linked ON linked.turnId=t.id
      LEFT JOIN continuity_turns origin ON origin.turnId=original.id WHERE original.id=?
      AND t.state!='done' AND (linked.workId IS NULL OR linked.workId=origin.workId) LIMIT 1`).get(parent));
  }
  visibleTasks(items){
    const ignored=new Set(this.db.prepare("SELECT id FROM diagnostics WHERE kind='task'").all().map(r=>r.id));
    return items.filter(t=>!ignored.has(t.id));
  }
  history({around,before,limit=80}={}) {
    const shown="NOT EXISTS(SELECT 1 FROM diagnostics d WHERE d.kind='turn' AND (d.id=messages.id OR d.id=messages.parent))";
    limit=Math.max(5,Math.min(150,Number(limit)||80));
    let rows;
    if(around){
      const center=this.db.prepare('SELECT seq FROM messages WHERE id=?').get(String(around));
      if(center){
        const first=this.db.prepare('SELECT * FROM messages WHERE '+shown+' AND seq<=? ORDER BY seq DESC LIMIT ?').all(center.seq,Math.ceil(limit/2)).reverse();
        rows=first.concat(this.db.prepare('SELECT * FROM messages WHERE '+shown+' AND seq>? ORDER BY seq LIMIT ?').all(center.seq,limit-first.length));
      }
    }
    if(!rows)rows=this.db.prepare('SELECT * FROM messages WHERE '+shown+' AND seq<? ORDER BY seq DESC LIMIT ?').all(Number(before)||Number.MAX_SAFE_INTEGER,limit).reverse();
    const request=this.db.prepare('SELECT requestId FROM turns WHERE id=?');
    for(const row of rows){
      if(row.role==='user'){
        row.requestId=request.get(row.id)?.requestId;
        const work=this.work.card(row.id);if(work)row.work=work;
        const continuity=this.continuity.status(row.id);if(continuity)row.continuity=continuity;
      }else if(row.id.startsWith('reply-')){
        const revision=this.db.prepare('SELECT parent FROM work_revisions WHERE turnId=?').get(row.parent);
        if(revision)row.work=this.work.card(revision.parent);
      }else if(row.id.startsWith('desktop-')){
        row.provenance=this.continuity.provenance(row.id);
      }
    }
    return {messages:rows,pending:this.db.prepare("SELECT count(*) n FROM turns WHERE state!='done'").get().n+this.work.activeCount()};
  }
  setDeviceAlias(a,source){
    this.db.prepare('INSERT OR REPLACE INTO device_aliases(alias,scope,deviceId,source) VALUES(?,?,?,?)').run(a.alias,a.scope,a.deviceId,source);
  }
  deviceAliases(deviceId,project){
    const rows=this.db.prepare("SELECT alias,deviceId,scope FROM device_aliases WHERE scope='' OR scope=? ORDER BY length(scope)").all(project||'');
    const selected=new Map(rows.map(r=>[r.alias.toLocaleLowerCase(),r]));
    return [...selected.values()].filter(r=>r.deviceId===deviceId).map(r=>r.alias);
  }
  sourceFor(turnId){return this.db.prepare('SELECT machine,sessionId AS id FROM turn_sources WHERE turnId=?').get(turnId);}
  previous(seq,turnId) {
    const workId=this.continuity.workForTurn(turnId??this.db.prepare('SELECT id FROM messages WHERE seq=?').get(seq)?.id??'');
    const sql=`SELECT role,substr(text,1,1100) text FROM messages WHERE seq<?
      AND (? IS NULL OR EXISTS(SELECT 1 FROM continuity_turns w WHERE w.workId=? AND w.turnId=coalesce(messages.parent,messages.id)))
      AND NOT EXISTS(SELECT 1 FROM memory_exclusions WHERE memory_exclusions.id=messages.id)
      AND NOT EXISTS(SELECT 1 FROM diagnostics d WHERE d.kind='turn' AND (d.id=messages.id OR d.id=messages.parent))
      ORDER BY seq DESC LIMIT 14`;
    return this.db.prepare(sql).all(seq,workId,workId).reverse();
  }
  notifications({after=0}={}) {
    const start=Math.max(0,Number(after)||0);
    const items=this.db.prepare("SELECT n.seq,n.id,m.text,n.createdAt FROM notices n JOIN messages m ON m.id=n.id WHERE n.seq>? AND NOT EXISTS(SELECT 1 FROM diagnostics d WHERE d.kind='turn' AND d.id=m.parent) ORDER BY n.seq LIMIT 80").all(start);
    return {items,cursor:items.at(-1)?.seq??start};
  }
  preferences(){return this.db.prepare('SELECT id,key,text,scope,updatedAt FROM prefs ORDER BY updatedAt DESC').all();}
  commitments(){return this.db.prepare("SELECT id,text,status,dueAt,intervalDays FROM commitments WHERE status='open' AND NOT EXISTS(SELECT 1 FROM diagnostics d WHERE d.kind='turn' AND d.id=commitments.source) ORDER BY createdAt DESC").all();}
  observeSessions(rows,now=Date.now()){
    const upsert=this.db.prepare(`INSERT INTO observed VALUES(?,?,?,?,?,'observed',?)
      ON CONFLICT(id) DO UPDATE SET text=excluded.text,sourceTime=excluded.sourceTime,reason=excluded.reason
      WHERE observed.status='observed' AND observed.sourceTime!=excluded.sourceTime`);
    const resolve=this.db.prepare("UPDATE observed SET status='settled' WHERE id=? AND status='observed' AND sourceTime<?");
    this.transact(()=>{
      for(const row of rows){
        if(now-Date.parse(row.updatedAt)>30*86400000)continue;
        const id='context:'+row.machine+':'+row.id;
        if(row.archived){resolve.run(id,row.updatedAt);continue;}
        const evidence=row.evidence||[];
        const latest=evidence.at(-1);
        const marker=latest?.text?.split(/[。！？！？\n]/u).find(s=>/尚未完成|还没完成|待办|仍需|等待你|等待确认|接下来需要|下一步是|blocked by|still pending|remaining work/i.test(s));
        if(marker||row.status==='interrupted'||row.status==='failed'){
          const reason=marker?'会话中提到待跟进':row.status==='interrupted'?'上次执行中断':'上次执行失败';
          upsert.run(id,row.machine,row.id,(row.title+' · '+(marker?.trim().slice(0,120)||reason)).slice(0,300),row.updatedAt,reason);
        }else if(latest?.role==='assistant'&&row.status==='completed'){
          resolve.run(id,row.updatedAt);
        }
      }
    });
  }
  openItems(){
    return this.commitments().concat(this.db.prepare("SELECT id,text,status,machine,sessionId,sourceTime,reason FROM observed WHERE status='observed' ORDER BY sourceTime DESC LIMIT 30").all());
  }
  savePlan(turn,plan){this.db.prepare("UPDATE turns SET plan=?,state='planned',attempts=0,nextTry=0 WHERE id=?").run(JSON.stringify(plan),turn.id);}
  defer(turn){this.db.prepare('UPDATE turns SET attempts=attempts+1,nextTry=? WHERE id=?').run(Date.now()+Math.min(45000,3000*(turn.attempts+1)),turn.id);}
  reply(id,turnId,answer,notify=false){
    this.message(id,'assistant',answer,turnId,notify);
    this.continuity.phoneReply(turnId,id,answer);
  }
  finish(turn,answer,notify=false){
    this.reply('reply-'+turn.id,turn.id,answer,notify);
    this.db.prepare("UPDATE turns SET state='done',plan=NULL WHERE id=?").run(turn.id);
  }
  remember(turn,a){
    const keyWasForgotten=this.db.prepare('SELECT 1 FROM forgotten_keys WHERE key=? AND scope=?').get(a.key,a.scope);
    const valueWasForgotten=this.db.prepare('SELECT 1 FROM forgotten WHERE hash=?').get(fingerprint(a.scope+'|'+a.text));
    if((keyWasForgotten||valueWasForgotten) && !/重新记住|再次记住|重新设置|以后请记住|remember again|remember anew/i.test(turn.text))return false;
    this.db.prepare('DELETE FROM forgotten_keys WHERE key=? AND scope=?').run(a.key,a.scope);
    this.db.prepare('INSERT OR REPLACE INTO pref_provenance VALUES(?,?,?,?)').run(a.key,a.scope,turn.id,a.text);
    this.db.prepare(`INSERT INTO prefs(id,key,text,scope,source,updatedAt) VALUES(?,?,?,?,?,?)
      ON CONFLICT(key,scope) DO UPDATE SET text=excluded.text,source=excluded.source,updatedAt=excluded.updatedAt`).run(randomUUID(),a.key,a.text,a.scope,turn.id,iso());
    this.continuity.redactMemory();
    return true;
  }
  markMemoryUsed(turn,pref){
    this.db.prepare('INSERT OR IGNORE INTO pref_provenance VALUES(?,?,?,NULL)').run(pref.key,pref.scope,turn.id);
  }
  forget(turn,id){
    const p=this.db.prepare('SELECT * FROM prefs WHERE id=?').get(id);if(!p)return false;
    this.db.prepare('INSERT OR REPLACE INTO forgotten VALUES(?,?)').run(fingerprint(p.scope+'|'+p.text),iso());
    this.db.prepare('DELETE FROM prefs WHERE id=?').run(id);
    const sources=this.db.prepare('SELECT turnId,versionText FROM pref_provenance WHERE key=? AND scope=?').all(p.key,p.scope);
    sources.push({turnId:p.source,versionText:p.text},{turnId:turn.id,versionText:null});
    const hide=this.db.prepare('INSERT OR IGNORE INTO memory_exclusions VALUES(?)');
    for(const s of sources){
      hide.run(s.turnId);hide.run('reply-'+s.turnId);
      if(s.versionText){
        this.db.prepare('INSERT OR REPLACE INTO forgotten VALUES(?,?)').run(fingerprint(p.scope+'|'+s.versionText),iso());
        this.db.prepare('INSERT OR IGNORE INTO memory_exclusions SELECT id FROM messages WHERE instr(text,?)>0').run(s.versionText);
      }
    }
    this.db.prepare('DELETE FROM pref_provenance WHERE key=? AND scope=?').run(p.key,p.scope);
    this.db.prepare('INSERT OR REPLACE INTO forgotten_keys VALUES(?,?,?)').run(p.key,p.scope,turn.id);
    this.continuity.redactMemory();
    return true;
  }
  link(turn,row){this.db.prepare('INSERT OR REPLACE INTO contextlinks VALUES(?,?,?,?)').run(row.machine+':'+row.id,row.machine,row.id,turn.id);}
  lastLinks(){return this.db.prepare("SELECT machine,sessionId AS id FROM contextlinks WHERE turnId NOT IN (SELECT id FROM diagnostics WHERE kind='turn') ORDER BY rowid DESC LIMIT 3").all();}
  addCommitment(id,text,due,days,source){
    this.db.prepare('INSERT OR IGNORE INTO commitments(id,text,dueAt,intervalDays,source,createdAt) VALUES(?,?,?,?,?,?)').run(id,text,due,days,source,iso());
  }
  closeCommitment(id){
    if(id.startsWith('context:'))return this.db.prepare("UPDATE observed SET status='dismissed' WHERE id=? AND status='observed'").run(id).changes>0;
    return this.db.prepare("UPDATE commitments SET status='closed' WHERE id=? AND status='open'").run(id).changes>0;
  }
  effect(turnId,position){return this.db.prepare('SELECT result FROM action_receipts WHERE turnId=? AND position=?').get(turnId,position);}
  ackEffect(turnId,position,result){this.db.prepare('INSERT OR IGNORE INTO action_receipts VALUES(?,?,?)').run(turnId,position,result);}
  track(id,turn,notify){this.db.prepare('INSERT OR IGNORE INTO assignments(id,turnId,notify) VALUES(?,?,?)').run(id,turn.id,notify?1:0);}
  watch(id,row,text,source){
    this.db.prepare('INSERT OR IGNORE INTO watches(id,machine,sessionId,watermark,text,source) VALUES(?,?,?,?,?,?)').run(id,row.machine,row.id,row.updatedAt,text,source);
  }
  watchers(){return this.db.prepare('SELECT * FROM watches WHERE active=1').all();}
  updateWatch(w,row){
    if(!row||Date.parse(row.updatedAt)<=Date.parse(w.watermark))return;
    this.transact(()=>{
      this.message('watch-'+w.id,'assistant',w.text+'\n'+row.machine+' · '+row.title+' 出现了新的会话活动。'+(row.summary?'\n'+row.summary.slice(0,420):''),w.source,true);
      this.db.prepare('UPDATE watches SET active=0 WHERE id=?').run(w.id);
    });
  }
  waiting(){return this.db.prepare('SELECT * FROM assignments WHERE reported=0').all();}
  report(task,assignment){
    return this.transact(()=>{
      const text=task.state==='succeeded'?(task.result||'任务已完成。'):'执行'+({failed:'失败',interrupted:'已中断',cancelled:'已取消'}[task.state]||task.state)+'。'+(task.result||'');
      this.message('result-'+task.id,'assistant',text.slice(0,16000),assignment.turnId,!!assignment.notify||['failed','interrupted'].includes(task.state));
      this.db.prepare('UPDATE assignments SET reported=1 WHERE id=?').run(task.id);
    });
  }
  wake(now=new Date()) {
    this.transact(()=>{
      const due=this.db.prepare("SELECT * FROM commitments WHERE status='open' AND dueAt IS NOT NULL AND dueAt<=?").all(now.toISOString());
      for(const row of due){
        const id='reminder-'+row.id+'-'+row.dueAt;
        this.message(id,'assistant','提醒你：'+row.text,row.source,true);
        if(row.intervalDays){
          const interval=row.intervalDays*86400000,start=Date.parse(row.dueAt);
          const next=new Date(start+(Math.floor((now-start)/interval)+1)*interval);
          this.db.prepare('UPDATE commitments SET dueAt=? WHERE id=?').run(next.toISOString(),row.id);
        }else this.db.prepare("UPDATE commitments SET dueAt=NULL WHERE id=?").run(row.id);
      }
    });
  }
}
