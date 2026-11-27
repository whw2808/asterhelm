import {createHash} from 'node:crypto';
import {actor} from './router-policy.mjs';

const activeStates=new Set(['queued','running','offline']);
const limitSeconds=value=>Math.max(30,Math.min(86400,Math.round(Number(value)||300)));
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fingerprint=(order,steps)=>JSON.stringify([order.revision,steps.map(s=>[s.id,s.state,s.scope])]);

export function checkedWorkControl(control,currentUser){
  if(control==null)return undefined;
  const evidence=typeof control.evidence==='string'?control.evidence.trim():'';
  if(!evidence||!currentUser.includes(evidence))throw Error('持续工作控制缺少本轮用户原话');
  if(control.mode==='pause')return {mode:'pause',evidence};
  const stopCondition=typeof control.stopCondition==='string'?control.stopCondition.trim():'';
  if(control.mode!=='until'||!stopCondition||stopCondition.length>480)throw Error('持续工作需要有效的停止条件');
  return {mode:'until',evidence,stopCondition};
}

export class WorkWake {
  constructor(store){
    this.store=store;
    store.db.exec(`CREATE TABLE IF NOT EXISTS work_wakes(parent TEXT PRIMARY KEY, signature TEXT NOT NULL,
      due INTEGER NOT NULL, reason TEXT NOT NULL, delaySeconds INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS work_wake_receipts(parent TEXT, revision INTEGER, step TEXT, PRIMARY KEY(parent,revision,step));
      CREATE TABLE IF NOT EXISTS ongoing_work(parent TEXT PRIMARY KEY,origin TEXT NOT NULL,instruction TEXT NOT NULL,stopCondition TEXT NOT NULL,
        timeZone TEXT NOT NULL,scopeRevision INTEGER NOT NULL,desktopSince INTEGER NOT NULL,lastFacts TEXT,lastRound INTEGER,lastAt INTEGER,delaySeconds INTEGER NOT NULL DEFAULT 0);`);
  }
  registerGoal(turn,parent,proposedControl){
    const {db,work,continuity}=this.store;
    const source=db.prepare("SELECT seq,text FROM messages WHERE id=? AND role='user'").get(turn.id);
    const order=work.order(parent);
    if(!source||!order||!['working','synthesizing','paused'].includes(order.state))return;
    const prior=this.goal(parent);
    const control=checkedWorkControl(proposedControl,source.text);
    const startsGoal=control?.mode==='until'&&prior?.origin!==turn.id;
    if(!startsGoal&&(!prior||order.revision===prior.scopeRevision))return;
    const revision=db.prepare(`SELECT r.turnId,m.seq FROM work_revisions r JOIN messages m ON m.id=r.turnId
      WHERE r.parent=? AND r.revision=?`).get(parent,order.revision);
    const revisedHere=revision?.turnId===turn.id;
    if((revision&&source.seq<revision.seq)||(!revisedHere&&parent!==turn.id&&continuity.workForTurn(turn.id)!==parent))return;
    const previousOrigin=prior&&db.prepare('SELECT seq FROM messages WHERE id=?').get(prior.origin);
    if(previousOrigin&&source.seq<previousOrigin.seq)return;
    const updated=revisedHere&&prior&&order.revision!==prior.scopeRevision;
    if(!updated&&!startsGoal)return;
    const criteria=JSON.parse(order.criteria);
    const desktopSince=db.prepare('SELECT coalesce(max(seq),0) last FROM continuity_events WHERE workId=?').get(parent).last;
    // Evidence from before an accepted revision cannot establish the revised criteria.
    if(updated){
      db.prepare('UPDATE ongoing_work SET stopCondition=?,scopeRevision=?,desktopSince=?,lastFacts=NULL,lastRound=NULL,delaySeconds=0 WHERE parent=?')
        .run(criteria.join('；'),order.revision,desktopSince,parent);
      if(control?.mode==='pause')work.setState(parent,'paused');
    }
    if(!startsGoal)return;
    const stop=control.stopCondition;
    if(!criteria.includes(stop))db.prepare('UPDATE work_orders SET criteria=? WHERE id=?').run(JSON.stringify([...criteria,stop]),parent);
    db.prepare(`INSERT INTO ongoing_work(parent,origin,instruction,stopCondition,timeZone,scopeRevision,desktopSince) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(parent) DO UPDATE SET origin=excluded.origin,instruction=excluded.instruction,stopCondition=excluded.stopCondition,
      scopeRevision=excluded.scopeRevision,desktopSince=excluded.desktopSince,lastFacts=NULL,lastRound=NULL,delaySeconds=0`)
      .run(parent,turn.id,source.text,stop,Intl.DateTimeFormat().resolvedOptions().timeZone,order.revision,desktopSince);
    continuity.recordPhoneTurn(parent,db.prepare('SELECT text FROM messages WHERE id=?').get(parent).text,parent);
    continuity.recordPhoneTurn(turn.id,source.text,parent);
  }
  goal(parent){return this.store.db.prepare('SELECT * FROM ongoing_work WHERE parent=?').get(parent);}
  desktopResults(parent,steps){
    const excluded=new Set(steps.filter(s=>s.scope==='paused').map(s=>s.target));
    return this.store.db.prepare(`SELECT e.seq,e.text,p.machine,p.target FROM continuity_events e JOIN continuity_participants p ON p.participant=e.origin
      WHERE e.workId=? AND e.text<>'' AND e.seq>(SELECT desktopSince FROM ongoing_work WHERE parent=e.workId) ORDER BY e.seq DESC LIMIT 24`).all(parent).filter(e=>!excluded.has(e.target)).reverse().map(e=>({
        id:'desktop:'+e.seq,device:e.machine,agent:e.target,state:'succeeded',title:'关联会话的最新证据',result:e.text}));
  }
  facts(order,steps,desktops){
    const material=steps.filter(s=>s.scope==='active').map(s=>JSON.stringify([s.target,s.state,s.result]));
    return hash([order.revision,[...new Set(material)].sort(),desktops.map(s=>s.id)]);
  }
  beforeAssessment(turn,stamp){
    const goal=this.goal(turn.id);
    if(goal.lastFacts===stamp&&goal.lastRound!==turn.round){
      this.waitForEvidence(turn,stamp,'回执未提供新的依据，到时再次核对。');return false;
    }
    this.store.db.prepare(`UPDATE ongoing_work SET delaySeconds=CASE WHEN lastFacts=? THEN delaySeconds ELSE 0 END,
      lastFacts=?,lastRound=?,lastAt=? WHERE parent=?`).run(stamp,stamp,turn.round,Date.now(),turn.id);return true;
  }
  waitForEvidence(turn,stamp,reason,coverage=[],waitForUser=false){
    const {db,work}=this.store,now=Date.now(),goal=this.goal(turn.id);
    const delay=Math.min(86400,Math.max(60,2*goal.delaySeconds));
    this.schedule(turn.id,'goal:'+stamp,now,delay,reason);
    db.prepare('UPDATE ongoing_work SET lastFacts=?,lastRound=?,lastAt=?,delaySeconds=? WHERE parent=?')
      .run(stamp,turn.round,now,delay,turn.id);
    db.prepare('UPDATE work_orders SET retryAt=?,assessment=?,failures=0 WHERE id=?')
      .run(waitForUser?0:now+delay*1000,JSON.stringify(coverage),turn.id);
    work.setState(turn.id,waitForUser?'paused':'working');
    if(waitForUser||coverage.length){
      const key=hash([turn.id,turn.revision,waitForUser,coverage.map(c=>c.item)]);
      this.store.reply('goal-wait-'+key,turn.id,reason,true);
    }
  }
  card(id){
    const row=this.store.db.prepare(`SELECT p.due,p.reason FROM work_wakes p JOIN work_orders w ON w.id=p.parent
      WHERE p.parent=? AND w.state='working'`).get(id);
    const goal=this.goal(id);
    if(!row&&!goal)return null;
    return {...(row?{nextWakeAt:new Date(row.due).toISOString(),wakeReason:row.reason}:{}),
      ...(goal?{stopCondition:goal.stopCondition,goalSource:goal.origin,timeZone:goal.timeZone,lastCheckedAt:goal.lastAt?new Date(goal.lastAt).toISOString():null}:{})};
  }
  schedule(id,signature,now,seconds,reason){
    this.store.db.prepare(`INSERT INTO work_wakes VALUES(?,?,?,?,?) ON CONFLICT(parent) DO UPDATE SET
      signature=excluded.signature,due=excluded.due,reason=excluded.reason,delaySeconds=excluded.delaySeconds`)
      .run(id,signature,now+1000*seconds,reason,seconds);
  }
  async advance({planner,broker,now=Date.now()}){
    if(this.busy||!planner?.plan||planner.offline)return;
    this.busy=true;
    try{
      const {db,work}=this.store;
      const orders=db.prepare(`SELECT w.* FROM work_orders w JOIN turns t ON t.id=w.id
        LEFT JOIN work_wakes p ON p.parent=w.id WHERE w.state='working' AND w.decision IS NULL AND t.state='done'
        AND NOT EXISTS (SELECT 1 FROM diagnostics d WHERE d.kind='turn' AND d.id=w.id)
        ORDER BY coalesce(p.due,0),w.updatedAt`).all();
      for(const order of orders){
        if(this.store.heldForInput(order.id))continue;
        const steps=work.evidence(order.id).filter(s=>s.scope==='active');
        const busy=steps.filter(s=>activeStates.has(s.state));
        if(!busy.length){
          const goal=this.goal(order.id);
          if(goal&&order.retryAt>now){
            const all=work.evidence(order.id),stamp=this.facts(order,all,this.desktopResults(order.id,all));
            if(goal.lastFacts!==stamp)db.prepare('UPDATE work_orders SET retryAt=0 WHERE id=? AND revision=?').run(order.id,order.revision);
          }
          continue;
        }
        const stamp=fingerprint(order,steps);
        const old=db.prepare('SELECT * FROM work_wakes WHERE parent=?').get(order.id);
        if(old?.signature==='retry:'+stamp&&now<old.due)continue;
        if(old?.signature===stamp){
          if(now>=old.due)this.schedule(order.id,stamp,now,Math.min(86400,old.delaySeconds*2),'仍在等执行端回执；如有新状态会提前检查');
          continue;
        }
        const workers=await broker('/workers');
        const idle=Array.isArray(workers)?workers.filter(w=>w.online&&!w.needsCredentials&&w.capabilities?.includes('read-only')&&
          !busy.some(s=>s.target===w.target)&&!['working','waiting_for_model_network'].includes(w.status)):[];
        const used=db.prepare('SELECT step FROM work_wake_receipts WHERE parent=? AND revision=?').all(order.id,order.revision);
        const completed=steps.filter(s=>s.state==='succeeded'&&s.result&&s.introducedRevision===order.revision&&
          !s.id.includes(':follow:')&&!used.some(row=>row.step===s.id)&&idle.some(w=>w.target===s.target&&w.deviceId===s.deviceId));
        const current=()=>{
          const fresh=work.order(order.id);
          return fresh?.state==='working'&&!fresh.decision&&fresh.round===order.round&&!this.store.heldForInput(order.id)&&
            stamp===fingerprint(fresh,work.evidence(order.id).filter(s=>s.scope==='active'));
        };
        // Reserve the model call before yielding. A crash can delay a check, never duplicate a task.
        if(!current())continue;
        this.schedule(order.id,stamp,now,120,'等待执行进度，已安排复查');
        let proposed;
        try{
          proposed=await planner.plan({phase:'workWake',goal:order.goal,criteria:JSON.parse(order.criteria),amendment:order.amendment,
            now:new Date(now).toISOString(),pending:busy.map(s=>({title:s.title,target:s.target,state:s.state})),
            completed:completed.map(s=>({stepId:s.id,target:s.target,title:s.title,result:s.result.slice(0,1500)}))});
        }catch{
          if(current())this.schedule(order.id,'retry:'+stamp,now,120,'暂未取得判断，稍后重试');
          return;
        }
        if(!current())return;
        const next=limitSeconds(proposed.nextCheckSeconds);
        const reason=String(proposed.reply||'等待执行端回执').slice(0,220);
        this.store.transact(()=>{
          if(!current())return;
          this.schedule(order.id,stamp,now,next,reason);
          const a=proposed.actions?.length===1?proposed.actions[0]:null;
          if(a?.type!=='consult'||(order.round>=2&&!this.goal(order.id))||!a.prompt?.trim()||a.write) return;
          const source=completed.find(s=>s.id===a.stepId&&s.target===a.target);
          if(!source)return;
          const target=idle.find(w=>w.target===source.target&&w.deviceId===source.deviceId);
          const title=String(a.title||'补充查证').slice(0,90);
          const action={target:source.target,title,prompt:'按本次原分工补充只读查证：'+String(a.prompt).slice(0,3000),mode:'read-only',notify:true};
          db.prepare('INSERT INTO work_wake_receipts VALUES(?,?,?)').run(order.id,order.revision,source.id);
          work.saveDecision(order.id,action);
          work.stage(order.id,order.id+':follow:'+(order.round+1),actor(target),'consult',title,true,false,'read-only');
        });
        return;
      }
    }finally{this.busy=false;}
  }
}
