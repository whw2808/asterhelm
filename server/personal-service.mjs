import {WorkReadTickets} from './work-read-tickets.mjs';
import {desktopBackfill,desktopHasBackfill} from './desktop-backfill.mjs';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import {projectAliasesFor} from './registry.mjs';
import {actor,mentions,forbidDelegation,requireConsult} from './router-policy.mjs';
import {deliverWork} from './router-delivery.mjs';
import {PersonalStore} from './personal-store.mjs';
import {groupBoard} from './board-groups.mjs';
import {findSharedWork} from './personal-opportunities.mjs';
import {Flows} from './personal-flows.mjs';
import {selectPlanner} from './personal-model.mjs';
import {home,call} from './control.mjs';

const terminal=new Set(['succeeded','failed','interrupted','cancelled']);

const noChanges=/只读|只解释|只回答|只告诉|仅解释|先别做|不要(?:执行|修改|写入|改动|派单|运行|操作)|无需(?:操作|修改)|do not (?:edit|change|write|run|dispatch)|read[ -]only|explain only/i;
const explicitWrite=/生成|写入|创建|修改|改动|实现|制作|保存文件|写.{0,4}文件|make|creat|edit|writ|save|implement/i;
const clean=(s,n)=>typeof s==='string'?s.trim().slice(0,n):'';
const specific=(rows,id)=>rows.find(row=>row.id===id);
const optional=async(fn,fallback)=>{try{return await fn();}catch{return fallback;}};
function compact(row){return {machine:row.machine,target:row.target??null,id:row.id,title:clean(row.title,140),summary:clean(row.summary,720),cwd:clean(row.cwd,230),updatedAt:row.updatedAt,status:row.status,visibility:row.visibility,source:row.source,evidence:(row.evidence||[]).slice(-3).map(e=>({role:e.role,text:clean(e.text,460),at:e.at,turnId:e.turnId,itemId:e.itemId}))};}
function merge(rows){const list=new Map();for(const r of rows)if(r?.id&&!list.has(r.machine+'|'+r.id))list.set(r.machine+'|'+r.id,r);return [...list.values()];}
function plausibleDate(value){
  if(value==null||value==='')return null;
  if(typeof value!=='string'||!/(Z|[+-]\d\d:\d\d)$/.test(value)||!Number.isFinite(Date.parse(value)))throw Error('提醒时间缺少时区或日期无效');
  return new Date(value).toISOString();
}
function assert(ok,msg){if(!ok)throw Error(msg);}
export class PersonalAgent{
  constructor({store,planner,contexts,broker=call}){
    this.store=store;this.flows=new Flows(store);this.planner=planner;this.contexts=contexts;this.broker=broker;
    this.processing=false;this.checking=false;this.lastObservation=0;
  }
  async contextRows(query,limit=20){return await this.contexts.readContexts(home,{query,limit});}
  async exactSession({machine,id}){
    if(typeof machine!=='string'||typeof id!=='string')return null;
    if(this.contexts.readSession)return this.contexts.readSession(home,machine,id);
    return (await this.contextRows(id,5)).find(row=>row.machine===machine&&row.id===id)??null;
  }
  async board({layout}={}){
    const [workers,tasks,sessions,coverage]=await Promise.all([
      optional(()=>this.broker('/workers'),[]),optional(()=>this.broker('/list'),[]),
      this.contextRows('',500),this.contexts.contextCoverage(home)]);
    const rows={workers,tasks:this.store.visibleTasks(tasks),sessions:sessions.map(({evidence,...s})=>s),coverage};
    return {...(layout==='machines'?groupBoard(rows):rows),coverage,
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
    const activeWork=this.store.db.prepare(`SELECT w.id,m.text FROM work_orders w JOIN messages m ON m.id=w.id
      LEFT JOIN continuity_turns c ON c.turnId=w.id WHERE w.state IN ('working','synthesizing')
      AND (? IS NULL OR c.workId=?) ORDER BY m.seq DESC LIMIT 12`).all(workId,workId);
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
    return {project,work,activeWork,attachedSession:source?{...source,found:!!attached}:null,now:new Date().toISOString(),timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone,currentUser:turn.text,
      preferences:preferences.slice(0,120),commitments:commitments.slice(0,100),
      history:this.store.previous(turn.seq,turn.id),sessions,coverage,workers:catalog,
      lastMentioned:participants??this.store.lastLinks(),tasks:this.store.visibleTasks(queue).filter(t=>!inScope||inScope.has(t.id)).slice(0,22)};
  }
  check(turn,plan,snap){
    const workers=snap.workers||[];
    const registered=target=>workers.find(w=>w.target===target&&w.deviceId);
    const criteria=Array.isArray(plan.criteria)?plan.criteria.filter(x=>typeof x==='string'&&x.trim()).slice(0,6).map(x=>clean(x,480)):[];
    if(!criteria.length){
      criteria.push(turn.text);
      if(/对比|比较|区别|差异|\bcompare\b/i.test(turn.text))criteria.push('对比双方各自的依据与关键差异','结合用户的目标说明可沿用的做法、具体改动和仍待验证之处');
    }
    const refs=(snap.attachedSession?.found?[snap.attachedSession,...(plan.references||[])]:plan.references||[]).map(r=>snap.sessions.find(s=>r?.id===s.id&&r.machine===s.machine)).filter(Boolean);
    const actions=[];
    for(const a of plan.actions){
      assert(a&&typeof a==='object'&&typeof a.evidence==='string'&&a.evidence.trim().length>=2&&turn.text.includes(a.evidence),'操作缺少来自你本条消息的依据');
      const text=clean(a.text,1500);
      switch(a.type){
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
          actions.push({type:'remember',key,scope,text});break;
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
          assert(!forbidDelegation.test(turn.text),'当前消息要求直接解释或暂缓执行');
          assert(!write||(!noChanges.test(turn.text)&&explicitWrite.test(turn.text)),'本条消息没有允许创建或修改文件');
          if(attached&&attached.machine!==worker.deviceId)assert(mentions(turn.text,worker),'所选会话与执行设备不一致');
          if(attached&&attached.machine===worker.deviceId&&sourceId)assert(attached.id===sourceId,'指定会话与所选会话不一致');
          const context=row?'\n来源会话，只读资料：'+JSON.stringify(compact(row)):'';
          const objective='\n本次原问题：'+turn.text+'\n整项交付要求：'+JSON.stringify(criteria)+'\n请完成本次分工，结论区分已查实与推断，标注关键依据；允许材料不足，说明具体缺口。';
          actions.push({type:a.type,target:worker.target,actor:actor(worker),title:clean(a.title||prompt.split('\n')[0],90),
            prompt:prompt+objective+context,mode,notify:a.notify===true});break;
        }
        case 'handoff':{
          assert(!noChanges.test(turn.text)&&!forbidDelegation.test(turn.text),'当前请求没有授权跨机写入产物');
          const from=registered(a.from),to=registered(a.to);
          assert(from?.capabilities?.includes('workspace-write')&&from.capabilities.includes('handoff')&&to?.capabilities?.includes('read-only')&&to.capabilities.includes('handoff')&&a.from!==a.to&&clean(a.first,6000)&&clean(a.second,6000),'两阶段交接需要可执行的端点和清晰目标');
          assert(/交给|交接|接力|另一|再让|然后|核对|handoff|pass|transfer|both/i.test(turn.text),'当前要求未指定跨端接力');
          actions.push({type:'handoff',from:a.from,to:a.to,firstActor:actor(from),secondActor:actor(to),first:clean(a.first,6000),second:clean(a.second,6000),notify:a.notify===true});break;
        }
        case 'review':{
          const due=plausibleDate(a.dueAt),days=Number(a.intervalDays??0);
          assert(text&&due&&[0,1,7].includes(days),'复查规则缺少明确时间');
          actions.push({type:'review',text,dueAt:due,days});break;
        }
        case 'cancel':assert(this.flows.ownedFirst(a.id)||this.store.waiting().some(x=>x.id===a.id)||snap.activeWork?.some(x=>x.id===a.id),'这项任务不属于当前助手或已结束');actions.push({type:a.type,id:a.id});break;
        default:throw Error('模型提出了当前版本不支持的操作');
      }
    }
    const used=snap.preferences.filter(p=>(plan.usedPreferences||[]).includes(p.id)||plan.reply.includes(p.text)).map(({key,scope})=>({key,scope}));
    return {reply:clean(plan.reply,14000),actions,criteria,used,refs:refs.map(r=>({machine:r.machine,id:r.id}))};
  }
  async apply(turn,plan){
    const results=[];
    const work=this.store.work;
    const delegated=plan.actions.some(a=>['consult','dispatch','handoff'].includes(a.type));
    if(delegated && plan.actions.some(a=>(['consult','dispatch'].includes(a.type)&&!a.actor)||(a.type==='handoff'&&!a.firstActor))){
      const catalog=await this.broker('/workers');
      const resolve=target=>{const worker=catalog.find(w=>w.target===target);assert(worker,'Unknown worker');return actor(worker);};
      for(const a of plan.actions){
        if(a.type==='handoff'){a.firstActor=resolve(a.from);a.secondActor=resolve(a.to);}
        else if(a.type==='consult'||a.type==='dispatch'){a.actor=resolve(a.target);a.title=a.title||clean(a.prompt,90);}
      }
    }
    if(delegated)this.store.transact(()=>{
      work.create(turn,plan.criteria||[turn.text]);
      for(const [i,a] of plan.actions.entries()){
        const key=turn.id+':'+i;
        if(a.type==='handoff'){
          work.stage(turn.id,key,a.firstActor,'dispatch',clean(a.first,90),a.notify);
          work.stage(turn.id,key+':next',a.secondActor,'dispatch',clean(a.second,90),a.notify,true);
        }else if(a.type==='consult'||a.type==='dispatch')work.stage(turn.id,key,a.actor,a.type,a.title,a.notify);
      }
    });
    for(const [i,a] of plan.actions.entries()){
      const old=this.store.effect(turn.id,i);
      if(old){
        results[i]=old.result;
        if(delegated&&['consult','dispatch','handoff'].includes(a.type)){
          const key=turn.id+':'+i,step=work.evidence(turn.id).find(s=>s.id===key);
          if(step&&!step.taskId){const task=await this.broker('/get',{id:old.result});this.store.transact(()=>{work.bind(key,task);this.store.track(task.id,turn,a.notify);});}
        }
        continue;
      }
      if(a.type==='dispatch'||a.type==='consult'){
        const result=await this.broker('/submit',{...a,requestId:'personal:'+turn.id+':'+i});
        results[i]=result.id;
        this.store.transact(()=>{work.bind(turn.id+':'+i,result);this.store.track(result.id,turn,a.notify);this.store.ackEffect(turn.id,i,result.id);});
      }else if(a.type==='handoff'){
        const first=await this.broker('/submit',{target:a.from,prompt:a.first,mode:'workspace-write',exportFile:true,requestId:'personal:'+turn.id+':'+i});
        results[i]=first.id;
        this.store.transact(()=>{work.bind(turn.id+':'+i,first);this.store.track(first.id,turn,false);this.flows.handoff(first.id,turn,a);this.store.ackEffect(turn.id,i,first.id);});
      }else if(a.type==='cancel'){
        const parent=work.order(a.id);
        if(parent){
          this.store.transact(()=>{
            work.setState(a.id,'cancelled');
            for(const s of work.evidence(a.id))if(!s.taskId)work.stopUnsubmitted(s.id,'cancelled','已取消');
          });
          for(const s of work.evidence(a.id)){
            if(!s.taskId)continue;
            if(this.flows.stopFlow(s.taskId))await this.broker('/cancelByRequestId',{requestId:'handoff:'+s.taskId});
            if(!s.finishedAt)await this.broker('/cancel',{id:s.taskId});
          }
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
      if(delegated){
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
  async step(){
    if(this.processing)return;
    const turn=this.store.pending();
    if(!turn||Number(turn.nextTry)>Date.now())return;
    this.processing=true;
    try{
      let plan=turn.plan?JSON.parse(turn.plan):null;
      if(!plan){
        const snap=await this.snapshot(turn);
        const proposed=await this.planner.plan(snap);
        try{plan=this.check(turn,requireConsult(turn,snap,proposed),snap);}
        catch(e){this.store.transact(()=>this.store.finish(turn,'我还没有执行这一步。'+e.message+'。请补充具体要求。'));return;}
        this.store.savePlan(turn,plan);
      }
      await this.apply(turn,plan);
    }catch(err){
      if(turn.attempts>=2 && !this.store.db.prepare('SELECT plan FROM turns WHERE id=?').get(turn.id)?.plan){
        this.store.transact(()=>this.store.finish(turn,'这次没有取得可用的模型回复，已保存你的消息。可以发“再试一次”继续。'));
      }else if(turn.attempts>=4 && /Unsupported|Unknown worker|not support|Request ID already used|Unknown task|tombstone|cancelled before|Input task|attachment|artifact|handoff has been cancelled/i.test(err.message||'')){
        this.store.transact(()=>{
          for(const step of this.store.work.evidence(turn.id))if(!step.taskId)this.store.work.stopUnsubmitted(step.id,'interrupted','派单未能提交');
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
      await this.flows.advance(this.broker);
      if(!this.planner?.offline&&!this.reviewing&&!this.processing){
        this.reviewing=true;
        this.flows.processReview(this.planner,event=>this.snapshot({text:event.text,id:event.source,seq:Number.MAX_SAFE_INTEGER})).catch(()=>{}).finally(()=>{this.reviewing=false;});
      }
      if(Date.now()-this.lastObservation>=30000){
        const rows=await this.contextRows('',500);
        this.store.observeSessions(rows);
        const known=new Map(rows.map(row=>[row.machine+'|'+row.id,row]));
        const visible=await Promise.all(this.store.continuity.participants().map(p=>known.get(p.machine+'|'+p.id)??this.exactSession(p)));
        this.store.continuity.observeDesktop(visible.filter(row=>row&&!desktopHasBackfill(this.store,row)));
        const stamp=Date.now();
        const db=this.store.db;
        db.prepare("INSERT OR IGNORE INTO settings VALUES('overlapSince',?)").run(String(stamp));
        const since=Number(db.prepare("SELECT value FROM settings WHERE key='overlapSince'").get().value);
        for(const item of findSharedWork(rows,{since,now:stamp}))this.store.message(item.id,'assistant',item.text);
        this.lastObservation=stamp;
      }
      const waiting=this.store.waiting();
      const workers=waiting.length?await optional(()=>this.broker('/workers'),[]):[];
      for(const assignment of waiting){
        const task=await this.broker('/get',{id:assignment.id});
        if(!this.store.work.order(assignment.turnId)){
          if(terminal.has(task.state))this.store.report(task,assignment);
          continue;
        }
        this.store.transact(()=>{
          this.store.work.observe(task,workers.find(w=>w.target===task.target));
          if(terminal.has(task.state))this.store.db.prepare('UPDATE assignments SET reported=1 WHERE id=?').run(task.id);
        });
      }
      for(const watch of this.store.watchers()){
        const rows=await this.contextRows(watch.sessionId,4);
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
        case '/chat':
          if(planner.offline)throw Error('聊天模型尚未启用。请在服务器配置模型并重启助手。');
          {
            const row=input.context ? await agent.exactSession(input.context) : null;
            if(input.context&&!row)throw Error('当前索引里找不到所选会话');
            value=store.receive(input,row);break;
          }
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
        case '/history':value=store.history(input);break;
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
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await start();
