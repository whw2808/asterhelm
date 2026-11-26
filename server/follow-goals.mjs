import {createHash} from 'node:crypto';
import {goalProjection} from './agent-evidence.mjs';

const actions={
  preview:['enable','pause','stop'],enabled:['preview','pause','stop'],paused:['preview','enable','stop'],stopped:[]
};
const labels={enable:'开启提醒',preview:'仅预览',pause:'暂停跟进',stop:'停止跟进'};
const nextStatus={enable:'enabled',preview:'preview',pause:'paused',stop:'stopped'};
const details={
  preview:'正在预览。下列示例显示哪些变化会提醒你，确认开启后才会发出提醒。',
  enabled:'已开启提醒。之后出现符合这项目标提醒条件的新进展时，我会通知你。',
  paused:'跟进已暂停。再次开启后，从那一刻的新进展开始提醒。',
  stopped:'已停止跟进。'
};
const reasons={result:'出现新的结果',decision:'有新的决定或需要确认',blocker:'遇到阻碍',progress:'出现普通进展'};
const noticeTime=new Intl.DateTimeFormat('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',
  hour:'2-digit',minute:'2-digit',hour12:false,timeZoneName:'shortOffset'});
const defaultSignals=['result','decision','blocker'];
const activeSelection="status IN ('preview','enabled') AND (untilAt IS NULL OR untilAt>?)";
const maxScanAge=120000;
const findingFields=['key','deviceId','deviceName','target','agentName','sourceKind','sourceLabel','sourceId','sessionTitle',
  'turnId','itemId','at','summary','stage','stageLabel','certainty','freshness','importance'];

function requireThat(condition,message){if(!condition)throw Error(message);}
function inTransaction(store,fn){return store.db.isTransaction?fn():store.transact(fn);}
function signedUser(store,turn){
  const user=store.db.prepare("SELECT m.text,m.createdAt,t.state FROM turns t JOIN messages m ON m.id=t.id AND m.role='user' WHERE t.id=?").get(turn?.id??null);
  requireThat(user&&(turn.text==null||turn.text===user.text),'目标操作需要来自当前手机聊天的用户消息。');
  return user;
}
function textList(items){
  requireThat(Array.isArray(items)&&items.length<=32,'目标线索数量无效。');
  requireThat(items.every(item=>typeof item==='string'&&item.trim()&&item.length<=320),'请提供有效的目标线索。');
  return [...new Set(items.map(item=>item.trim()))];
}
function sourceScope(scope){
  requireThat(typeof scope?.machine==='string'&&scope.machine.trim()&&typeof scope.id==='string'&&scope.id.trim()&&
    (scope.target==null||typeof scope.target==='string'&&scope.target.trim()),'所选目标来源无效。');
  return {machine:scope.machine,id:scope.id,...(scope.target?{target:scope.target}:{})};
}
function goalSpec(input,now){
  requireThat(typeof input?.title==='string'&&input.title.trim()&&input.title.length<=1000,'请说明要跟进的目标。');
  const title=input.title.trim(),terms=textList(input.terms??[title]),signals=textList(input.signals??[]);
  requireThat(input.scopes==null||Array.isArray(input.scopes),'所选目标来源无效。');
  const scopes=(input.scopes??[]).map(sourceScope);
  requireThat(terms.length||scopes.length,'请指定要跟进的主题或来源。');
  let until=null;
  if(input.until!=null){
    requireThat(typeof input.until==='string'&&/(?:Z|[+-]\d\d:\d\d)$/iu.test(input.until)&&
      Date.parse(input.until)>now,'需要有效且未过期的目标截止时间。');
    until=new Date(input.until).toISOString();
  }
  return {title,terms,signals,until,scopes,...(input.origin?{origin:sourceScope(input.origin)}:{})};
}
function signalMatches(signal,summary){
  const term=signal.toLowerCase(),text=summary.toLowerCase();
  if(!/^[a-z0-9 ]+$/u.test(term))return text.includes(term);
  return new RegExp('(?:^|[^a-z0-9])'+term+'(?:$|[^a-z0-9])','u').test(text);
}
function displayFinding(fact,goal,current){
  const signals=goal.signals.length?goal.signals:defaultSignals;
  const ownerDecision=goal.signals.includes('decision')&&fact.importance==='decision';
  const category=signals.includes(fact.importance)&&(!ownerDecision||fact.stage==='decision-needed'&&fact.certainty==='reported');
  const signal=signals.find(signal=>!Object.hasOwn(reasons,signal)&&signalMatches(signal,fact.summary));
  const recent=current&&fact.freshness==='recent';
  const wouldNotify=Boolean(recent&&(category||signal));
  const notifyReason=!current?'近期索引未确认这条依据':!recent?'依据的时效不足':
    signal?'符合关注信号「'+signal+'」':category?(ownerDecision?'需要你决定':reasons[fact.importance]):'不在所选提醒范围内';
  const notificationText=wouldNotify?'目标「'+goal.title+'」 · '+(fact.deviceName||fact.deviceId)+' / '+
    (fact.agentName||fact.target)+'\n'+fact.sourceLabel+' · '+noticeTime.format(new Date(fact.at))+'\n'+fact.summary:'';
  return {...fact,...(!current?{freshness:'unknown'}:{}),wouldNotify,notifyReason,notificationText};
}

export class FollowGoals{
  constructor(store){
    this.store=store;this.db=store.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS follow_goals(
      id TEXT PRIMARY KEY,messageId TEXT UNIQUE NOT NULL,spec TEXT NOT NULL,status TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,enabledAt INTEGER,untilAt INTEGER,observedAt INTEGER,scan INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS follow_goal_status ON follow_goals(status,untilAt);
      CREATE TABLE IF NOT EXISTS follow_goal_findings(
        goalId TEXT NOT NULL,factKey TEXT NOT NULL,deviceId TEXT NOT NULL,target TEXT NOT NULL,at INTEGER NOT NULL,
        scan INTEGER NOT NULL,fact TEXT NOT NULL,PRIMARY KEY(goalId,factKey));
      CREATE INDEX IF NOT EXISTS follow_goal_agents ON follow_goal_findings(goalId,deviceId,target,at DESC);
      CREATE TABLE IF NOT EXISTS follow_goal_decisions(turnId TEXT PRIMARY KEY,goalId TEXT NOT NULL,version INTEGER NOT NULL,decision TEXT NOT NULL);`);
  }
  register(turn,input){
    return inTransaction(this.store,()=>{
      const user=signedUser(this.store,turn),id='goal-'+turn.id,existing=this.get(id);
      if(existing)return existing;
      requireThat(user.state==='new','请在当前的手机消息中说明要跟进的目标。');
      const spec=goalSpec(input,Date.parse(user.createdAt));
      const open=this.db.prepare('SELECT * FROM follow_goals WHERE '+activeSelection).all(Date.now());
      for(const row of open){
        const prior=JSON.parse(row.spec);
        if(prior.title.normalize('NFKC').toLowerCase()!==spec.title.normalize('NFKC').toLowerCase()||
          JSON.stringify(prior.scopes)!==JSON.stringify(spec.scopes)||(spec.until&&spec.until!==prior.until)||
          (spec.signals.length&&JSON.stringify([...spec.signals].sort())!==JSON.stringify([...prior.signals].sort())))continue;
        if(row.status==='preview'){
          prior.terms=[...new Set([...prior.terms,...spec.terms])].slice(0,32);
          this.db.prepare('UPDATE follow_goals SET spec=? WHERE id=?').run(JSON.stringify(prior),row.id);
        }
        return this.get(row.id);
      }
      this.db.prepare("INSERT INTO follow_goals(id,messageId,spec,status,untilAt) VALUES(?,?,?,'preview',?)")
        .run(id,turn.id,JSON.stringify(spec),spec.until?Date.parse(spec.until):null);
      return this.get(id);
    });
  }
  expire(now){
    this.db.prepare("UPDATE follow_goals SET status='stopped',enabledAt=NULL,version=version+1 WHERE status!='stopped' AND untilAt<=?").run(now);
  }
  hasActive(){
    return Boolean(this.db.prepare('SELECT 1 FROM follow_goals WHERE '+activeSelection+' LIMIT 1').get(Date.now()));
  }
  activeSpecs(){
    return this.db.prepare('SELECT spec FROM follow_goals WHERE '+activeSelection+' ORDER BY rowid').all(Date.now())
      .map(row=>{const {title,scopes}=JSON.parse(row.spec);return {title,scopes};});
  }
  get(id){
    this.expire(Date.now());
    const row=this.db.prepare('SELECT * FROM follow_goals WHERE id=?').get(id);
    return row?this.card(row):null;
  }
  cards(messageIds){
    this.expire(Date.now());
    const rows=messageIds==null?this.db.prepare('SELECT * FROM follow_goals ORDER BY rowid DESC').all():
      this.db.prepare('SELECT * FROM follow_goals WHERE messageId IN (SELECT value FROM json_each(?)) ORDER BY rowid DESC')
        .all(JSON.stringify([...messageIds]));
    return rows.map(row=>this.card(row));
  }
  card(row){
    const goal=JSON.parse(row.spec);
    // Keep a busy device from displacing the latest phase and citations of other agents.
    const records=this.db.prepare(`SELECT fact,scan,at FROM (
      SELECT fact,scan,at,factKey,row_number() OVER (PARTITION BY deviceId,target ORDER BY at DESC,factKey) AS rank
      FROM follow_goal_findings WHERE goalId=? AND scan>=0
    ) WHERE rank<=4 ORDER BY rank,at DESC,factKey`).all(row.id);
    const scanRecent=Date.now()-row.observedAt<=maxScanAge;
    const findings=records.map(record=>displayFinding(JSON.parse(record.fact),goal,scanRecent&&record.scan===row.scan));
    let detail=details[row.status];
    if(['preview','enabled'].includes(row.status)){
      if(!findings.length)detail+=' 尚未找到与目标匹配的依据。';
      else if(!scanRecent||records.every(record=>record.scan!==row.scan))detail+=' 近期索引未确认这些依据，保留上次的来源和时间。';
    }
    return {kind:'goal',id:row.id,version:row.version,messageId:row.messageId,title:goal.title,status:row.status,
      detail,until:goal.until,signals:goal.signals,findings,actions:actions[row.status].map(decision=>({decision,label:labels[decision]}))};
  }
  decide(turn,{id,version,decision}){
    return inTransaction(this.store,()=>{
      const user=signedUser(this.store,turn),current=this.get(id);
      requireThat(current,'找不到这项目标。');
      const receipt=this.db.prepare('SELECT * FROM follow_goal_decisions WHERE turnId=?').get(turn.id);
      if(receipt){
        requireThat(receipt.goalId===id&&receipt.version===version&&receipt.decision===decision,'这条消息已用于其他决定。');
        return current;
      }
      requireThat(user.state==='new'&&current.messageId!==turn.id,'请用当前的手机消息操作目标卡片。');
      requireThat(current.version===version&&actions[current.status].includes(decision),'目标状态已变化，请查看最新卡片。');
      this.db.prepare('UPDATE follow_goals SET status=?,version=version+1,enabledAt=? WHERE id=?')
        .run(nextStatus[decision],decision==='enable'?Date.parse(user.createdAt):null,id);
      this.db.prepare('INSERT INTO follow_goal_decisions VALUES(?,?,?,?)').run(turn.id,id,version,decision);
      return this.get(id);
    });
  }
  observe({rows=[],workers=[],tasks=[],coverage=[],now=Date.now()}={}){
    now=new Date(now).getTime();
    if(!Number.isFinite(now))return;
    return inTransaction(this.store,()=>{
      this.expire(now);
      const active=this.db.prepare("SELECT * FROM follow_goals WHERE status IN ('preview','enabled') AND (observedAt IS NULL OR observedAt<=?)").all(now);
      // A remembered sibling still identifies a different topic when its own follow-up is paused.
      const otherGoals=active.length?this.db.prepare('SELECT spec FROM follow_goals').all().map(r=>JSON.parse(r.spec)):[];
      for(const row of active){
        const goal=JSON.parse(row.spec),scan=row.scan+1;
        const {findings,retracted}=goalProjection({goal,otherGoals,rows,workers,tasks,coverage,now});
        // Retain the original fact key so that reclassification never replays an old alert.
        if(retracted.length)this.db.prepare('UPDATE follow_goal_findings SET scan=-1 WHERE goalId=? AND factKey IN (SELECT value FROM json_each(?))')
          .run(row.id,JSON.stringify(retracted));
        const alerts=[];
        for(const finding of findings){
          // Persist only the evidence DTO. Poll times, raw messages and inputs are not fact identity.
          const fact=Object.fromEntries(findingFields.filter(key=>typeof finding[key]==='string').map(key=>[key,finding[key]]));
          const time=Date.parse(fact.at);
          if(!fact.key||!fact.deviceId||!fact.target||!fact.summary||!Number.isFinite(time)||time>now||
            !['dialogue','task-receipt'].includes(fact.sourceKind)||!['reported','observed'].includes(fact.certainty))continue;
          const body=JSON.stringify(fact);
          const added=this.db.prepare(`INSERT OR IGNORE INTO follow_goal_findings(goalId,factKey,deviceId,target,at,scan,fact)
            VALUES(?,?,?,?,?,?,?)`).run(row.id,fact.key,fact.deviceId,fact.target,time,scan,body).changes;
          if(!added){
            this.db.prepare('UPDATE follow_goal_findings SET scan=?,fact=? WHERE goalId=? AND factKey=?')
              .run(scan,body,row.id,fact.key);
          }else if(row.status==='enabled'&&time>row.enabledAt){
            const item=displayFinding(fact,goal,true);
            if(item.wouldNotify)alerts.push(item);
          }
        }
        this.db.prepare('UPDATE follow_goals SET observedAt=?,scan=? WHERE id=?').run(now,scan,row.id);
        if(alerts.length){
          alerts.sort((a,b)=>b.at.localeCompare(a.at)||a.key.localeCompare(b.key));
          const digest=createHash('sha256').update(JSON.stringify([row.id,alerts.map(item=>item.key)])).digest('hex');
          let message=alerts.slice(0,3).map(item=>item.notificationText).join('\n\n');
          if(alerts.length>3)message+='\n还有 '+(alerts.length-3)+' 条进展，请查看目标卡片。';
          this.store.message('goal-notice-'+digest,'assistant',message,row.messageId,true);
        }
      }
    });
  }
}
