import {assessRoute,routeDecision} from './dispatch-authorization.mjs';
import {FollowRouting,subjectConflict} from './follow-routing.mjs';
import {FollowGoals} from './follow-goals.mjs';
import {offlineQuery} from './follow-chat.mjs';
import {agentActivity} from './agent-evidence.mjs';
import {WorkReadTickets} from './work-read-tickets.mjs';
import {desktopBackfill,desktopHasBackfill} from './desktop-backfill.mjs';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import {projectAliasesFor} from './registry.mjs';
import {actor,routeHints} from './router-policy.mjs';
import {deliverWork} from './router-delivery.mjs';
import {checkedRevision,acceptRevision,withdrawPausedSteps} from './work-steering.mjs';
import {PersonalStore} from './personal-store.mjs';
import {groupBoard} from './board-groups.mjs';
import {findSharedWork} from './personal-opportunities.mjs';
import {Flows} from './personal-flows.mjs';
import {ProactiveCandidates} from './proactive-candidates.mjs';
import {WakeRules} from './wake-rules.mjs';
import {WorkWake,checkedWorkControl} from './work-wake.mjs';
import {nativeCardChoice} from './proactive-chat.mjs';
import {ChatCardVersions,currentCard,applyCardDecision} from './chat-card-routing.mjs';
import {TokenUsage,usageAnswer} from './token-usage.mjs';
import {selectPlanner} from './personal-model.mjs';
import {home,call} from './control.mjs';

const terminal=new Set(['succeeded','failed','interrupted','cancelled']);

const clean=(s,n)=>typeof s==='string'?s.trim().slice(0,n):'';
const specific=(rows,id)=>rows.find(row=>row.id===id);
const optional=async(fn,fallback)=>{try{return await fn();}catch{return fallback;}};
function compact(row){return {machine:row.machine,target:row.target??null,id:row.id,title:clean(row.title,140),summary:clean(row.summary,720),cwd:clean(row.cwd,230),updatedAt:row.updatedAt,status:row.status,visibility:row.visibility,source:row.source,evidence:(row.evidence||[]).slice(-3).map(e=>({role:e.role,text:clean(e.text,460),at:e.at,turnId:e.turnId,itemId:e.itemId}))};}
function describeFact(fact){
  const date=Date.parse(fact.at);
  const stamp=Number.isFinite(date)?new Date(date).toLocaleString('zh-CN',{hour12:false}):'时间未知';
  return [fact.stageLabel,fact.summary,fact.sourceLabel,stamp,fact.freshness==='stale'?'较早记录':null].filter(Boolean).join(' · ');
}
function merge(rows){const list=new Map();for(const r of rows)if(r?.id&&!list.has(r.machine+'|'+r.id))list.set(r.machine+'|'+r.id,r);return [...list.values()];}
function plausibleDate(value){
  if(value==null||value==='')return null;
  if(typeof value!=='string'||!/(Z|[+-]\d\d:\d\d)$/.test(value)||!Number.isFinite(Date.parse(value)))throw Error('提醒时间缺少时区或日期无效');
  return new Date(value).toISOString();
}
function assert(ok,msg){if(!ok)throw Error(msg);}
export class PersonalAgent{
  constructor({store,planner,contexts,broker=call}){
    this.usage=new TokenUsage(store.db);
    this.store=store;this.flows=new Flows(store);this.planner=this.usage.wrap(planner);this.contexts=contexts;this.broker=broker;
    this.candidates=new ProactiveCandidates(store);this.rules=new WakeRules(store);this.workWake=new WorkWake(store);
    this.goals=new FollowGoals(store);
    this.follow=new FollowRouting(store,this.goals);
    this.cardVersions=new ChatCardVersions(store.db);
    this.observedRows=[];this.rowsAvailable=false;
    this.processing=false;this.checking=false;this.lastObservation=0;
  }
  async contextRows(query,limit=20){return await this.contexts.readContexts(home,{query,limit});}
  proactiveCards(ids){return [...this.candidates.cards(ids),...this.rules.cards(ids),...this.goals.cards(ids)];}
  history(input){
    const result=this.store.history(input),messages=new Map(result.messages.map(m=>[m.id,m]));
    for(const card of this.proactiveCards([...messages.keys()])){
      const row=messages.get(card.messageId);
      if(row)(row.proactive??=[]).push(card);
    }
    for(const row of result.messages)if(row.work)Object.assign(row.work,this.workWake.card(row.work.id));
    return result;
  }
  evidenceTasks(visible){
    const steps=this.store.db.prepare(`SELECT taskId,target,kind,title FROM work_steps
      WHERE taskId IN (SELECT value FROM json_each(?))`).all(JSON.stringify(visible.map(task=>task.id)));
    const byId=new Map(steps.map(step=>[step.taskId,step]));
    return visible.map(task=>{
      const step=byId.get(task.id);
      return step&&step.target===task.target?{...task,workStep:{kind:step.kind,title:step.title}}:task;
    });
  }
  async refreshGoals(rows,catalog,now=Date.now(),onlyId=null){
    if(!this.goals.hasActive())return;
    const [index,workers,tasks,coverage]=await Promise.all([
      rows??optional(()=>this.contextRows('',500),null),catalog??optional(()=>this.broker('/workers'),null),
      optional(()=>this.broker('/list'),[]),optional(()=>this.contexts.contextCoverage(home),[])]);
    if(!Array.isArray(index)||!Array.isArray(workers))return;
    const bySource=new Set(index.map(row=>row.machine+'|'+row.id));
    const specs=this.goals.activeSpecs(onlyId);
    const extra=await Promise.all([
      ...specs.flatMap(s=>s.subjectSource?[...s.scopes,s.subjectSource]:s.scopes).filter(p=>!bySource.has(p.machine+'|'+p.id)).map(p=>optional(()=>this.exactSession(p),null)),
      ...(index.length>=500?specs.filter(s=>!s.scopes.length).map(s=>optional(()=>this.contextRows(s.title,80),[])):[])
    ]);
    this.goals.observe({rows:merge([...index,...extra.flat()]),workers,tasks:this.evidenceTasks(this.store.visibleTasks(tasks)),coverage,now,onlyId});
  }
  async chatQuery(query,{id,title,goalIds,refresh=true}={}){
    if(query==='usage')return usageAnswer(this.usage.summary());
    if(query==='activity'){
      const {machines}=await this.board({layout:'machines'});
      const lines=machines.flatMap(m=>m.agents.map(a=>m.name+' / '+a.name+' · '+(a.activity?describeFact(a.activity):'暂无可归属的记录')));
      return lines.join('\n')||'还没有已注册的 Agent。';
    }
    if(refresh)await this.refreshGoals(null,null,Date.now(),id);
    const cards=this.goals.cards().filter(c=>c.status!=='stopped'&&(!id||c.id===id)&&(!title||c.title===title)&&(!goalIds||goalIds.has(c.id)));
    if(!cards.length)return '当前没有关注中的目标。可以直接告诉我“帮我关注……”和目标名称。';
    return cards.map(c=>{
      const notices=c.findings.filter(f=>f.wouldNotify);
      const latest=notices.length?notices:c.findings;
      return ['「'+c.title+'」 · '+({preview:'仅预览',enabled:'推送已开启',paused:'跟进已暂停'}[c.status]??c.status),
        notices.length?'符合提醒条件的依据：':'当前没有符合提醒条件的新依据。',
        ...latest.slice(0,3).map(f=>f.deviceName+' / '+f.agentName+' · '+describeFact(f))].join('\n');
    }).join('\n\n');
  }
  async handleChatCard(turn,proposed,snap){
    const finish=message=>this.store.transact(()=>this.store.finish(turn,message));
    const [a]=proposed.actions;
    if(snap.work||snap.attachedSession)return finish('请回到主聊天查看或操作这张卡。');
    if(proposed.workControl||proposed.actions.length!==1||typeof a?.evidence!=='string'||!a.evidence.trim()||!turn.text.includes(a.evidence))
      return finish('请单独指定要查看的内容或要操作的卡片。');
    if(a.type==='chat_query'){
      const goals=new Set(snap.cards.filter(c=>c.kind==='goal').map(c=>c.id));
      if(!['goals','activity','usage'].includes(a.query)||!Object.keys(a).every(k=>['type','evidence','query','id'].includes(k))||
        (a.id!==undefined&&(a.query!=='goals'||!goals.has(a.id))))return finish('请指定要查看的目标或总览。');
      return finish(await this.chatQuery(a.query,{id:a.id,goalIds:goals}));
    }
    const offered=snap.cards.find(c=>c.id===a.id&&c.version===a.version&&c.decisions.includes(a.decision));
    if(!offered||a.type!=='card_decision'||!Object.keys(a).every(k=>['type','evidence','decision','version','id'].includes(k)))
      return finish('卡片状态已变化或无法确定，请查看最新卡片。');
    this.store.transact(()=>{
      try{
        const stillOffered=this.cardVersions.offered.all(Date.now(),turn.id).some(c=>c.id===a.id&&c.version===a.version);
        if(!stillOffered)throw Error('卡片状态已变化，请查看最新卡片。');
        applyCardDecision(this,turn,a,currentCard(this,a.id),snap.wakeCursor);
      }catch(e){this.store.finish(turn,e.message);}
    });
  }
  async receive(input){
    if(typeof input.requestId==='string'&&this.store.db.prepare('SELECT 1 FROM turns WHERE requestId=?').get(input.requestId))
      return this.store.receive(input);
    const choice=nativeCardChoice(input.text);
    if(choice){
      const cursor=choice.decision==='resume'?await optional(()=>this.broker('/wakeEvents',{after:null}),null):null;
      return this.store.receive(input,null,turn=>{
        try{
          const card=currentCard(this,choice.id);
          if(input.context&&(!card?.workId||input.workId&&input.workId!==card.workId||
            !this.store.continuity.participants(card.workId).some(p=>p.machine===input.context.machine&&p.id===input.context.id)))
            throw Error('请在该事项的主聊天卡片上确认。');
          return applyCardDecision(this,turn,choice,card,cursor?.cursor);
        }catch(e){this.store.finish(turn,e.message);return {id:turn.id};}
      },{linkWork:false});
    }
    if(this.planner?.offline){
      const lookup=offlineQuery(input.text,this.goals.activeSpecs().map(g=>g.title));
      if(!lookup)throw Error('自然语言操作需要聊天模型。请启用模型，或使用已有卡片上的按钮。');
      const answer=input.context?'请回到主聊天查看总览。':await this.chatQuery(lookup.query,{title:lookup.title,refresh:false});
      return this.store.receive(input,null,turn=>{this.store.finish(turn,answer);return {id:turn.id};},{linkWork:false});
    }
    const row=input.context?await this.exactSession(input.context):null;
    if(input.context&&!row)throw Error('当前索引里找不到所选会话');
    const alreadyJoined=row&&input.workId&&this.store.continuity.participants(input.workId)
      .some(p=>p.machine===row.machine&&p.id===row.id&&p.target===(row.target??''));
    if(row&&!alreadyJoined){
      // A board selection normally binds its desktop thread on receipt. Resolve
      // observation-only requests before that binding can create a work identity.
      const scope=JSON.stringify([row.machine,row.id]);
      const attachedSession={machine:row.machine,id:row.id,target:row.target,title:row.title,found:true};
      const snap={phase:'selectedFollow',currentUser:input.text,attachedSession,sessions:[compact(row)],follow:this.follow.context(scope)};
      const proposal=await this.followProposal(snap);
      if(proposal.workControl||!this.leftFollow(proposal,input.text)){
        const actions=proposal.actions??[];
        const card=actions.some(a=>['card_decision','chat_query'].includes(a?.type));
        const effect=!proposal.workControl&&actions.length===1&&['follow_goal','pause_follow','dismiss_follow'].includes(actions[0]?.type);
        const denied=effect?await routeDecision(this.planner,{text:input.text.trim()},snap,proposal):null;
        if(card||denied)return this.store.receive(input,row,turn=>{
          this.store.finish(turn,denied||'请回到主聊天查看或操作这张卡。');
          return {id:turn.id};
        },{linkWork:false});
        let outcome;
        const result=this.store.receive(input,row,turn=>{outcome=this.follow.handle(turn,proposal,snap,{scope,selected:row});},{linkWork:false});
        if(outcome?.previewId)await this.refreshGoals(null,null,Date.now(),outcome.previewId);
        return result;
      }
      return this.store.receive(input,row,turn=>{
        this.follow.clear(scope);
        return {id:turn.id,workId:this.store.continuity.workForTurn(turn.id)};
      });
    }
    if(row)return this.store.receive(input,row);
    return this.store.receive(input,null,turn=>this.cardVersions.capture(turn));
  }
  async exactSession({machine,id}){
    if(typeof machine!=='string'||typeof id!=='string')return null;
    if(this.contexts.readSession)return this.contexts.readSession(home,machine,id);
    return (await this.contextRows(id,5)).find(row=>row.machine===machine&&row.id===id)??null;
  }
  async board({layout}={}){
    const [workers,tasks,sessions,coverage]=await Promise.all([
      optional(()=>this.broker('/workers'),[]),optional(()=>this.broker('/list'),[]),
      this.contextRows('',500),this.contexts.contextCoverage(home)]);
    const visible=this.store.visibleTasks(tasks);
    const evidence=this.evidenceTasks(visible);
    const available=workers.map(worker=>({...worker,activity:agentActivity({worker,rows:sessions,tasks:evidence,coverage})}));
    const rows={workers:available,tasks:visible,sessions:sessions.map(({evidence,...s})=>s),coverage};
    return {...(layout==='machines'?groupBoard(rows):rows),coverage,usage:this.usage.summary(),
      preferences:this.store.preferences(),commitments:this.store.openItems().concat(this.flows.listReviews()),watches:this.store.watchers().map(({id,text,machine,sessionId})=>({id,text,machine,sessionId}))};
  }
  async snapshot(turn) {
    const source=this.store.sourceFor(turn.id);
    const attached=source?await this.exactSession(source):null;
    const work=this.store.continuity.recentForTurn(turn.id);
    const participants=work?this.store.continuity.participants(work.workId):null;
    const allowed=row=>!participants||participants.some(p=>p.machine===row.machine&&p.id===row.id&&p.target===(row.target??''));
    const [latest,matches,links,coverage,workers,queue]=await Promise.all([
      work?[]:this.contextRows('',12),work?[]:this.contextRows(turn.text,12),
      Promise.all((participants??this.store.lastLinks()).map(p=>this.exactSession(p))),
      work?[]:this.contexts.contextCoverage(home),optional(()=>this.broker('/workers'),[]),optional(()=>this.broker('/list'),[])]);
    const rows=merge([attached,...matches,...links,...latest]).filter(allowed);
    const related=/会话|电脑|机器|工作|项目|进展|上次|之前|上回|昨天|最近|接着|继续|刚才|刚刚|做什么|在做|结果|分析|桌面|那批|这批|任务|比较|差异|分析|查证|session|project|machine|resume|thread/i.test(turn.text);
    const recent=new Map();
    for(const r of latest){if(!recent.has(r.machine))recent.set(r.machine,r);}
    const prior=links.filter(r=>r&&allowed(r));
    const followUp=prior.length&&turn.text.length<=120&&/它|这个|接着|接上|还有|为什么|怎么|然后|具体|后来|那|继续|这个|它|that|why|next/i.test(turn.text);
    const rich=attached||related||followUp?merge([attached,...matches.slice(0,4),...prior,...recent.values()]).slice(0,7):[];
    const sessions=merge([...rich.filter(allowed).map(compact),...rows.slice(0,22).map(r=>({machine:r.machine,target:r.target??null,id:r.id,title:r.title,updatedAt:r.updatedAt,source:r.source,visibility:'metadata-only'}))]);
    const project=attached?.cwd || (followUp?prior[0]?.cwd:null) || null;
    const workId=work?.workId??null;
    const activeWork=this.store.db.prepare(`SELECT w.id,m.text,w.goal,w.revision,w.state FROM work_orders w JOIN messages m ON m.id=w.id
      LEFT JOIN continuity_turns c ON c.turnId=w.id WHERE w.state IN ('working','synthesizing','paused')
      AND (? IS NULL OR c.workId=?) ORDER BY m.seq DESC LIMIT 20`).all(workId,workId)
      .map(order=>({...order,tasks:this.store.work.card(order.id).tasks.map(({id,taskId,title,deviceName,agentName,target,state,scope})=>
        ({id,taskId,title,deviceName,agentName,target,state,scope}))}));
    const catalog=workers.map(w=>{
      const {projectAliases,...device}=w;
      const scopedAliases=[...projectAliasesFor(w,project),...this.store.deviceAliases(w.deviceId,project)];
      return {...device,scopedAliases,deviceAliases:[...new Set([...(w.deviceAliases||[]),...scopedAliases])]};
    });
    const inScope=work?new Set(this.store.db.prepare(`SELECT a.id FROM assignments a
      JOIN continuity_turns c ON a.turnId=c.turnId WHERE c.workId=?`).all(workId).map(a=>a.id)):null;
    let preferences,commitments;
    if(work){
      const owned='source IN (SELECT turnId FROM continuity_turns WHERE workId=?)';
      preferences=this.store.db.prepare(`SELECT id,key,text,scope,updatedAt FROM prefs
        WHERE scope='global' OR ${owned} ORDER BY updatedAt DESC LIMIT 120`).all(workId);
      const reminders=this.store.db.prepare(`SELECT id,text,status,dueAt,intervalDays FROM commitments
        WHERE status='open' AND ${owned} AND source NOT IN (SELECT id FROM diagnostics WHERE kind='turn') ORDER BY createdAt DESC LIMIT 100`).all(workId);
      const reviews=this.store.db.prepare(`SELECT id,text,dueAt,intervalDays,'定期复查' AS status FROM reviews
        WHERE active=1 AND ${owned} ORDER BY dueAt LIMIT 100`).all(workId);
      const observation=this.store.db.prepare("SELECT id,text,status,machine,sessionId,sourceTime,reason FROM observed WHERE machine=? AND sessionId=? AND status='observed'");
      commitments=reminders.concat(rows.flatMap(row=>observation.all(row.machine,row.id)),reviews);
    }else{
      preferences=this.store.preferences();
      commitments=this.store.openItems().concat(this.flows.listReviews());
    }
    const wakeCursor=(await optional(()=>this.broker('/wakeEvents',{after:null}),null))?.cursor??null;
    return {project,work,activeWork,wakeCursor,attachedSession:source?{...source,found:!!attached}:null,now:new Date().toISOString(),timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone,currentUser:turn.text,
      preferences:preferences.slice(0,120),commitments:commitments.slice(0,100),
      history:this.store.previous(turn.seq,turn.id),sessions,coverage,workers:catalog,
      lastMentioned:participants??this.store.lastLinks(),tasks:this.store.visibleTasks(queue).filter(t=>!inScope||inScope.has(t.id)).slice(0,22)};
  }
  check(turn,plan,snap){
    const workers=snap.workers||[];
    const registered=target=>workers.find(w=>w.target===target&&w.deviceId);
    const criteria=Array.isArray(plan.criteria)?plan.criteria.filter(x=>typeof x==='string'&&x.trim()).slice(0,6).map(x=>clean(x,480)):[];
    if(!criteria.length)criteria.push(turn.text);
    const refs=(snap.attachedSession?.found?[snap.attachedSession,...(plan.references||[])]:plan.references||[]).map(r=>snap.sessions.find(s=>r?.id===s.id&&r.machine===s.machine)).filter(Boolean);
    const actions=[];
    const edits=plan.actions.filter(a=>a?.type==='revise');
    // A scoped amendment owns only its routing effects. Ignore the planner's
    // incidental reminder bookkeeping without touching independent personal items.
    const proposedActions=edits.length?plan.actions.filter(a=>!['close','review'].includes(a?.type)):plan.actions;
    if(proposedActions.some(a=>a?.type==='wake_rule'))assert(proposedActions.every(a=>a?.type==='wake_rule'),'请将常驻委托与立即执行的分工分别交代');
    assert(edits.length<=1&&(!edits.length||proposedActions.every(a=>['revise','consult','dispatch'].includes(a?.type))),'一次变更需要明确一项工作及其新分工');
    const revision=edits.length?checkedRevision(edits[0],snap.activeWork||[]):null;
    const scoped=revision||proposedActions.filter(a=>['dispatch','consult','handoff'].includes(a?.type)).length>1;
    for(const a of proposedActions){
      assert(a&&typeof a==='object'&&typeof a.evidence==='string'&&a.evidence.trim().length>0&&turn.text.includes(a.evidence),'操作缺少来自你本条消息的依据');
      const text=clean(a.text,1500);
      switch(a.type){
        case 'wake_rule':actions.push(this.rules.check(a,turn,snap));break;
        case 'revise':actions.push(revision);break;
        case 'device_alias':{
          const alias=clean(a.alias,80),device=workers.find(w=>w.deviceId===a.deviceId);
          const scope=a.projectOnly?snap.project:'';
          assert(device&&alias&&turn.text.includes(alias)&&(!a.projectOnly||scope),'别名需要明确的设备、称呼和项目');
          actions.push({type:'device_alias',deviceId:device.deviceId,alias,scope});break;
        }
        case 'preference':
        case 'remember':{
          const key=clean(a.key,100),scope=clean(a.scope,120)||'global';
          assert(key&&text,'偏好内容不完整');
          actions.push({type:'remember',key,scope,text,restore:this.store.wasForgotten(key,scope,text)});break;
        }
        case 'forget':assert(specific(snap.preferences,a.id),'未找到这条偏好');actions.push({type:a.type,id:a.id});break;
        case 'todo':{
          const dueAt=plausibleDate(a.dueAt),days=Number(a.intervalDays??0);
          assert(text&&[0,1,7].includes(days)&&(!days||dueAt),'待办或周期不完整');
          actions.push({type:a.type,text,dueAt,intervalDays:days});break;
        }
        case 'close':assert(specific(snap.commitments,a.id),'未找到这项待办');actions.push({type:a.type,id:a.id});break;
        case 'watch':{
          const row=snap.sessions.find(s=>s.id===a.id&&s.machine===a.machine);
          assert(row&&text,'需要指定要关注的会话');
          actions.push({type:a.type,row:{machine:row.machine,id:row.id,updatedAt:row.updatedAt},text});break;
        }
        case 'consult':
        case 'dispatch':{
          const worker=registered(a.target),prompt=clean(a.prompt,9000);
          assert(worker&&prompt,'执行端尚未注册或任务描述缺失');
          assert(!worker.needsCredentials,'执行端需要恢复登录');
          const attached=snap.attachedSession;
          const sourceId=a.sessionId||(attached?.machine===worker.deviceId?attached.id:null);
          const row=sourceId?snap.sessions.find(s=>s.id===sourceId&&s.machine===worker.deviceId):null;
          assert(!sourceId||row,'指定会话与执行设备不一致');
          const write=a.type==='dispatch'&&a.write===true;
          const mode=write?'workspace-write':'read-only';
          assert(worker.capabilities?.includes(mode),'执行端没有所需能力');
          if(attached&&attached.machine===worker.deviceId&&sourceId)assert(attached.id===sourceId,'指定会话与所选会话不一致');
          const context=row?'\n来源会话，只读资料：'+JSON.stringify(compact(row)):'';
          const objective=scoped?'\n只执行上方委派给你的分工，直接交回这一份产出与依据。其他执行端由总控协调。':
            '\n本次要求：'+turn.text+'\n整项交付要求：'+JSON.stringify(criteria)+'\n请完成本次分工，结论区分已查实与推断，标注关键依据；允许材料不足，说明具体缺口。';
          actions.push({type:a.type,target:worker.target,actor:actor(worker),title:clean(a.title||prompt.split('\n')[0],90),
            prompt:prompt+objective+context,mode,notify:a.notify===true});break;
        }
        case 'handoff':{
          const from=registered(a.from),to=registered(a.to);
          assert(from?.capabilities?.includes('workspace-write')&&from.capabilities.includes('handoff')&&to?.capabilities?.includes('read-only')&&to.capabilities.includes('handoff')&&a.from!==a.to&&clean(a.first,6000)&&clean(a.second,6000),'两阶段交接需要清晰的产物和后续用途；from 与 to 须分别填写两个支持交接的 workers[].target。');
          actions.push({type:'handoff',from:a.from,to:a.to,firstActor:actor(from),secondActor:actor(to),first:clean(a.first,6000),second:clean(a.second,6000),notify:a.notify===true});break;
        }
        case 'review':{
          const due=plausibleDate(a.dueAt),days=Number(a.intervalDays??0);
          assert(text&&due&&[0,1,7].includes(days),'复查规则缺少明确时间');
          actions.push({type:'review',text,dueAt:due,days});break;
        }
        case 'cancel':{
          const parent=snap.activeWork?.find(order=>order.id===a.id);
          const child=snap.activeWork?.find(order=>order.tasks?.some(step=>step.id===a.id||step.taskId===a.id));
          assert(!child,'部分分工调整必须使用 revise 并更新验收范围');
          assert(parent||(!snap.work&&(this.flows.ownedFirst(a.id)||this.store.waiting().some(x=>x.id===a.id))),'这项任务不属于当前助手或已结束');
          actions.push({type:a.type,id:a.id,...(parent?{expectedRevision:parent.revision}:{})});break;
        }
        default:throw Error('模型提出了当前版本不支持的操作');
      }
    }
    const used=snap.preferences.filter(p=>(plan.usedPreferences||[]).includes(p.id)||plan.reply.includes(p.text)).map(({key,scope})=>({key,scope}));
    const workControl=checkedWorkControl(plan.workControl,turn.text);
    if(workControl){
      const delegated=actions.some(a=>['consult','dispatch','handoff'].includes(a.type));
      assert(revision||delegated,'持续工作需要一项明确的工作');
      if(workControl.mode==='pause'){
        assert(revision&&!delegated&&this.workWake.goal(revision.id),'等待决定需要关联当前持续工作，暂停时不能派单');
        // The reviewer must see every assignment that a whole-work hold will withdraw.
        const order=snap.activeWork.find(w=>w.id===revision.id);
        const unfinished=order.tasks.filter(s=>s.scope==='active'&&!terminal.has(s.state));
        revision.pauseStepIds=[...new Set([...revision.pauseStepIds,...unfinished.map(s=>s.id)])];
      }
    }
    return {workControl,reply:clean(plan.reply,14000),actions:this.rules.uniqueGrants(actions),criteria,used,refs:refs.map(r=>({machine:r.machine,id:r.id}))};
  }
  async apply(turn,plan){
    const results=[];
    const work=this.store.work;
    const revision=plan.actions.find(a=>a.type==='revise');
    const cancellations=plan.actions.filter(a=>a.type==='cancel'&&(a.expectedRevision!=null||work.order(a.id)));
    if(cancellations.length)this.store.transact(()=>{
      for(const action of cancellations){
        const order=work.order(action.id);
        if(!order||action.expectedRevision!=null&&(order.revision!==action.expectedRevision||
          !['working','synthesizing','paused','cancelled'].includes(order.state)))throw Error('工作范围已变化或工作已结束');
        work.setState(order.id,'cancelled');
        for(const step of work.evidence(order.id))if(step.taskId)this.flows.stopFlow(step.taskId);
      }
    });
    const linked=this.store.continuity.workForTurn(turn.id);
    const existing=linked&&work.order(linked);
    const parent=revision?.id||(['working','synthesizing'].includes(existing?.state)?linked:turn.id);
    const delegated=plan.actions.some(a=>['consult','dispatch','handoff'].includes(a.type));
    if(delegated && plan.actions.some(a=>(['consult','dispatch'].includes(a.type)&&!a.actor)||(a.type==='handoff'&&!a.firstActor))){
      const catalog=await this.broker('/workers');
      const resolve=target=>{const worker=catalog.find(w=>w.target===target);assert(worker,'Unknown worker');return actor(worker);};
      for(const a of plan.actions){
        if(a.type==='handoff'){a.firstActor=resolve(a.from);a.secondActor=resolve(a.to);}
        else if(a.type==='consult'||a.type==='dispatch'){a.actor=resolve(a.target);a.title=a.title||clean(a.prompt,90);}
      }
    }
    if(delegated||revision)this.store.transact(()=>{
      if(revision)acceptRevision(this,turn,revision);
      else if(parent===turn.id)work.create(turn,plan.criteria||[turn.text]);
      this.workWake.registerGoal(turn,parent,plan.workControl);
      for(const [i,a] of plan.actions.entries()){
        const key=turn.id+':'+i;
        if(a.type==='handoff'){
          work.stage(parent,key,a.firstActor,'dispatch',clean(a.first,90),a.notify,false,'workspace-write');
          work.stage(parent,key+':next',a.secondActor,'dispatch',clean(a.second,90),a.notify,true);
        }else if(a.type==='consult'||a.type==='dispatch')work.stage(parent,key,a.actor,a.type,a.title,a.notify,false,a.mode);
      }
    });
    if(revision)await withdrawPausedSteps(this,parent);
    for(const [i,a] of plan.actions.entries()){
      const old=this.store.effect(turn.id,i);
      if(old){
        results[i]=old.result;
        if(delegated&&['consult','dispatch','handoff'].includes(a.type)){
          const key=turn.id+':'+i,step=work.evidence(parent).find(s=>s.id===key);
          if(step&&!step.taskId){const task=await this.broker('/get',{id:old.result});this.store.transact(()=>{work.bind(key,task);this.store.track(task.id,{id:parent},a.notify);});}
        }
        continue;
      }
      if(a.type==='dispatch'||a.type==='consult'){
        const result=await this.broker('/submit',{...a,requestId:'personal:'+turn.id+':'+i});
        results[i]=result.id;
        this.store.transact(()=>{work.bind(turn.id+':'+i,result);this.store.track(result.id,{id:parent},a.notify);this.store.ackEffect(turn.id,i,result.id);});
      }else if(a.type==='handoff'){
        const first=await this.broker('/submit',{target:a.from,prompt:a.first,mode:'workspace-write',exportFile:true,requestId:'personal:'+turn.id+':'+i});
        results[i]=first.id;
        this.store.transact(()=>{work.bind(turn.id+':'+i,first);this.store.track(first.id,{id:parent},false);this.flows.handoff(first.id,{...turn,id:parent},a);this.store.ackEffect(turn.id,i,first.id);});
      }else if(a.type==='cancel'){
        const parent=work.order(a.id);
        if(parent){
          await withdrawPausedSteps(this,a.id,{wholeOrder:true});
          this.store.ackEffect(turn.id,i,a.id);continue;
        }
        if(this.flows.stopFlow(a.id))await this.broker('/cancelByRequestId',{requestId:'handoff:'+a.id});
        await this.broker('/cancel',{id:a.id});
        this.store.ackEffect(turn.id,i,a.id);
      }
    }
    this.store.transact(()=>{
      const receipts=[];
      for(const p of plan.used||[])this.store.markMemoryUsed(turn,p);
      for(const [i,a] of plan.actions.entries()){
        const id=turn.id+'-'+i;
        switch(a.type){
          case 'wake_rule':this.rules.register(id,turn,a);receipts.push('已登记常驻委托，触发条件和执行记录见本条消息的卡片。');break;
          case 'device_alias':this.store.setDeviceAlias(a,turn.id);receipts.push('已记录设备称呼「'+a.alias+'」。');break;
          case 'remember':if(this.store.remember(turn,a))receipts.push('已记住：'+a.text);else receipts.push('这条已遗忘的偏好没有重新保存。');break;
          case 'forget':this.store.forget(turn,a.id);receipts.push('已从个人记忆移除。');break;
          case 'todo':this.store.addCommitment(id,a.text,a.dueAt,a.intervalDays,turn.id);receipts.push((a.dueAt?'已设置提醒：':'已记为待办：')+a.text);break;
          case 'close':this.flows.close(a.id);this.store.closeCommitment(a.id);receipts.push('这项待办已完成。');break;
          case 'watch':this.store.watch(id,a.row,a.text,turn.id);receipts.push('我会在这段会话有新活动时提醒你。');break;
          case 'dispatch':case 'consult':break;
          case 'handoff':break;
          case 'review':this.flows.addReview(id,turn,a.text,a.dueAt,a.days);receipts.push('已登记定时复查。');break;
          case 'cancel':receipts.push('停止请求已提交。');break;
        }
      }
      for(const r of plan.refs)this.store.link(turn,r);
      const text=[plan.reply,...receipts.filter(x=>!plan.reply.includes(x))].filter(Boolean).join('\n');
      if(revision){
        this.store.finish(turn,'已更新这项工作的目标：'+revision.goal+'。执行端的回执见下方任务卡。');
      }else if(delegated){
        if(receipts.length)this.store.message('ack-'+turn.id,'assistant',receipts.join('\n'),turn.id);
        this.store.db.prepare("UPDATE turns SET state='done',plan=NULL WHERE id=?").run(turn.id);
      }else this.store.finish(turn,text||'收到。');
    });
  }
  async deliver(){
    if(this.delivering)return;
    this.delivering=true;
    try{await deliverWork(this);}finally{this.delivering=false;}
  }
  async followSnapshot(snap,turn){
    snap.cards=this.cardVersions.snapshot(this,turn);
    snap.follow=this.follow.context();
    const subject=snap.follow.focus?.subjectSource;
    if(subject&&!snap.sessions.some(s=>s.machine===subject.machine&&s.id===subject.id&&s.visibility!=='metadata-only')){
      const row=await optional(()=>this.exactSession(subject),null);
      if(row?.target===subject.target)snap.sessions=merge([compact(row),...snap.sessions]);
    }
    if(snap.follow.pending){
      const originalMatches=await optional(()=>this.contextRows(snap.follow.pending.request,8),[]);
      snap.sessions=merge([...snap.sessions,...originalMatches.map(compact)]);
      snap.phase='pendingFollow';
    }
    else if(snap.follow.focus)snap.phase='focusedFollow';
    if(!snap.phase)return snap;
    const {phase,currentUser,now,timeZone,sessions,history,follow}=snap;
    return {phase,currentUser,now,timeZone,sessions,history,follow};
  }
  async followProposal(input){
    const plan=await this.planner.plan(input);
    if(subjectConflict(plan,input))
      return this.planner.plan({...input,routingCorrection:'这项选择缺少同一项目的依据，或拟定的名称改变了原卡身份。重新从用户原话辨认具体项目。若是不同项目，独立建立预览，省略 goalId；若确有多个可能，返回 follow_goal.question。不能合并、扩展或改名已有目标。'});
    if(!['pendingFollow','focusedFollow','selectedFollow'].includes(input.phase)||plan.actions?.length)return plan;
    // A missing decision is a model format error, not a request to forget the
    // open intent. One correction retains the same read-only capabilities.
    return this.planner.plan({...input,routingCorrection:'请按当前 phase 在 actions 中填写一个决定。补充信息时使用原目标，改谈其他事情用 leave_follow。'});
  }
  leftFollow(plan,text){
    const [action]=plan.actions??[];
    return plan.actions?.length===1&&action?.type==='leave_follow'&&Object.keys(action).every(k=>['type','evidence'].includes(k))&&typeof action.evidence==='string'&&
      action.evidence.trim().length>0&&text.includes(action.evidence);
  }
  async step(){
    if(this.processing)return;
    const turn=this.store.pending();
    if(!turn||Number(turn.nextTry)>Date.now())return;
    this.processing=true;
    try{
      let plan=turn.plan?JSON.parse(turn.plan):null;
      if(!plan){
        const snap=await this.snapshot(turn);
        snap.intentHints=routeHints(turn.text,snap.workers);
        const isMain=!snap.work&&!snap.attachedSession;
        const input=isMain?await this.followSnapshot(snap,turn):snap;
        let proposed=await this.followProposal(input);
        const leaving=snap.phase&&this.leftFollow(proposed,turn.text);
        if(leaving){
          // A topic change gets the normal planner with only this turn's grants.
          // Clear the pending row only when the replacement plan is committed.
          delete snap.phase;
          snap.follow={...snap.follow,pending:null,focus:null};
          proposed=await this.planner.plan(snap);
        }
        for(let attempt=0;attempt<2;attempt++){
          const types=proposed.actions.map(a=>a?.type);
          const card=types.some(t=>['chat_query','card_decision'].includes(t));
          const follow=types.some(t=>['follow_goal','pause_follow','dismiss_follow'].includes(t));
          if(card||follow||isMain&&(snap.follow?.pending||snap.phase==='focusedFollow')){
            if((card||follow)&&(types.length!==1||proposed.workControl)){
              this.store.transact(()=>this.store.finish(turn,'这次计划混合了不同操作，尚未执行。'));return;
            }
            if((card||follow)&&types[0]!=='chat_query'){
              const denied=await routeDecision(this.planner,turn,snap,proposed);
              if(denied){this.store.transact(()=>this.store.finish(turn,denied));return;}
            }
            if(card){await this.handleChatCard(turn,proposed,snap);return;}
            const outcome=isMain&&this.follow.handle(turn,proposed,snap);
            if(outcome){
              if(outcome.previewId)await this.refreshGoals(null,null,Date.now(),outcome.previewId);
              return;
            }
          }
          try{plan=this.check(turn,proposed,snap);}
          catch(error){
            if(attempt===0&&types.length){
              proposed=await this.planner.plan({...snap,routingCorrection:error.message});continue;
            }
            this.store.transact(()=>this.store.finish(turn,'尚未执行。'+error.message));return;
          }
          const review=await assessRoute(this.planner,turn,snap,plan);
          if(!review)break;
          if(attempt===0&&review.replan){
            proposed=await this.planner.plan({...snap,routingCorrection:review.message});continue;
          }
          this.store.transact(()=>this.store.finish(turn,review.message));return;
        }
        this.store.transact(()=>{
          if(isMain)this.follow.clear('main');
          this.store.savePlan(turn,plan);
        });
      }
      await this.apply(turn,plan);
    }catch(err){
      if(turn.attempts>=2 && !this.store.db.prepare('SELECT plan FROM turns WHERE id=?').get(turn.id)?.plan){
        this.store.transact(()=>this.store.finish(turn,'这次没有取得可用的模型回复，已保存你的消息。可以发“再试一次”继续。'));
      }else if(/工作范围已变化或工作已结束|步骤不属于当前工作范围/.test(err.message||'')){
        this.store.transact(()=>this.store.finish(turn,'这项工作的状态已变化。这次调整没有生效，请查看最新任务卡后再指定分工。'));
      }else if(turn.attempts>=4 && /Unsupported|Unknown worker|not support|Request ID already used|Unknown task|tombstone|cancelled before|Input task|attachment|artifact|handoff has been cancelled/i.test(err.message||'')){
        this.store.transact(()=>{
          const parent=this.store.db.prepare('SELECT parent FROM work_revisions WHERE turnId=?').get(turn.id)?.parent??turn.id;
          for(const step of this.store.work.evidence(parent))if(!step.taskId&&step.id.startsWith(turn.id+':'))this.store.work.stopUnsubmitted(step.id,'interrupted','派单未能提交');
          this.store.finish(turn,'有一步派单未能继续，先前已接单的任务会继续回报。',true);
        });
      }else this.store.defer(turn);
      console.error('personal turn retry:',err?.name||'Error');
    }finally{this.processing=false;}
  }
  async tick(){
    if(this.checking)return;this.checking=true;
    try{
      this.store.wake();
      this.flows.wake();
      await optional(()=>this.flows.advance(this.broker),null);
      const catalog=await optional(()=>this.broker('/workers'),null);
      if(!this.planner?.offline&&!this.reviewing&&!this.processing){
        this.reviewing=true;
        this.flows.processReview(this.planner,event=>this.snapshot({text:event.text,id:event.source,seq:Number.MAX_SAFE_INTEGER})).catch(()=>{}).finally(()=>{this.reviewing=false;});
      }
      if(Date.now()-this.lastObservation>=30000){
        const observedAt=Date.now();
        const rows=await optional(()=>this.contextRows('',500),null);
        this.lastObservation=observedAt;
        this.rowsAvailable=Array.isArray(rows);
        if(this.rowsAvailable){
          if(Array.isArray(catalog))await this.refreshGoals(rows,catalog,observedAt);
          const known=new Map(rows.map(row=>[row.machine+'|'+row.id,row]));
          const participants=this.store.continuity.participants();
          const watched=this.store.watchers().map(w=>({machine:w.machine,id:w.sessionId}));
          const selected=this.store.db.prepare('SELECT DISTINCT machine,sessionId AS id FROM turn_sources').all();
          const permitted=new Map([...participants,...watched,...selected].map(p=>[p.machine+'|'+p.id,p]));
          const visible=(await Promise.all(Array.from(permitted,([key,p])=>known.get(key)??optional(()=>this.exactSession(p),null)))).filter(Boolean);
          this.observedRows=merge([...visible,...rows.map(row=>({...row,evidence:[],summary:''}))]);
          this.store.observeSessions(visible);
          this.store.continuity.observeDesktop(visible.filter(row=>participants.some(p=>p.machine===row.machine&&p.id===row.id)&&!desktopHasBackfill(this.store,row)));
          const stamp=Date.now();
          const db=this.store.db;
          db.prepare("INSERT OR IGNORE INTO settings VALUES('overlapSince',?)").run(String(stamp));
          const since=Number(db.prepare("SELECT value FROM settings WHERE key='overlapSince'").get().value);
          for(const item of findSharedWork(visible,{since,now:stamp}))this.store.message(item.id,'assistant',item.text);
        }
      }
      const waiting=this.store.waiting();
      const workers=Array.isArray(catalog)?catalog:[];
      await this.rules.tick({rows:this.rowsAvailable?this.observedRows:undefined,workers:Array.isArray(catalog)?workers:undefined,broker:this.broker});
      for(const assignment of waiting){
        const task=await optional(()=>this.broker('/get',{id:assignment.id}),null);
        if(!task)continue;
        if(!this.store.work.order(assignment.turnId)){
          if(terminal.has(task.state))this.store.report(task,assignment);
          continue;
        }
        this.store.transact(()=>{
          this.store.work.observe(task,workers.find(w=>w.target===task.target));
          if(terminal.has(task.state))this.store.db.prepare('UPDATE assignments SET reported=1 WHERE id=?').run(task.id);
        });
      }
      if(this.rowsAvailable&&Array.isArray(catalog))await this.candidates.tick({rows:this.observedRows,workers,broker:this.broker,planner:this.planner});
      for(const watch of this.store.watchers()){
        const rows=await optional(()=>this.contextRows(watch.sessionId,4),null);
        if(!rows)continue;
        this.store.updateWatch(watch,rows.find(s=>s.machine===watch.machine&&s.id===watch.sessionId));
      }
    }finally{this.checking=false;}
  }
}
async function start(){
  process.umask(0o077);
  const contexts=await import('./context-read.mjs');
  const store=new PersonalStore(path.join(home,'personal.sqlite')),planner=selectPlanner(home);
  const agent=new PersonalAgent({store,planner,contexts});
  const grants=new WorkReadTickets();
  const socket=path.join(home,'personal.sock');
  fs.rmSync(socket,{force:true});
  const server=http.createServer(async(req,res)=>{
    try{
      if(req.method!=='POST')throw Error('POST required');
      let size=0;const parts=[];
      for await(const c of req){size+=c.length;if(size>180000)throw Error('请求过长');parts.push(c);}
      const input=JSON.parse(Buffer.concat(parts).toString()||'{}');
      let value;
      switch(req.url){
        case '/chat':value=await agent.receive(input);break;
        case '/contexts/desktopCursors':
        case '/contexts/desktopPage':value=desktopBackfill(store,req.url,input);break;
        case '/contexts/redeem':
        case '/contexts/catchUp':{
          const lookup=req.url==='/contexts/catchUp';
          const threadId=lookup?input.threadId:grants.resolve(input.machine,input.target,input.ticket);
          const items=threadId?store.continuity.catchUp(input.machine,input.target,threadId):[];
          const work=items.find(item=>item.threadId===threadId)??null;
          value={work};
          if(work&&lookup)value.ticket=grants.issue(input.machine,input.target,threadId);
          break;
        }
        case '/contexts/updates':value=store.continuity.pending(input.machine,input.target);break;
        case '/contexts/ack':value={acknowledged:store.continuity.ack(input.machine,input,input.target)};break;
        case '/board':value=await agent.board(input);break;
        case '/history':value=agent.history(input);break;
        case '/notifications':value=store.notifications(input);break;
        default:throw Error('Unknown operation');
      }
      res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({value}));
    }catch(e){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:e.message}));}
  });
  server.listen(socket,()=>fs.chmodSync(socket,0o600));
  const pass=fn=>fn().catch(e=>console.error('personal service check:',e.name));
  if(!planner.offline)setInterval(()=>pass(()=>agent.step()),700);
  setInterval(()=>pass(()=>agent.tick()),2500);
  if(!planner.offline)setInterval(()=>pass(()=>agent.deliver()),1100);
  if(!planner.offline)setInterval(()=>pass(()=>agent.workWake.advance({planner:agent.planner,broker:agent.broker})),5000);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await start();
