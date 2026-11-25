// A parent belongs to the original chat turn. Child identities survive retries and reconnects.
const stamp=()=>new Date().toISOString();
export const terminalTasks=new Set(['succeeded','failed','cancelled','interrupted']);
const stages={working:'执行中',claimed:'执行端已接单',preparing_workspace:'正在准备工作目录',running_executor:'Agent 正在执行',collecting_result:'正在收集执行结果',sending_result:'正在交回结果'};
const activeParents="('working','synthesizing')";
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
      CREATE INDEX IF NOT EXISTS work_steps_parent ON work_steps(parent);`);
    if(!db.prepare('PRAGMA table_info(work_orders)').all().some(c=>c.name==='assessment'))
      db.exec('ALTER TABLE work_orders ADD COLUMN assessment TEXT');
  }
  order(id){return this.db.prepare('SELECT * FROM work_orders WHERE id=?').get(id);}
  create(turn,criteria){
    this.db.prepare("INSERT OR IGNORE INTO work_orders(id,criteria,state,updatedAt) VALUES(?,?,'working',?)").run(turn.id,JSON.stringify(criteria),stamp());
  }
  stage(parent,key,agent,kind,title,notify=false,dependency=false){
    const result=this.db.prepare(`INSERT OR IGNORE INTO work_steps(id,parent,target,deviceId,deviceName,agentName,kind,title,state,progress,notify)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(key,parent,agent.target,agent.deviceId,agent.deviceName,agent.agentName,kind,title,
      'queued',dependency?'等待前序任务':'正在提交',Number(notify));
    if(result.changes)this.touch(parent);
  }
  touch(parent){this.db.prepare('UPDATE work_orders SET updatedAt=? WHERE id=?').run(stamp(),parent);}
  bind(key,task){
    const step=this.db.prepare('SELECT parent FROM work_steps WHERE id=?').get(key);
    if(!step)return;
    this.db.prepare("UPDATE work_steps SET taskId=?,queuedAt=coalesce(queuedAt,?),progress='等待执行端接单' WHERE id=? AND taskId IS NULL")
      .run(task.id,task.created||stamp(),key);
    this.observe(task);
  }
  stopUnsubmitted(key,state,progress){
    const step=this.db.prepare('UPDATE work_steps SET state=?,progress=?,finishedAt=? WHERE id=? AND taskId IS NULL AND finishedAt IS NULL RETURNING *')
      .get(state,progress,stamp(),key);
    if(step){
      this.continuity.task(step,state==='cancelled'?'已确认停止':'执行中断');
      this.touch(step.parent);
    }
  }
  observe(task,worker){
    const old=this.db.prepare('SELECT * FROM work_steps WHERE taskId=?').get(task.id);
    if(!old || terminalTasks.has(old.state))return false;
    const terminal=terminalTasks.has(task.state);
    const state=task.state==='running'&&worker?.online===false?'offline':task.state;
    const progress=(!terminal&&typeof task.progress==='string'?(stages[task.progress]||task.progress):'') ||
      ({running:'执行中',offline:'连接中断，等待回执',queued:worker?.online===false?'设备离线，等待接单':'等待执行端接单',
        succeeded:'已交回结果',failed:'执行失败',cancelled:'已取消',interrupted:'执行中断'})[state]||'等待回执';
    const started=task.startedAt||old.startedAt||null;
    const heartbeat=task.lastHeartbeatAt||old.lastHeartbeatAt||null;
    const finished=terminal?(task.finishedAt||task.updated||stamp()):null;
    const result=terminal?String(task.result||'').slice(0,100000):'';
    const phase=({succeeded:'已完成',cancelled:'已确认停止',interrupted:'执行中断',failed:'执行失败'})[state]
      ||(task.cancelRequested?'已请求停止，等待执行端确认':null)
      ||({offline:'设备离线，等待回执',queued:'等待执行端接单'})[state]
      ||stages[task.progress]||'执行中';
    this.continuity.task(old,phase,state==='succeeded'?task.result:'');
    if(state===old.state&&progress===old.progress&&started===old.startedAt&&heartbeat===old.lastHeartbeatAt&&!terminal)return true;
    this.db.prepare('UPDATE work_steps SET state=?,progress=?,startedAt=?,lastHeartbeatAt=?,finishedAt=?,result=? WHERE id=?')
      .run(state,state==='offline'?'连接中断，等待回执':progress,started,heartbeat,finished,result,old.id);
    this.touch(old.parent);return true;
  }
  card(id){
    const parent=this.order(id);if(!parent)return null;
    const tasks=this.db.prepare(`SELECT id,taskId,target,deviceId,deviceName,agentName,kind,title,state,progress,
      queuedAt,startedAt,lastHeartbeatAt,finishedAt FROM work_steps WHERE parent=? ORDER BY rowid`).all(id);
    return {id,state:parent.state,updatedAt:parent.updatedAt,tasks};
  }
  ready(){
    return this.db.prepare(`SELECT w.*,m.text,m.seq FROM work_orders w JOIN messages m ON m.id=w.id JOIN turns t ON t.id=w.id
      WHERE w.state IN ${activeParents} AND t.state='done' AND w.retryAt<=?
      AND (w.decision IS NOT NULL OR NOT EXISTS(SELECT 1 FROM work_steps s WHERE s.parent=w.id AND s.state IN ('queued','running','offline')))
      ORDER BY w.updatedAt LIMIT 1`).get(Date.now());
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
