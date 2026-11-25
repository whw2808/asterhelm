// A parent belongs to the original chat turn. Child identities survive retries and reconnects.
const stamp=()=>new Date().toISOString();
export const terminalTasks=new Set(['succeeded','failed','cancelled','interrupted']);
const stages={working:'执行中',claimed:'执行端已接单',preparing_workspace:'正在准备工作目录',running_executor:'Agent 正在执行',collecting_result:'正在收集执行结果',sending_result:'正在交回结果'};
const activeParents="('working','synthesizing')";

function pausedProgress(step){
  switch(step.state){
    case 'queued':return step.taskId?'已暂停，等待队列撤回':'已暂停，等待核实派单';
    case 'running':case 'offline':return step.cancelRequested?'已请求停止，等待执行端确认':'已暂停，等待执行端停止回执';
    case 'succeeded':return '已交回结果，本轮不采用';
    case 'failed':case 'interrupted':return '执行已结束，本轮不采用';
    case 'cancelled':
      if(step.workerState==='cancelled')return '执行端已确认停止';
      if(step.workerState||step.startedAt||step.claimObserved)return '执行回执已收到，本轮不采用';
      if(!step.taskId||step.cancelRequested)return '已撤回，执行端未接单';
      return '任务已取消，本轮不采用';
  }
}

export class WorkJournal {
  constructor(db,continuity){
    this.db=db;this.continuity=continuity;
    db.exec(`CREATE TABLE IF NOT EXISTS work_orders(
      id TEXT PRIMARY KEY, criteria TEXT NOT NULL, state TEXT NOT NULL, updatedAt TEXT NOT NULL,
      round INTEGER DEFAULT 0, failures INTEGER DEFAULT 0, retryAt INTEGER DEFAULT 0, decision TEXT);
      CREATE TABLE IF NOT EXISTS work_steps(
      id TEXT PRIMARY KEY,parent TEXT NOT NULL,taskId TEXT UNIQUE,target TEXT NOT NULL,deviceId TEXT NOT NULL,
      deviceName TEXT NOT NULL,agentName TEXT NOT NULL,kind TEXT NOT NULL,title TEXT NOT NULL,
      state TEXT NOT NULL,progress TEXT NOT NULL,queuedAt TEXT,startedAt TEXT,lastHeartbeatAt TEXT,finishedAt TEXT,
      result TEXT NOT NULL DEFAULT '',notify INTEGER DEFAULT 0);
      CREATE INDEX IF NOT EXISTS work_steps_parent ON work_steps(parent);
      CREATE TABLE IF NOT EXISTS work_revisions(
      turnId TEXT PRIMARY KEY,parent TEXT NOT NULL,revision INTEGER NOT NULL,amendment TEXT NOT NULL,proposal TEXT NOT NULL,
      UNIQUE(parent,revision));`);
    for(const [table,fields] of [
      ['work_orders',['assessment TEXT','revision INTEGER NOT NULL DEFAULT 0','goal TEXT','amendment TEXT']],
      ['work_steps',["scope TEXT NOT NULL DEFAULT 'active'","mode TEXT NOT NULL DEFAULT 'read-only'",'introducedRevision INTEGER NOT NULL DEFAULT 0','cancelRequested INTEGER NOT NULL DEFAULT 0','workerState TEXT','claimObserved INTEGER NOT NULL DEFAULT 0']],
    ]){
      const names=db.prepare('PRAGMA table_info('+table+')').all().map(c=>c.name);
      for(const field of fields)if(!names.includes(field.split(' ')[0]))db.exec('ALTER TABLE '+table+' ADD COLUMN '+field);
    }
    db.exec('UPDATE work_orders SET goal=(SELECT text FROM messages WHERE id=work_orders.id) WHERE goal IS NULL');
  }
  order(id){return this.db.prepare('SELECT * FROM work_orders WHERE id=?').get(id);}
  create(turn,criteria){
    this.db.prepare(`INSERT OR IGNORE INTO work_orders(id,criteria,state,updatedAt,goal)
      VALUES(?,?,'working',?,coalesce(?,(SELECT text FROM messages WHERE id=?)))`).run(turn.id,JSON.stringify(criteria),stamp(),turn.text??null,turn.id);
  }
  revise(parent,turn,{expectedRevision,goal,criteria,pauseStepIds=[]}){
    if(!turn?.id||!turn.text?.trim()||!goal?.trim()||!Array.isArray(criteria)||!criteria.length||
        criteria.some(c=>typeof c!=='string'||!c.trim())||!Array.isArray(pauseStepIds)||pauseStepIds.some(id=>typeof id!=='string'))
      throw Error('工作调整缺少目标、交付要求或步骤编号');
    const proposal=JSON.stringify([expectedRevision,goal,criteria,[...new Set(pauseStepIds)].sort()]);
    this.db.exec('SAVEPOINT revise_work');
    try{
      const applied=this.db.prepare('SELECT * FROM work_revisions WHERE turnId=?').get(turn.id);
      if(applied){
        if(applied.parent!==parent||applied.proposal!==proposal||applied.amendment!==turn.text)throw Error('该消息编号已用于其他工作调整');
        this.db.exec('RELEASE revise_work');
        return applied.revision;
      }
      const current=this.order(parent);
      if(!current||!['working','synthesizing','paused'].includes(current.state)||current.revision!==expectedRevision)
        throw Error('工作范围已变化或工作已结束');
      const steps=this.evidence(parent);
      const paused=new Set(pauseStepIds);
      for(const id of paused)if(!steps.some(s=>s.id===id&&s.scope==='active'))throw Error('步骤不属于当前工作范围');
      // A follow-up still awaiting submission was chosen against the old checklist.
      if(current.decision)paused.add(parent+':follow:'+current.round);
      const mark=this.db.prepare("UPDATE work_steps SET scope='paused',progress=? WHERE parent=? AND id=?");
      for(const step of steps.filter(s=>paused.has(s.id))){
        const progress=pausedProgress(step);
        mark.run(progress,parent,step.id);
        this.continuity.task(step,progress);
      }
      const revision=current.revision+1;
      const state=steps.some(s=>s.scope==='active'&&!paused.has(s.id))?'working':'paused';
      this.db.prepare(`UPDATE work_orders SET revision=?,goal=?,criteria=?,amendment=?,state=?,decision=NULL,
        assessment=NULL,failures=0,retryAt=0,updatedAt=? WHERE id=?`)
        .run(revision,goal,JSON.stringify(criteria),turn.text,state,stamp(),parent);
      this.db.prepare('INSERT INTO work_revisions(turnId,parent,revision,amendment,proposal) VALUES(?,?,?,?,?)')
        .run(turn.id,parent,revision,turn.text,proposal);
      this.db.exec('RELEASE revise_work');
      return revision;
    }catch(e){this.db.exec('ROLLBACK TO revise_work; RELEASE revise_work');throw e;}
  }
  stage(parent,key,agent,kind,title,notify=false,dependency=false,mode='read-only'){
    const result=this.db.prepare(`INSERT OR IGNORE INTO work_steps(
      id,parent,target,deviceId,deviceName,agentName,kind,title,state,progress,notify,mode,introducedRevision)
      SELECT ?,id,?,?,?,?,?,?,'queued',?,?,?,revision FROM work_orders WHERE id=?`)
      .run(key,agent.target,agent.deviceId,agent.deviceName,agent.agentName,kind,title,
        dependency?'等待前序任务':'正在提交',Number(notify),mode,parent);
    if(result.changes)this.db.prepare("UPDATE work_orders SET state=CASE WHEN state='paused' THEN 'working' ELSE state END,updatedAt=? WHERE id=?").run(stamp(),parent);
  }
  touch(parent){this.db.prepare('UPDATE work_orders SET updatedAt=? WHERE id=?').run(stamp(),parent);}
  bind(key,task){
    // A delayed broker reply can identify a real claim after a local unsubmitted stop.
    this.db.prepare("UPDATE work_steps SET taskId=?,queuedAt=coalesce(queuedAt,?),state='queued',finishedAt=NULL WHERE id=? AND taskId IS NULL")
      .run(task.id,task.created||stamp(),key);
    this.observe(task);
  }
  stopUnsubmitted(key,state,progress){
    const step=this.db.prepare('UPDATE work_steps SET state=?,progress=?,finishedAt=? WHERE id=? AND taskId IS NULL AND finishedAt IS NULL RETURNING *')
      .get(state,progress,stamp(),key);
    if(step){
      this.continuity.task(step,progress);
      this.touch(step.parent);
    }
  }
  observe(task,worker){
    const old=this.db.prepare('SELECT * FROM work_steps WHERE taskId=?').get(task.id);
    if(!old||terminalTasks.has(old.state)||(task.state==='queued'&&['running','offline'].includes(old.state)))return false;
    const terminal=terminalTasks.has(task.state);
    const state=task.state==='running'&&worker?.online===false?'offline':task.state;
    const startedAt=task.startedAt||old.startedAt||null;
    const lastHeartbeatAt=[task.lastHeartbeatAt,old.lastHeartbeatAt].filter(Boolean).sort().at(-1)||null;
    const finished=terminal?(task.finishedAt||task.updated||stamp()):null;
    const result=terminal?String(task.result||'').slice(0,100000):'';
    const cancelRequested=Number(Boolean(task.cancelRequested||old.cancelRequested));
    const workerState=task.workerState??null;
    const claimObserved=Number(Boolean(old.claimObserved||startedAt||workerState||state==='running'||state==='offline'||
      old.state==='running'||old.state==='offline'));
    const receipt={...old,state,startedAt,cancelRequested,workerState,claimObserved};
    let progress;
    if(old.scope==='paused')progress=pausedProgress(receipt);
    else if(cancelRequested&&!terminal)progress='已请求停止，等待执行端确认';
    else if(state==='offline')progress='连接中断，等待回执';
    else if(state==='cancelled'&&cancelRequested)progress=pausedProgress(receipt).replace('，本轮不采用','');
    else progress=(!terminal&&typeof task.progress==='string'?(stages[task.progress]||task.progress):'')||
      ({running:'执行中',queued:worker?.online===false?'设备离线，等待接单':'等待执行端接单',
        succeeded:'已交回结果',failed:'执行失败',cancelled:'已取消',interrupted:'执行中断'})[state]||'等待回执';
    let phase=progress;
    if(old.scope==='active'){
      if(state==='succeeded')phase='已完成';
      if(state==='cancelled'&&!cancelRequested)phase='已确认停止';
      if(state==='offline'&&!cancelRequested)phase='设备离线，等待回执';
    }
    this.continuity.task(old,phase,old.scope==='active'&&state==='succeeded'?task.result:'');
    if(state===old.state&&progress===old.progress&&startedAt===old.startedAt&&lastHeartbeatAt===old.lastHeartbeatAt&&
      cancelRequested===old.cancelRequested&&!terminal)return true;
    this.db.prepare(`UPDATE work_steps SET state=?,progress=?,startedAt=?,lastHeartbeatAt=?,finishedAt=?,
      result=?,cancelRequested=?,workerState=?,claimObserved=? WHERE id=?`)
      .run(state,progress,startedAt,lastHeartbeatAt,finished,result,cancelRequested,workerState,claimObserved,old.id);
    this.touch(old.parent);return true;
  }
  card(id){
    const parent=this.order(id);if(!parent)return null;
    const tasks=this.db.prepare(`SELECT id,taskId,target,deviceId,deviceName,agentName,kind,title,state,scope,progress,
      queuedAt,startedAt,lastHeartbeatAt,finishedAt FROM work_steps WHERE parent=? ORDER BY rowid`).all(id);
    return {id,state:parent.state,updatedAt:parent.updatedAt,goal:parent.goal,revision:parent.revision,tasks};
  }
  ready(held=()=>false){
    const rows=this.db.prepare(`SELECT w.*,m.text,m.seq FROM work_orders w JOIN messages m ON m.id=w.id JOIN turns t ON t.id=w.id
      WHERE w.state IN ${activeParents} AND t.state='done' AND w.retryAt<=?
      AND (w.decision IS NOT NULL OR NOT EXISTS(SELECT 1 FROM work_steps s WHERE s.parent=w.id AND s.scope='active' AND s.state IN ('queued','running','offline')))
      ORDER BY w.updatedAt`).iterate(Date.now());
    for(const row of rows)if(!held(row.id))return row;
  }
  evidence(id){return this.db.prepare('SELECT * FROM work_steps WHERE parent=? ORDER BY rowid').all(id);}
  activeCount(){return this.db.prepare(`SELECT count(*) n FROM work_orders w JOIN turns t ON t.id=w.id WHERE w.state IN ${activeParents} AND t.state='done'`).get().n;}
  setState(id,state){this.db.prepare('UPDATE work_orders SET state=?,updatedAt=? WHERE id=?').run(state,stamp(),id);}
  saveDecision(id,actions){
    this.db.prepare("UPDATE work_orders SET state='working',round=round+1,decision=?,failures=0,retryAt=0,updatedAt=? WHERE id=?").run(JSON.stringify(actions),stamp(),id);
  }
  clearDecision(id){this.db.prepare("UPDATE work_orders SET decision=NULL,failures=0,retryAt=0,updatedAt=? WHERE id=?").run(stamp(),id);}
  retry(id,failures){this.db.prepare('UPDATE work_orders SET failures=failures+1,retryAt=? WHERE id=?').run(Date.now()+Math.min(60000,5000*(failures+1)),id);}
}
