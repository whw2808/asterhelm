import {randomUUID} from 'node:crypto';
import {excerpt,idPattern} from './context-format.mjs';

const syncHeader='星舵 · 工作更新';
const toolRecord=/(?:^|\n)\s*(?:\{[^\n]*(?:"(?:aggregated_output|tool_call_id|tool_calls)"\s*:|"(?:command_execution|function_call(?:_output)?|tool_result|item\.(?:started|completed))")|(?:stdout|stderr|tool output)\s*:)/i;
function compact(value,limit){
  if(typeof value!=='string'||toolRecord.test(value))return '';
  // Filter the entire source before shortening. Final lines often carry an
  // artifact path or a next step that would disappear in a prefix-only cut.
  const chars=Array.from(excerpt(value,value.length));
  if(chars.length<=limit)return chars.join('');
  const tail=Math.floor(limit/3);
  return chars.slice(0,limit-tail-3).join('')+' … '+chars.slice(-tail).join('');
}
const latestSteps=`(e.stepId IS NULL OR NOT EXISTS(
  SELECT 1 FROM continuity_events newer WHERE newer.stepId=e.stepId AND newer.seq>e.seq))`;
const terminal="s.state IN ('succeeded','failed','interrupted','cancelled')";
const phoneDecision='e.stepId IS NULL AND e.origin IS NULL AND e.phoneMessage IS NULL';
const phoneAnswer='e.origin IS NULL AND e.phoneMessage IS NOT NULL';
const contextGroups=lastDecision=>[
  [3,phoneDecision],
  [1,phoneAnswer+' AND e.seq<?',lastDecision],
  [1,phoneAnswer+' AND e.seq>?',lastDecision],
  [1,terminal],
  [1,'s.id IS NOT NULL AND NOT ('+terminal+')'],
  [1,'e.origin IS NOT NULL'],
];
const excludedMemory=`(e.turnId IN (SELECT id FROM memory_exclusions) OR e.phoneMessage IN (SELECT id FROM memory_exclusions)
  OR e.turnId IN (SELECT turnId FROM pref_provenance WHERE versionText IS NOT NULL))`;
const isSync=text=>typeof text==='string' && (text.startsWith(syncHeader)||text.startsWith('星舵 · 回执请求')||text.includes('[Asterhelm sync '));

// The first phone turn is the work's stable ID. Each explicitly joined desktop
// owns its own cursor; dispatching to a worker never subscribes its other chats.
export class WorkContinuity {
  constructor(store){
    this.store=store;
    this.db=store.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS continuity_turns(turnId TEXT PRIMARY KEY,workId TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS continuity_turns_work ON continuity_turns(workId);
      CREATE TABLE IF NOT EXISTS continuity_participants(
        participant INTEGER PRIMARY KEY,workId TEXT NOT NULL,machine TEXT NOT NULL,target TEXT NOT NULL,id TEXT NOT NULL,
        boundAt INTEGER NOT NULL,cursor INTEGER NOT NULL DEFAULT 0,UNIQUE(machine,target,id));
      CREATE INDEX IF NOT EXISTS continuity_participants_work ON continuity_participants(workId);
      CREATE TABLE IF NOT EXISTS continuity_events(
        seq INTEGER PRIMARY KEY,workId TEXT NOT NULL,turnId TEXT NOT NULL,eventKey TEXT NOT NULL UNIQUE,
        source TEXT NOT NULL,text TEXT NOT NULL,stepId TEXT,origin INTEGER,desktopTurn TEXT,desktopItem TEXT,phoneMessage TEXT UNIQUE);
      CREATE INDEX IF NOT EXISTS continuity_events_work ON continuity_events(workId,seq);
      CREATE INDEX IF NOT EXISTS continuity_events_turn ON continuity_events(turnId,seq);
      CREATE INDEX IF NOT EXISTS continuity_events_step ON continuity_events(stepId,seq);
      CREATE TABLE IF NOT EXISTS continuity_deliveries(
        deliveryId TEXT PRIMARY KEY,participant INTEGER NOT NULL,through INTEGER NOT NULL,text TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS continuity_outbox ON continuity_deliveries(participant) WHERE text IS NOT NULL;
      CREATE TABLE IF NOT EXISTS continuity_sync_turns(participant INTEGER,desktopTurn TEXT,PRIMARY KEY(participant,desktopTurn));`);
  }
  workForTurn(turnId){
    return this.db.prepare('SELECT workId FROM continuity_turns WHERE turnId=?').get(turnId)?.workId??null;
  }
  participants(workId=null){
    return this.db.prepare('SELECT machine,id,target FROM continuity_participants WHERE ? IS NULL OR workId=? ORDER BY participant').all(workId,workId);
  }
  recentForTurn(turnId){
    const workId=this.workForTurn(turnId);
    if(!workId)return null;
    return {workId,...this.summary(workId,null,24)};
  }
  summary(workId,participant,limit){
    // Reserve space for decisions, assistant proposals, completed/current
    // steps and other desktops. Unused slots go to the newest remaining facts.
    const lastDecision=this.db.prepare(`SELECT max(seq) AS seq FROM continuity_events e WHERE workId=? AND text!='' AND ${phoneDecision}`).get(workId).seq??0;
    const selected=[],other=[];
    for(const [weight,condition,...bounds] of contextGroups(lastDecision)){
      const rows=this.db.prepare(`SELECT e.seq,e.source,e.text FROM continuity_events e
        LEFT JOIN work_steps s ON s.id=e.stepId
        WHERE e.workId=? AND e.text!='' AND (? IS NULL OR e.origin IS NOT ?) AND ${latestSteps} AND ${condition}
        ORDER BY e.seq DESC LIMIT ?`).all(workId,participant,participant,...bounds,limit+1);
      const reserved=weight*limit/8;
      selected.push(...rows.slice(0,reserved));
      other.push(...rows.slice(reserved));
    }
    other.sort((a,b)=>b.seq-a.seq);
    const hasMore=selected.length+other.length>limit;
    selected.push(...other.slice(0,limit-selected.length));
    selected.sort((a,b)=>a.seq-b.seq);
    return {events:selected,hasMore,...(hasMore?{historyAnchor:workId}:{})};
  }
  privateSource(turnId,messageId,text){
    return this.db.prepare(`SELECT 1 FROM memory_exclusions WHERE id IN (?,?)
      UNION ALL SELECT 1 FROM pref_provenance WHERE turnId=? AND versionText IS NOT NULL
      UNION ALL SELECT 1 FROM prefs WHERE instr(?,text)>0 LIMIT 1`).get(turnId,messageId,turnId,text);
  }
  phoneReply(turnId,messageId,answer){
    const workId=this.workForTurn(turnId);
    if(!workId||this.privateSource(turnId,messageId,answer))return;
    const text=compact(answer,360);
    if(!text)return;
    this.db.prepare(`INSERT OR IGNORE INTO continuity_events(workId,turnId,eventKey,source,text,phoneMessage)
      VALUES(?,?,?,'手机助手',?,?)`).run(workId,turnId,JSON.stringify(['reply',messageId]),text,messageId);
  }
  redactMemory(){
    // A batch already handed out but not yet confirmed must be superseded
    // when one of its source turns is excluded from memory.
    this.db.exec(`DELETE FROM continuity_deliveries AS d WHERE d.text IS NOT NULL AND EXISTS(
      SELECT 1 FROM continuity_participants p JOIN continuity_events e ON e.workId=p.workId
      WHERE p.participant=d.participant AND e.seq>p.cursor AND e.seq<=d.through AND e.text!='' AND e.origin IS NOT p.participant AND ${excludedMemory});
      UPDATE continuity_events AS e SET text='' WHERE e.text!='' AND ${excludedMemory};`);
  }
  receive(turnId,text,context,row,requestedWork){
    if(!context){
      if(requestedWork)throw Error('请明确选择要加入这项工作的会话');
      return null;
    }
    if(row&&(row.machine!==context.machine||row.id!==context.id))throw Error('会话来源不一致');
    const target=row?.target??'';
    const linked=this.db.prepare('SELECT workId FROM continuity_participants WHERE machine=? AND target=? AND id=?').get(context.machine,target,context.id);
    if(requestedWork&&(this.workForTurn(requestedWork)!==requestedWork||(linked&&linked.workId!==requestedWork)))throw Error('会话或工作编号不匹配');
    const workId=linked?.workId??requestedWork??turnId;
    if(!linked){
      // A stale index may later catch up with several pre-binding replies.
      // The time fence also works when the selected row contains no evidence.
      let boundAt=Date.now();
      for(const e of row?.evidence||[])boundAt=Math.max(boundAt,Date.parse(e.at)||0);
      this.db.prepare('INSERT INTO continuity_participants(workId,machine,target,id,boundAt) VALUES(?,?,?,?,?)').run(workId,context.machine,target,context.id,boundAt);
    }
    this.recordPhoneTurn(turnId,text,workId);
    return workId;
  }
  recordPhoneTurn(turnId,text,workId){
    if(!workId||this.workForTurn(turnId))return;
    this.db.prepare('INSERT INTO continuity_turns VALUES(?,?)').run(turnId,workId);
    const summary=compact(text,390);
    if(summary)this.db.prepare(`INSERT INTO continuity_events(workId,turnId,eventKey,source,text) VALUES(?,?,?,'手机',?)`)
      .run(workId,turnId,JSON.stringify(['phone',turnId]),summary);
  }
  task(step,phase,answer=''){
    const workId=this.workForTurn(step.parent);
    if(!workId||this.privateSource(step.parent,null,[step.title,answer].join(' ')))return;
    const source=[excerpt(step.deviceName,55),excerpt(step.agentName,55)].filter(Boolean).join(' · ')||'Agent';
    const text=[excerpt(step.title,90),phase,compact(answer,330)].filter(Boolean).join(' · ');
    const last=this.db.prepare('SELECT seq,text FROM continuity_events WHERE stepId=? ORDER BY seq DESC LIMIT 1').get(step.id);
    if(last?.text===text)return;
    this.db.prepare('INSERT INTO continuity_events(workId,turnId,eventKey,source,text,stepId) VALUES(?,?,?,?,?,?)')
      .run(workId,step.parent,JSON.stringify(['step',step.id,last?.seq??0]),source,text,step.id);
  }
  observeDesktop(rows){
    this.store.transact(()=>this.recordDesktop(rows));
  }
  recordDesktop(rows){
    for(const row of rows){
      const p=this.db.prepare('SELECT * FROM continuity_participants WHERE machine=? AND target=? AND id=?').get(row.machine,row.target??'',row.id);
      if(!p||row.archived)continue;
      const evidence=row.evidence??[];
      for(const item of evidence){
        if(item.role==='user'&&item.turnId&&isSync(item.text))this.db.prepare('INSERT OR IGNORE INTO continuity_sync_turns VALUES(?,?)').run(p.participant,item.turnId);
      }
      for(const item of evidence){
        if(item.role!=='assistant'||!item.itemId||!item.turnId||!(Date.parse(item.at)>p.boundAt)||isSync(item.text))continue;
        if(this.db.prepare('SELECT 1 FROM continuity_sync_turns WHERE participant=? AND desktopTurn=?').get(p.participant,item.turnId))continue;
        const text=compact(item.text,460);
        if(!text)continue;
        const key=JSON.stringify(['desktop',p.participant,item.turnId,item.itemId]);
        const phoneMessage='desktop-'+randomUUID();
        const source=['桌面',p.machine,excerpt(row.title,90)].filter(Boolean).join(' · ');
        const saved=this.db.prepare(`INSERT OR IGNORE INTO continuity_events(workId,turnId,eventKey,source,text,origin,desktopTurn,desktopItem,phoneMessage)
          VALUES(?,?,?,?,?,?,?,?,?)`).run(p.workId,p.workId,key,source,text,p.participant,item.turnId,item.itemId,phoneMessage);
        if(saved.changes)this.store.message(phoneMessage,'assistant',source+'\n'+text,p.workId,true);
      }
    }
  }
  catchUp(machine,target,threadId){
    if(typeof target!=='string'||!target)return [];
    const exact=arguments.length>=3;
    if(exact&&(typeof threadId!=='string'||!idPattern.test(threadId)))return [];
    const query='SELECT participant,id,workId FROM continuity_participants WHERE machine=? AND target=?';
    const endpoints=exact?this.db.prepare(query+' AND id=?').all(machine,target,threadId)
      :this.db.prepare(query+' ORDER BY participant').all(machine,target);
    const items=[];
    for(const session of endpoints){
      const {events,...history}=this.summary(session.workId,session.participant,8);
      if(events.length)items.push({threadId:session.id,workId:session.workId,revision:events.at(-1).seq,...history,
        events:events.map(({source,text})=>({source,text}))});
    }
    return items;
  }
  pending(machine,target=null){
    return this.store.transact(()=>{
      const out=[];
      const endpoints=this.db.prepare('SELECT * FROM continuity_participants WHERE machine=? AND (? IS NULL OR target=?) ORDER BY participant').all(machine,target,target);
      for(const p of endpoints){
        let batch=this.db.prepare('SELECT deliveryId,text FROM continuity_deliveries WHERE participant=? AND text IS NOT NULL').get(p.participant);
        if(!batch){
          const events=this.db.prepare(`SELECT seq,source,text FROM continuity_events e WHERE workId=? AND text!='' AND seq>? AND origin IS NOT ?
            AND ${latestSteps} ORDER BY seq LIMIT 6`).all(p.workId,p.cursor,p.participant);
          if(!events.length)continue;
          const deliveryId=randomUUID();
          const lines=events.map(e=>excerpt(e.source,64)+'：'+compact(e.text,170));
          const text=[syncHeader,...lines,'[Asterhelm sync '+deliveryId+']'].join('\n');
          this.db.prepare('INSERT INTO continuity_deliveries(deliveryId,participant,through,text) VALUES(?,?,?,?)').run(deliveryId,p.participant,events.at(-1).seq,text);
          batch={deliveryId,text};
        }
        out.push({threadId:p.id,deliveryId:batch.deliveryId,text:batch.text});
      }
      return out;
    });
  }
  ack(machine,{threadId,deliveryId},target=null){
    if(typeof threadId!=='string'||typeof deliveryId!=='string')return false;
    return this.store.transact(()=>{
      const batch=this.db.prepare(`SELECT d.* FROM continuity_deliveries d JOIN continuity_participants p USING(participant)
        WHERE p.machine=? AND p.id=? AND (? IS NULL OR p.target=?) AND d.deliveryId=?`).get(machine,threadId,target,target,deliveryId);
      if(!batch)return false;
      if(batch.text!==null){
        this.db.prepare('UPDATE continuity_participants SET cursor=? WHERE participant=?').run(batch.through,batch.participant);
        this.db.prepare('UPDATE continuity_deliveries SET text=NULL WHERE deliveryId=?').run(deliveryId);
      }
      return true;
    });
  }
  status(turnId){
    const workId=this.workForTurn(turnId);
    if(!workId)return null;
    const last=this.db.prepare("SELECT max(seq) AS seq FROM continuity_events WHERE turnId=? AND origin IS NULL AND text!=''").get(turnId).seq;
    const pending=last&&this.db.prepare('SELECT 1 FROM continuity_participants WHERE workId=? AND cursor<? LIMIT 1').get(workId,last);
    return {workId,delivery:last?(pending?'pending':'delivered'):'none'};
  }
  provenance(messageId){
    return this.db.prepare(`SELECT p.machine,p.target,p.id AS threadId,e.desktopTurn AS turnId,e.desktopItem AS itemId
      FROM continuity_events e JOIN continuity_participants p ON p.participant=e.origin WHERE e.phoneMessage=?`).get(messageId);
  }
}
