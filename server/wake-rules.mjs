import {createHash} from 'node:crypto';
import {actor,forbidDelegation} from './router-policy.mjs';
import {terminalTasks} from './personal-work.mjs';
import {nextCalendarTime} from './wake-calendar.mjs';

const toISO=ms=>new Date(ms).toISOString();
const clean=s=>typeof s==='string'?s.trim():'';
const digest=s=>createHash('sha256').update(s).digest('hex');
const taskTrigger=s=>s.trigger==='task_failed'||s.trigger==='task_succeeded';
const title={time:'到期提醒',task_failed:'任务失败',task_succeeded:'任务完成',agent_online:'执行端上线',session_changed:'会话有新活动'};
const receiptState={succeeded:'已完成',failed:'失败',cancelled:'已取消',interrupted:'中断',running:'执行中',queued:'已入队'};
const recurrent=/每(?:次|当|逢|个|天|日|周|星期|晚|早|小时)|一旦.+就一直|只要.+(?:每|一直)|\b(?:every|whenever|each|daily|weekly|weekdays|hourly)\b/i;
const currentCondition=/当前|目前|现有|已有|已经|当下|如果.{0,30}已|只要.{0,30}(?:在线|仍|一直)|(?:条件|状态)(?:已)?满足(?:时|就)|\b(?:currently|already|existing|right now)\b|\bif .{0,40}\bis online\b/i;
const notification=/提醒|通知|告诉|汇报|报告|发消息|发给我|叫我|看一次|检查|复查|\b(?:alert|notify|tell|remind|report|check|ping|message|let me know)\b/i;
const review=/(?:派|交[给由]|让|请|委托|安排|由).{0,80}(?:只读|复核|核对|查证|复查)|\b(?:assign|send|ask|delegate|have)\b.{0,75}\b(?:verify|review|check|consult)\b/i;
const manualStop=/(?:直到|直至|除非)我(?:明确|主动|手动)?(?:说|要求|通知你)?(?:取消|叫停|停止)(?:为止)?|\buntil I (?:cancel|stop|(?:ask|tell) you to stop)(?: (?:it|this rule))?\b/giu;
const deadline=/直到|直至|截至|截止(?:到)?|到期日|\b(?:until|through|ending on)\b/iu;
const calendarBound=/(?:\d{4}[-/]\d|\d{1,2}月|[一二三四五六七八九十]+月|[本这下]?周[一二三四五六日天末]|星期|今天|明天|月底|年底|\b(?:today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december)\b)/iu;
const indirect=/(?:举例|示例|复述|翻译|是什么意思|解释这|引用|设想|假设|他说|她说|不要(?:.*提醒|.*复核)|别(?:.*提醒|.*复核)|暂不|取消|不需要|先不要|无需)|\b(?:example|suppose|imagine|said|quote|translate|explain|do not|don't|cancel|never)\b/i;
function requireThat(ok,message){if(!ok)throw Error(message);}
function isoDate(value){
  requireThat(typeof value==='string'&&/(?:Z|[+-]\d\d:\d\d)$/.test(value)&&Number.isFinite(Date.parse(value)),'需要含时区的有效日期');
  return toISO(Date.parse(value));
}
function identifies(text,w){
  return [w.target,w.deviceId,w.agentName,w.deviceName,...(w.aliases||[]),...(w.deviceAliases||[])].some(x=>
    x&&text.toLowerCase().includes(x.toLowerCase()));
}
function signedUser(store,turn){
  const row=store.db.prepare("SELECT m.text,m.createdAt,t.state FROM turns t JOIN messages m ON t.id=m.id AND m.role='user' WHERE t.id=?").get(turn.id);
  requireThat(row&&(!turn.text||row.text===turn.text),'委托需要来自手机用户原消息');
  return row;
}
function directText(text){
  return text.replace(/“[^”]*”|「[^」]*」|『[^』]*』|"[^"]*"|'[^']*'|`[^`]*`|^>.*$/gmu,' ');
}
function conditionText(s){
  if(s.trigger==='time')return '日历 · '+s.timeZone;
  return '等待'+title[s.trigger]+[s.match,s.taskId,s.sourceTarget,s.session?.id].filter(Boolean).map(x=>' · '+x).join('');
}
// Baselines and receipt cursors are observation state. Compare the authority
// granted by the user, independently of when a planner proposal was checked.
function sameAction(a,b){
  const identity=s=>JSON.stringify([s.trigger,s.effect,s.repeat,s.timing,s.timeZone,s.endAt,s.sourceWorkId,
    s.dueAt,s.sourceTarget,s.match?.toLowerCase(),s.taskId,s.remindEveryHours,s.session?.machine,s.session?.id,
    s.session?.target,s.actor?.deviceId,s.actor?.target]);
  return identity(a)===identity(b);
}
function overlaps(a,b){
  return a.grantStart<b.grantStart+b.evidence.length&&b.grantStart<a.grantStart+a.evidence.length;
}
function withTransaction(store,fn){return store.db.isTransaction?fn():store.transact(fn);}

export class WakeRules {
  constructor(store){
    this.store=store;this.db=store.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS wake_rules(
      id TEXT PRIMARY KEY, source TEXT NOT NULL, original TEXT NOT NULL, spec TEXT NOT NULL, workId TEXT,
      version INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'active', nextAt TEXT,
      cursor INTEGER, baseline TEXT, activated TEXT NOT NULL, resumeTimeFence INTEGER NOT NULL DEFAULT 0, observedAt INTEGER NOT NULL,
      generation INTEGER NOT NULL DEFAULT 0,scanRetryAt INTEGER NOT NULL DEFAULT 0,scanFailures INTEGER NOT NULL DEFAULT 0,gap TEXT NOT NULL DEFAULT '', issue TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS wake_occurrences(
        seq INTEGER PRIMARY KEY, rule TEXT NOT NULL, version INTEGER NOT NULL, factKey TEXT NOT NULL,
        requestId TEXT UNIQUE NOT NULL, fact TEXT NOT NULL, state TEXT NOT NULL, taskId TEXT,
        startedAt TEXT,finishedAt TEXT,result TEXT NOT NULL DEFAULT '',retryAt INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0, prompt TEXT, UNIQUE(rule,factKey));
      CREATE INDEX IF NOT EXISTS wake_occurrences_rule ON wake_occurrences(rule,seq);
      CREATE TABLE IF NOT EXISTS wake_rule_decisions(turnId TEXT PRIMARY KEY,rule TEXT,version INTEGER,decision TEXT);`);
  }
  check(a,turn,snap){
    const text=signedUser(this.store,turn).text;
    const evidence=clean(a.evidence);
    const grant=directText(text).replace(manualStop,''),instruction=directText(evidence).replace(manualStop,'');
    requireThat(evidence&&text.includes(evidence)&&instruction.trim()&&grant.includes(instruction.trim())&&!indirect.test(grant),'请直接说明要登记的条件与动作');
    const repeat=a.repeat??'once',timing=a.timing??'next',effect=a.effect??'notify';
    requireThat(Object.hasOwn(title,a.trigger)&&['current','next'].includes(timing),'缺少可以验证的触发来源');
    requireThat(['notify','consult'].includes(effect)&&(effect==='consult'?review.test(instruction)&&!forbidDelegation.test(grant):notification.test(instruction)),'本条消息没有授权这项唤醒动作');
    const prefix=text.slice(0,text.indexOf(evidence)).split(/[。；;！？!?\n]/u).at(-1);
    const clause=directText(prefix)+instruction;
    requireThat(repeat==='once'?!recurrent.test(clause):recurrent.test(instruction),'登记次数必须与原话约定的首次或每次一致');
    const now=Date.parse(snap.now),timeZone=clean(a.timeZone)||snap.timeZone||Intl.DateTimeFormat().resolvedOptions().timeZone;
    requireThat(Number.isFinite(now),'缺少登记时间');
    new Intl.DateTimeFormat('en',{timeZone});
    const s={type:'wake_rule',evidence,grantStart:text.indexOf(evidence),trigger:a.trigger,effect,repeat,timing,timeZone,registeredAt:toISO(now),
      endAt:a.endAt?isoDate(a.endAt):null,sourceWorkId:this.store.continuity.workForTurn(turn.id)};
    if(s.endAt)requireThat(Date.parse(s.endAt)>now,'委托截止时间已过');
    const tail=text.slice(s.grantStart+evidence.length).replace(/^[，,\s]+/u,'').split(/[。；;\n]/u)[0];
    const stopText=instruction+(deadline.exec(tail)?.index===0?' '+directText(tail).replace(manualStop,''):'');
    const until=deadline.exec(stopText),bounded=until||stopText.includes('为止');
    if(bounded||s.endAt){
      const ending=until?stopText.slice(until.index+until[0].length):stopText;
      requireThat(bounded&&s.endAt&&calendarBound.test(ending),'需要可核对的停止条件或截止时间');
    }
    if(a.trigger==='time'){
      requireThat(['once','daily','weekly','weekdays'].includes(repeat),'不支持这个日历周期');
      requireThat(/[零一二三四五六七八九十两\d]+(?:点|时|天后|分钟后|小时后)|今晚|早上|早晨|明早|明晚|上午|中午|下午|明天|周[一二三四五六日天末]|星期|工作日|每(?:天|日|周|晚|早)|\d:\d|\b(?:tomorrow|tonight|daily|weekly|weekdays?|every (?:day|week)|at \d|in \d+ (?:days?|hours?|minutes?))\b/i.test(evidence),'消息中缺少约定时点');
      s.dueAt=isoDate(a.dueAt);
      requireThat(!s.endAt||s.dueAt<=s.endAt,'首次时点已超过截止时间');
      if(repeat==='weekdays')requireThat(/工作日|weekday/i.test(evidence),'工作日周期需要本条消息授权');
      if(repeat==='daily')requireThat(/每天|每日|每(?:天|晚|早|日)|\bdaily\b|every day/i.test(evidence)&&!/工作日|weekdays/i.test(evidence),'每日周期需要本条消息授权');
      if(repeat==='weekly')requireThat(/每周|每星期|每个?礼拜|weekly|every (?:week|mon|tue|wed|thu|fri|sat|sun)/i.test(evidence),'每周周期需要本条消息授权');
      if(repeat==='weekdays')requireThat(!['Sat','Sun'].includes(new Intl.DateTimeFormat('en',{timeZone,weekday:'short'}).format(Date.parse(s.dueAt))),'首次时点须为工作日');
    }else {
      requireThat(['once','each'].includes(repeat),'事件需要按首次或每次发生登记');
      if(timing==='current')requireThat(s.trigger!=='session_changed'&&currentCondition.test(instruction)&&
        !/下次|下一次|每次新|每次的?新|重新|\bnext\b/i.test(clause),'处理已有状态需要用户明确授权，否则从下次新事件开始');
    }
    const workers=snap.workers||[],sourceWorker=workers.find(w=>w.target===a.sourceTarget&&w.deviceId);
    if(a.sourceTarget){
      requireThat(sourceWorker&&identifies(evidence,sourceWorker),'当前消息没有指定这个来源执行端');
      s.sourceTarget=sourceWorker.target;s.sourceDevice=sourceWorker.deviceId;
    }
    if(taskTrigger(s)){
      requireThat(Number.isSafeInteger(snap.wakeCursor)&&snap.wakeCursor>=0,'缺少可重放的任务回执来源');
      requireThat((s.trigger==='task_failed'?/失败|\bfail(?:s|ed|ure|ures)?\b/i:/完成|交回|成功|succeed|success|finish|complet/i).test(evidence),'用户原话与回执条件不符');
      s.cursor=snap.wakeCursor;s.match=clean(a.match);s.taskId=clean(a.taskId);
      if(s.match){
        requireThat(s.match.length<=160&&!/^(?:任务|新|的|失败|完成|task|new|failure|failed|completed)$/iu.test(s.match)&&
          evidence.toLowerCase().includes(s.match.toLowerCase()),'任务筛选条件需要引用原话中的具体任务名称');
        const nameEvidence=evidence.replace(/[“”「」『』"']/gu,'');
        const qualifier=/每(?:次|个|项|当)(?:的)?(?:新(?:的)?)?([^，。；：,.;:\s]{1,60}?)任务/u.exec(nameEvidence)?.[1];
        if(qualifier)requireThat(s.match.includes(qualifier),'筛选范围需要保留完整的任务名称');
      }
      if(s.taskId){
        const found=snap.tasks?.find(t=>t.id===s.taskId);
        requireThat(found&&(evidence.includes(s.taskId)||found.title&&evidence.includes(found.title)),'需要明确可识别的任务编号或名称');
      }
      requireThat(s.match||s.taskId||/所有任务|任何任务|每(?:次|个|项)(?:新(?:的)?)?任务|全部任务|\b(?:any|every|all|each) (?:new )?tasks?\b/i.test(evidence),'请指定任务名称筛选条件或明确关注所有任务');
      s.initial=timing==='current'?(snap.tasks||[]).filter(t=>this.matchTask(s,t)).map(t=>this.taskFact(s,t)):[];
    }
    if(s.trigger==='agent_online'){
      requireThat(sourceWorker&&/上线|在线|online|reconnect/i.test(evidence)&&typeof sourceWorker.online==='boolean','需要已登记且能观测上线状态的执行端');
      s.baseline=String(sourceWorker.online);
      if(a.remindEveryHours!=null){
        const n=Number(a.remindEveryHours);
        requireThat(repeat==='each'&&Number.isSafeInteger(n)&&n>=1&&n<=168&&
          (n===1?/每(?:个)?小时|hourly|every hour/i:new RegExp('每'+n+'(?:个)?小时|every '+n+' hours','i')).test(evidence),'持续状态提醒需要明确小时间隔');
        s.remindEveryHours=n;
      }
    }
    if(s.trigger==='session_changed'){
      const row=snap.sessions?.find(r=>r.machine===a.machine&&r.id===a.sessionId&&!r.archived);
      const selected=this.store.sourceFor(turn.id);
      requireThat(row&&Number.isFinite(Date.parse(row.updatedAt))&&
        (selected?.machine===row.machine&&selected.id===row.id||evidence.includes(row.id)||row.title&&evidence.includes(row.title)&&snap.sessions.filter(other=>other.title===row.title&&!other.archived).length===1),
        '需要明确选择要观察的会话');
      requireThat(/会话|更新|新活动|session|update|activity/i.test(evidence),'需要指定会话更新条件');
      s.session={machine:row.machine,id:row.id,target:row.target??null};s.baseline=row.updatedAt;
    }
    if(effect==='consult'){
      const target=workers.find(w=>w.target===a.target&&w.deviceId&&w.capabilities?.includes('read-only'));
      requireThat(target?.isolatedRead===true&&!target.needsCredentials,'缺少可接手隔离只读复核的已登记执行端');
      const clause=evidence.split(/(?:派给|交给|让|委托|安排|由|\b(?:ask|have|assign|send to)\b)/iu).at(-1);
      const exact=workers.filter(w=>clause.toLowerCase().includes(w.target.toLowerCase()));
      const named=exact.length?exact:workers.filter(w=>identifies(clause,w));
      requireThat(!named.length||named.some(w=>w.target===target.target),'复核执行端与用户指定设备不符');
      requireThat(!s.session||s.session.machine===target.deviceId&&s.session.target===target.target,'所选会话仅允许在来源设备与原 Agent 核对');
      s.actor=actor(target);
      const order=s.sourceWorkId&&this.store.work.order(s.sourceWorkId);
      requireThat(!order||['working','synthesizing'].includes(order.state),'原工作已暂停或结束');
      s.workRevision=order?.revision??null;
    }
    return s;
  }
  uniqueGrants(actions){
    const accepted=[];
    for(const action of actions){
      if(action.type==='wake_rule'){
        const rules=accepted.filter(a=>a.type==='wake_rule');
        requireThat(!rules.some(a=>overlaps(a,action)&&!sameAction(a,action)),'同一段委托有不同的触发条件或动作，请分别说明。');
        if(rules.some(a=>overlaps(a,action)))continue;
      }
      accepted.push(action);
    }
    return accepted;
  }
  register(id,turn,s){
    return withTransaction(this.store,()=>{
      const user=signedUser(this.store,turn);
      const existing=this.rule(id);
      if(existing){
        requireThat(existing.source===turn.id,'规则编号已用于其他委托');
        return this.card(existing);
      }
      const grants=this.db.prepare('SELECT id,spec FROM wake_rules WHERE source=?').all(turn.id)
        .map(row=>({id:row.id,action:JSON.parse(row.spec)}));
      this.uniqueGrants([...grants.map(g=>g.action),s]);
      const duplicate=grants.find(g=>overlaps(g.action,s));
      if(duplicate)return this.card(this.rule(duplicate.id));
      const workId=s.effect==='consult'?(s.sourceWorkId||turn.id):s.sourceWorkId;
      if(s.effect==='consult')this.store.continuity.recordPhoneTurn(turn.id,user.text,workId);
      this.db.prepare(`INSERT INTO wake_rules(id,source,original,spec,workId,nextAt,cursor,baseline,activated,observedAt)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id,turn.id,user.text,JSON.stringify(s),workId??null,s.dueAt??null,s.cursor??null,s.baseline??null,s.registeredAt,Date.parse(s.registeredAt));
      const rule=this.rule(id);
      for(const fact of s.initial||[])this.record(rule,s,fact);
      if(s.trigger==='agent_online'&&s.timing==='current'&&s.baseline==='true')
        this.record(rule,s,{key:'online:0',label:conditionText(s).replace(/^等待/,'')});
      if(s.trigger==='agent_online'&&s.remindEveryHours&&s.baseline==='true')this.next(id,toISO(Date.parse(s.registeredAt)+s.remindEveryHours*3600000));
      return this.card(this.rule(id));
    });
  }
  rule(id){return this.db.prepare('SELECT * FROM wake_rules WHERE id=?').get(id);}
  next(id,at){this.db.prepare('UPDATE wake_rules SET nextAt=? WHERE id=?').run(at,id);}
  record(rule,s,fact){
    if(rule.status!=='active')return;
    if(s.repeat==='once'&&this.db.prepare('SELECT 1 FROM wake_occurrences WHERE rule=? LIMIT 1').get(rule.id))return;
    const key='personal:wake:'+digest(JSON.stringify([rule.id,fact.key]));
    this.db.prepare(`INSERT OR IGNORE INTO wake_occurrences(rule,version,factKey,requestId,fact,state) VALUES(?,?,?,?,?,'pending')`)
      .run(rule.id,rule.version,fact.key,key,JSON.stringify(fact));
  }
  matchTask(s,t){
    if(!t.id||t.state!==s.trigger.slice(5)||String(t.requestId??'').startsWith('personal:wake:'))return false;
    if(s.sourceTarget&&t.target!==s.sourceTarget||s.taskId&&t.id!==s.taskId)return false;
    if(s.match&&!clean(t.title).toLowerCase().includes(s.match.toLowerCase()))return false;
    if(this.db.prepare("SELECT 1 FROM diagnostics WHERE kind='task' AND id=? UNION ALL SELECT 1 FROM wake_occurrences WHERE taskId=? LIMIT 1").get(t.id,t.id))return false;
    if(s.sourceWorkId){
      const step=this.db.prepare('SELECT parent,scope FROM work_steps WHERE taskId=?').get(t.id);
      if(step)return step.scope==='active'&&(step.parent===s.sourceWorkId||this.store.continuity.workForTurn(step.parent)===s.sourceWorkId);
      return !!this.db.prepare('SELECT 1 FROM assignments a JOIN continuity_turns c ON c.turnId=a.turnId WHERE a.id=? AND c.workId=?').get(t.id,s.sourceWorkId);
    }
    return true;
  }
  taskFact(s,t){return {key:'task:'+t.id,taskId:t.id,target:t.target,label:[title[s.trigger],s.match,t.id].filter(Boolean).join(' · ')};}
  card(r){
    const s=JSON.parse(r.spec),last=this.db.prepare('SELECT * FROM wake_occurrences WHERE rule=? ORDER BY seq DESC LIMIT 1').get(r.id);
    const labels={pause:'暂停',resume:'继续',cancel:'取消'};
    const actions=({active:['pause','cancel'],paused:['resume','cancel'],blocked:['cancel']}[r.status]||[]).map(decision=>({decision,label:labels[decision]}));
    const pending=last&&!last.finishedAt?(last.state==='stopping'?'等待撤回回执':receiptState[last.state]||'待处理'):'';
    const detail=[conditionText(s),r.issue,r.gap,last&&('最近一次 · '+JSON.parse(last.fact).label),last?.result,pending].filter(Boolean).join('\n');
    return {id:r.id,version:r.version,kind:'rule',messageId:r.source,title:s.evidence,status:r.status,detail,nextAt:r.nextAt,
      workId:r.workId,deviceName:s.actor?.deviceName??s.sourceDevice??null,agentName:s.actor?.agentName??s.sourceTarget??null,
      startedAt:last?.startedAt??null,finishedAt:last?.finishedAt??null,actions};
  }
  cards(messageIds){
    if(messageIds&&!messageIds.length)return [];
    const rows=messageIds?this.db.prepare('SELECT * FROM wake_rules WHERE source IN (SELECT value FROM json_each(?)) ORDER BY rowid DESC').all(JSON.stringify(messageIds)):
      this.db.prepare('SELECT * FROM wake_rules ORDER BY rowid DESC').all();
    return rows.map(r=>this.card(r));
  }
  stop(r,status,issue=''){
    this.db.prepare('UPDATE wake_rules SET status=?,version=version+1,issue=?,nextAt=NULL WHERE id=?').run(status,issue,r.id);
    this.db.prepare("UPDATE wake_occurrences SET state='stopping',retryAt=0 WHERE rule=? AND finishedAt IS NULL").run(r.id);
  }
  decide(turn,{id,version,decision,cursor,now}){
    return withTransaction(this.store,()=>{
      const user=signedUser(this.store,turn),r=this.rule(id);
      requireThat(r,'找不到这项委托');
      const old=this.db.prepare('SELECT * FROM wake_rule_decisions WHERE turnId=?').get(turn.id);
      if(old){
        requireThat(old.rule===id&&old.version===version&&old.decision===decision,'这条消息已用于另一项决定');
        return this.card(r);
      }
      requireThat(user.state==='new','请使用本次手机消息操作规则');
      requireThat(version===r.version&&this.card(r).actions.some(a=>a.decision===decision),'规则状态已变化，请查看最新卡片');
      if(decision==='resume'){
        const stamp=now!=null?toISO(Number(new Date(now))):user.createdAt,s=JSON.parse(r.spec);
        const start=Date.parse(stamp);
        requireThat(!s.endAt||stamp<=s.endAt,'委托已到截止时间');
        const due=s.trigger==='time'?(s.dueAt>=stamp?s.dueAt:s.repeat==='once'?stamp:nextCalendarTime(s,start)):null;
        this.db.prepare(`UPDATE wake_rules SET version=version+1,status='active',issue='',activated=?,observedAt=?,baseline=NULL,
          nextAt=?,cursor=coalesce(?,cursor),resumeTimeFence=?,generation=generation+1 WHERE id=?`)
          .run(stamp,start,due,Number.isSafeInteger(cursor)&&cursor>=0?cursor:null,Number(!Number.isSafeInteger(cursor)||cursor<0),id);
      }else this.stop(r,decision==='pause'?'paused':'cancelled');
      this.db.prepare('INSERT INTO wake_rule_decisions VALUES(?,?,?,?)').run(turn.id,id,version,decision);
      return this.card(this.rule(id));
    });
  }
  issue(r,message){
    if(r.issue===message)return;
    this.db.prepare('UPDATE wake_rules SET issue=? WHERE id=?').run(message,r.id);
    if(message)this.store.message('wake-issue-'+digest(JSON.stringify([r.id,r.version,message])),'assistant',message,r.source,true);
  }
  allowed(r,s){
    if(r.status!=='active')return false;
    if(this.db.prepare("SELECT 1 FROM memory_exclusions WHERE id=? UNION ALL SELECT 1 FROM diagnostics WHERE kind='turn' AND id=? LIMIT 1").get(r.source,r.source))return false;
    if(s.session&&this.db.prepare("SELECT 1 FROM observed WHERE machine=? AND sessionId=? AND status='dismissed'").get(s.session.machine,s.session.id))return false;
    const order=r.workId&&this.store.work.order(r.workId);
    if(!order)return true;
    return ['working','synthesizing'].includes(order.state)&&(s.workRevision==null||s.workRevision===order.revision);
  }
  fence(r,s){
    if(!this.allowed(r,s)){
      if(r.status==='active')this.stop(r,'blocked','委托来源或原工作范围已变化，需重新授权。');
      return false;
    }
    return true;
  }
  awaitingControl(r){
    if(r.workId&&this.store.work.order(r.workId))return this.store.heldForInput(r.source);
    const turns=this.db.prepare(`SELECT m.text FROM messages m JOIN turns t ON t.id=m.id
      LEFT JOIN continuity_turns c ON c.turnId=t.id WHERE m.seq>(SELECT seq FROM messages WHERE id=?)
      AND t.state!='done' AND (c.workId IS NULL OR c.workId=?)`).all(r.source,r.workId);
    return turns.some(t=>/暂停|停止|取消|等我|撤回|先别|先不要|\b(?:pause|stop|cancel|hold|wait)\b/i.test(t.text));
  }
  async events(r,s,broker,now){
    // Limit work per tick; cursor and occurrences commit together.
    for(let page=0;page<8;page++){
      const previous=r.cursor,version=r.version;
      const result=await broker('/wakeEvents',{after:previous,limit:100});
      r=this.rule(r.id);
      if(!this.fence(r,s)||r.cursor!==previous||r.version!==version)return false;
      requireThat(Array.isArray(result?.items)&&Number.isSafeInteger(result.cursor)&&result.cursor>=previous,'任务回执来源不可用');
      this.store.transact(()=>{
        for(const e of result.items){
          // An activation cursor is exact. After resuming without a cursor,
          // use terminal timestamps as the additional pause fence.
          if(r.resumeTimeFence&&(!e.finishedAt||e.finishedAt<=r.activated))continue;
          if(s.endAt&&e.finishedAt>s.endAt)continue;
          if(this.matchTask(s,e))this.record(r,s,this.taskFact(s,e));
        }
        this.db.prepare('UPDATE wake_rules SET cursor=?,observedAt=?,scanFailures=0,scanRetryAt=0 WHERE id=?').run(result.cursor,now,r.id);
      });
      if(!result.hasMore)return true;
      if(result.cursor===previous)return false;
      r=this.rule(r.id);
    }
    return false;
  }
  snapshot(r,s,workers,rows,now){
    let current=null;
    if(s.trigger==='agent_online'){
      const w=workers?.find(w=>w.target===s.sourceTarget&&w.deviceId===s.sourceDevice);
      if(typeof w?.online==='boolean')current=String(w.online);
    }else{
      const row=rows?.find(row=>row.machine===s.session.machine&&row.id===s.session.id&&(row.target??null)===s.session.target);
      if(row?.archived){this.stop(r,'blocked','要观察的会话已归档，需重新授权。');return;}
      if(row&&Number.isFinite(Date.parse(row.updatedAt)))current=row.updatedAt;
    }
    // A snapshot has no replay stream: a stale or absent sample cannot prove intermediate transitions.
    const gap=current===null||now-r.observedAt>120000?'观测缺口：离线期间只有当前快照，期间变化无法核实。':r.gap;
    if(current===null){
      this.db.prepare('UPDATE wake_rules SET gap=? WHERE id=?').run(gap,r.id);return;
    }
    const online=s.trigger==='agent_online';
    let generation=r.generation,nextAt=r.nextAt;
    if(r.baseline!==null&&(online?r.baseline==='false'&&current==='true':Date.parse(current)>Date.parse(r.baseline))){
      generation++;
      this.record(r,s,{key:online?'online:'+generation:'session:'+current,label:conditionText(s).replace(/^等待/,'')});
      if(online&&s.remindEveryHours)nextAt=toISO(now+s.remindEveryHours*3600000);
    }else if(online&&current==='true'&&s.remindEveryHours){
      if(!nextAt)nextAt=toISO(now+s.remindEveryHours*3600000);
      else if(Date.parse(nextAt)<=now){
        const step=s.remindEveryHours*3600000,old=Date.parse(nextAt);
        this.record(r,s,{key:'still-online:'+r.version+':'+nextAt,label:'执行端持续在线 · '+s.sourceTarget});
        nextAt=toISO(old+(Math.floor((now-old)/step)+1)*step);
      }
    }
    if(online&&current==='false')nextAt=null;
    const baseline=!online&&r.baseline&&Date.parse(current)<Date.parse(r.baseline)?r.baseline:current;
    this.db.prepare('UPDATE wake_rules SET observedAt=?,baseline=?,generation=?,gap=?,nextAt=? WHERE id=?').run(now,baseline,generation,gap,nextAt,r.id);
  }
  calendar(r,s,now){
    if(!r.nextAt||Date.parse(r.nextAt)>now)return;
    this.record(r,s,{key:'schedule:'+r.version+':'+r.nextAt,label:'约定时点已到 · '+r.nextAt});
    const next=nextCalendarTime(s,now);
    this.next(r.id,s.endAt&&next>s.endAt?null:next);
  }
  settle(r,s,o,task,now){
    if(!task||!terminalTasks.has(task.state))return false;
    const real=task.workerState&&task.workerState!==task.state?'；执行端回执：'+(receiptState[task.workerState]||task.workerState):'';
    const detail='只读复核'+(receiptState[task.state]||task.state)+real+(task.result?'\n'+String(task.result).slice(0,7000):'');
    this.finish(r,s,o,detail,task.finishedAt||task.updated||toISO(now),task);return true;
  }
  finish(r,s,o,result,finishedAt,task=null){
    this.store.transact(()=>{
      const accepted=this.db.prepare(`UPDATE wake_occurrences SET state='done',result=?,startedAt=coalesce(?,startedAt),
        finishedAt=?,taskId=coalesce(?,taskId) WHERE seq=? AND finishedAt IS NULL`).run(result,task?.startedAt??null,finishedAt,task?.id??null,o.seq);
      if(!accepted.changes)return;
      const text=JSON.parse(o.fact).label+'\n'+result;
      this.store.reply('wake-result-'+o.requestId,r.source,text,true);
      if(s.repeat==='once')this.db.prepare("UPDATE wake_rules SET status='completed',issue='',nextAt=NULL,version=version+1 WHERE id=? AND status='active' AND version=?").run(r.id,o.version);
    });
  }
  async perform(o,{broker,workers,rows,now}){
    let r=this.rule(o.rule);
    const s=JSON.parse(r.spec);
    if(r.status==='active'&&!this.fence(r,s))r=this.rule(r.id);
    if(r.status!=='active'||r.version!==o.version||o.state==='stopping'){
      if(s.effect==='consult'){
        const receipt=await broker('/cancelByRequestId',{requestId:o.requestId});
        requireThat(receipt?.cancelled,'未收到撤回确认');
        if(receipt.task){
          if(this.settle(r,s,o,receipt.task,now))return;
          this.db.prepare("UPDATE wake_occurrences SET state='stopping',taskId=?,startedAt=coalesce(startedAt,?) WHERE seq=?").run(receipt.task.id,receipt.task.startedAt??null,o.seq);
          return;
        }
      }
      this.db.prepare("UPDATE wake_occurrences SET state='done',result='已撤回，未执行',finishedAt=? WHERE seq=? AND finishedAt IS NULL").run(toISO(now),o.seq);
      return;
    }
    if(s.effect==='notify'){
      if(this.awaitingControl(r))return;
      this.finish(r,s,o,'提醒：'+s.evidence,toISO(now));return;
    }
    const requestId=o.requestId;
    let task=o.taskId?await broker('/get',{id:o.taskId}):await broker('/getByRequestId',{requestId});
    if(!task){
      const fresh=this.rule(r.id);
      if(!this.fence(fresh,s)||fresh.version!==o.version)return;
      if(this.awaitingControl(r))return;
      const worker=workers?.find(w=>w.target===s.actor.target&&w.deviceId===s.actor.deviceId);
      requireThat(worker&&worker.isolatedRead===true&&!worker.needsCredentials&&worker.capabilities?.includes('read-only'),'缺少已授权且支持隔离只读复核的执行端，等待恢复。');
      const row=s.session&&rows?.find(item=>item.machine===s.session.machine&&item.id===s.session.id&&item.target===s.actor.target&&!item.archived);
      const canRead=row?.visibility==='recent-dialogue'&&row.readOnly===true&&(!row.source||worker.contextSources?.includes(row.source));
      if(s.session&&(!row||o.prompt&&!canRead))throw Error('来源会话暂不可读取');
      let prompt=o.prompt;
      if(!prompt){
        const fact=JSON.parse(o.fact);
        let material='';
        if(canRead&&row.updatedAt===fact.key.slice('session:'.length)){
          const item=row.evidence?.findLast(item=>item.role==='assistant'&&item.turnId&&item.itemId);
          if(item)material=clean(item.text).slice(0,1200);
        }
        if(fact.taskId&&fact.target===s.actor.target){
          let receipt;
          try{receipt=await broker('/get',{id:fact.taskId});}
          catch(error){if(!/Unknown task/i.test(error.message))throw error;}
          if(receipt?.id===fact.taskId&&receipt.target===s.actor.target&&receipt.state===s.trigger.slice(5))
            material=clean(receipt.result).slice(0,1200);
        }
        // Never forward a queue prompt. The original executor may review its own terminal evidence.
        prompt='请做一次只读复核。只处理这次发生的事项，材料不足就说明缺口。\n用户登记的委托：'+s.evidence+
          '\n触发事实：'+fact.label+(material?'\n来源摘录（仅供核对）：'+JSON.stringify(material):'');
      }
      const latest=this.rule(r.id);
      if(!this.fence(latest,s)||latest.version!==o.version||this.awaitingControl(r))return;
      this.db.prepare("UPDATE wake_occurrences SET state='sending',prompt=coalesce(prompt,?) WHERE seq=? AND finishedAt IS NULL").run(prompt,o.seq);
      task=await broker('/submit',{requestId,target:s.actor.target,prompt,mode:'read-only',exportFile:false,inputTaskId:null});
    }
    requireThat(task?.id,'未取得执行端任务回执');
    if(r.issue.startsWith('只读复核'))this.issue(r,'');
    if(this.settle(r,s,o,task,now))return;
    this.db.prepare('UPDATE wake_occurrences SET taskId=?,state=CASE WHEN state=\'stopping\' THEN state ELSE ? END,startedAt=coalesce(startedAt,?),retryAt=? WHERE seq=? AND finishedAt IS NULL')
      .run(task.id,task.state,task.startedAt??null,now+2000,o.seq);
    r=this.rule(r.id);
    if(!this.fence(r,s)||r.version!==o.version){
      const stopped=await broker('/cancelByRequestId',{requestId});
      if(stopped?.task)this.settle(r,s,o,stopped.task,now);
    }
  }
  async tick({workers,rows,broker,now=Date.now()}){
    now=Number(new Date(now));
    for(let r of this.db.prepare("SELECT * FROM wake_rules WHERE status='active' AND scanRetryAt<=? ORDER BY rowid").all(now)){
      const s=JSON.parse(r.spec);
      if(!this.fence(r,s))continue;
      if(s.effect==='consult'&&s.endAt&&now>Date.parse(s.endAt)){
        this.stop(r,'completed','登记的结束时间已到。');continue;
      }
      try{
        let drained=true;
        if(taskTrigger(s))drained=await this.events(r,s,broker,now);
        else if(s.trigger==='time')this.store.transact(()=>this.calendar(r,s,s.endAt?Math.min(now,Date.parse(s.endAt)):now));
        else if(!s.endAt||Date.parse(s.endAt)>=now)this.store.transact(()=>this.snapshot(r,s,workers,rows,now));
        r=this.rule(r.id);
        if(r.status!=='active')continue;
        if(drained&&s.endAt&&now>Date.parse(s.endAt)&&!this.db.prepare('SELECT 1 FROM wake_occurrences WHERE rule=? AND finishedAt IS NULL').get(r.id)){
          this.stop(r,'completed');continue;
        }
        if(r.issue.startsWith('任务回执来源'))this.issue(r,'');
      }catch{
        this.db.prepare('UPDATE wake_rules SET scanFailures=scanFailures+1,scanRetryAt=? WHERE id=?')
          .run(now+Math.min(180000,2000*2**Math.min(r.scanFailures,7)),r.id);
        this.issue(r,'任务回执来源暂不可用，恢复后按游标补读。');
      }
    }
    const pending=this.db.prepare('SELECT * FROM wake_occurrences WHERE finishedAt IS NULL AND retryAt<=? ORDER BY retryAt,seq LIMIT 120').all(now);
    for(const o of pending){
      try{await this.perform(o,{broker,workers,rows,now});}
      catch(error){
        this.db.prepare('UPDATE wake_occurrences SET attempts=attempts+1,retryAt=? WHERE seq=? AND finishedAt IS NULL')
          .run(now+Math.min(180000,2000*2**Math.min(o.attempts,7)),o.seq);
        if(o.attempts>=3||error.message.includes('隔离只读'))this.issue(this.rule(o.rule),'只读复核暂时受阻，保留原请求等待恢复。');
      }
    }
  }
}
