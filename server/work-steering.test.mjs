import {approveRoute} from './test-support/route-review.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {PersonalStore} from './personal-store.mjs';
import {PersonalAgent} from './personal-service.mjs';
import {configuredQueue} from './test-support/registered-queue.mjs';

const workers=['desk.code','bench.code'].map((target,index)=>({
  target,deviceId:target.split('.')[0],deviceName:index?'Bindery':'Studio',agentName:'Catalog Editor',capabilities:['read-only'],online:true,
}));
const contexts={readContexts:()=>[],contextCoverage:()=>[]};
function fixture(t) {
  const store=new PersonalStore(':memory:'),queue=configuredQueue(':memory:');
  t.after(()=>{store.db.close();queue.close();});
  const broker=async(route,body={})=>{
    switch(route){
      case '/workers':return workers;
      case '/list':return queue.list();
      case '/submit':return queue.submit(body);
      case '/get':return queue.get(body.id);
      case '/cancel':return queue.cancel(body.id);
      case '/cancelByRequestId':return queue.cancelByRequestId(body.requestId);
      default:throw Error('Unexpected route '+route);
    }
  };
  return {store,queue,broker};
}
test('single chat steers the existing order: a stopped branch is acknowledged and only retained evidence delivers',async t=>{
  const {store,queue,broker}=fixture(t);
  const paper='整理纸本目录',digital='整理电子目录',amend='电子版暂停，纸本继续';
  let delivery;
  const planner={plan:async snap=>{
    if(snap.phase==='routeAuthority')return approveRoute(snap);
    if(snap.phase==='delivery'){
      delivery=snap;
      return {reply:'纸本目录 CEDAR 已就绪。',actions:[],coverage:[{index:0,status:'answered',finding:'CEDAR',sources:[snap.results[0].id]}]};
    }
    if(snap.currentUser===amend){
      assert.equal(snap.activeWork.length,1);
      const order=snap.activeWork[0],step=order.tasks.find(s=>s.title===digital);
      return {reply:'',actions:[{type:'revise',id:order.id,evidence:amend,goal:'仅交付纸本目录',criteria:['核实纸本目录'],pauseStepIds:[step.id]},
        {type:'close',id:'unrelated-item',evidence:amend},{type:'review',text:'Unrequested recurring review',evidence:amend}]};
    }
    return {reply:'',criteria:[paper,digital],actions:workers.map((w,i)=>({type:'dispatch',target:w.target,title:i?digital:paper,prompt:i?digital:paper,evidence:i?digital:paper}))};
  }};
  const a=new PersonalAgent({store,queue,broker,planner,contexts});
  const first=store.receive({requestId:'book',text:paper+'，'+digital});await a.step();
  const print=queue.claim(workers[0].target),screen=queue.claim(workers[1].target);assert.ok(print&&screen);
  assert.doesNotMatch(print.prompt,new RegExp(digital));
  assert.doesNotMatch(screen.prompt,new RegExp(paper));
  await a.tick();const change=store.receive({requestId:'change',text:amend});
  assert.equal(store.heldForInput(first.id),true);
  await a.step();
  assert.equal(store.heldForInput(first.id),false);
  assert.equal(queue.get(print.id).cancelRequested,0);
  assert.equal(queue.get(screen.id).cancelRequested,1);
  let card=store.history().messages.find(m=>m.id==='reply-'+change.id)?.work;
  assert.equal(card.id,first.id);assert.equal(card.revision,1);
  assert.match(card.tasks.find(s=>s.taskId===screen.id).progress,/等待|已请求/);
  queue.finish(workers[1].target,{id:screen.id,state:'cancelled',result:'excluded'});
  await a.tick();await a.deliver();assert.equal(delivery,undefined);
  queue.finish(workers[0].target,{id:print.id,state:'succeeded',result:'CEDAR'});await a.tick();await a.deliver();
  card=store.work.card(first.id);
  assert.equal(card.state,'completed');
  assert.deepEqual(delivery.results.map(r=>r.id),[print.id]);
  assert.equal(delivery.originalQuestion,'仅交付纸本目录');
  assert.match(card.tasks.find(s=>s.taskId===screen.id).progress,/确认/);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM work_orders').get().n,1);
  assert.deepEqual(store.receive({requestId:'change',text:amend}),{id:change.id});
});
test('broker distinguishes worker cancellation from a late success excluded by a stop and prevents late personal submissions',t=>{
  const {queue}=fixture(t);
  const task=queue.submit({target:'bench.code',prompt:'Demo'});queue.claim('bench.code');queue.cancel(task.id);
  queue.finish('bench.code',{id:task.id,state:'succeeded',result:'old result'});
  assert.equal(queue.get(task.id).workerState,'succeeded');assert.equal(queue.get(task.id).state,'cancelled');
  const key='personal:fictional:1';
  queue.cancelByRequestId(key);
  assert.throws(()=>queue.submit({target:'bench.code',prompt:'Demo',requestId:key}));
});

test('an amendment can replace a branch on another registered worker and replay a lost submission receipt in one order',async t=>{
  const {store,queue,broker}=fixture(t);
  let loseResponse=true;
  const amended='把标签改交给装订台，继续做样张。';
  const original='整理标签和样张';
  const calls=[];
  const unstable=async(route,args)=>{
    const result=await broker(route,args);
    if(route==='/submit'&&args.title==='新标签'){
      calls.push(result.id);
      if(loseResponse){loseResponse=false;throw Error('ack lost');}
    }
    return result;
  };
  const planner={plan:async input=>{
    if(input.phase==='routeAuthority')return approveRoute(input);
    if(input.currentUser===original)return {reply:'',criteria:['标签','样张'],actions:['标签','样张'].map(title=>({
      type:'dispatch',target:workers[0].target,title,prompt:title,evidence:title}))};
    const order=input.activeWork[0];
    return {reply:'',actions:[
      {type:'revise',id:order.id,goal:'由装订台交付新标签，原样张继续',criteria:['新标签','样张'],pauseStepIds:[order.tasks.find(s=>s.title==='标签').id],evidence:'标签改交给装订台'},
      {type:'dispatch',target:workers[1].target,title:'新标签',prompt:'整理新标签',evidence:'标签改交给装订台'}
    ]};
  }};
  const agent=new PersonalAgent({store,broker:unstable,planner,contexts});
  const {id}=store.receive({requestId:'start',text:original});await agent.step();
  const change=store.receive({requestId:'change',text:amended});await agent.step();
  assert.equal(calls.length,1);
  // Replay the saved plan as the persisted scheduler would after its retry delay.
  store.db.prepare('UPDATE turns SET nextTry=0 WHERE id=?').run(change.id);
  await agent.step();
  assert.equal(calls.length,2);assert.equal(calls[0],calls[1]);
  const card=store.work.card(id);
  assert.equal(card.revision,1);assert.equal(card.tasks.length,3);
  assert.equal(card.tasks.find(s=>s.title==='标签').scope,'paused');
  assert.equal(card.tasks.find(s=>s.title==='样张').scope,'active');
  assert.equal(card.tasks.find(s=>s.title==='新标签').target,workers[1].target);
  assert.equal(queue.list().length,3);
  assert.equal(store.db.prepare('SELECT turnId FROM assignments WHERE id=?').get(calls[0]).turnId,id);
});

test('a partial stop cannot cancel the entire order even if the first model plan selects the parent',async t=>{
  const {store,queue,broker}=fixture(t);
  const text='暂停包装，索引继续',start='整理包装和索引';
  let repaired=0;
  const planner={plan:async input=>{
    if(input.phase==='routeAuthority')return input.proposals.some(p=>p.kind==='cancel')?
      {reply:'只撤包装，保留索引',directBasis:'replan',actions:[]}:approveRoute(input);
    if(input.currentUser===start)return {reply:'',criteria:['包装','索引'],actions:workers.map((w,i)=>({
      type:'consult',target:w.target,title:i?'索引':'包装',prompt:'核实项目',evidence:i?'索引':'包装'}))};
    const order=input.activeWork[0];
    if(!input.routingCorrection)return {reply:'',actions:[{type:'cancel',id:order.id,evidence:'暂停包装'}]};
    repaired++;
    return {reply:'',actions:[{type:'revise',id:order.id,evidence:text,goal:'只交付索引',criteria:['索引'],pauseStepIds:[order.tasks[0].id]}]};
  }};
  const service=new PersonalAgent({store,broker,planner,contexts});
  const parent=store.receive({text:start,requestId:'start'});await service.step();
  store.receive({text,requestId:'change'});await service.step();
  assert.equal(repaired,1);assert.equal(store.work.order(parent.id).state,'working');
  assert.equal(queue.list().filter(job=>job.state==='queued').length,1);
});

test('unsubmitted handoff producer and dependent both settle on scope withdrawal',async t=>{
  const {store,broker}=fixture(t);
  const {withdrawPausedSteps}=await import('./work-steering.mjs');
  const {id}=store.receive({text:'Arrange and proof',requestId:'two-stage'});
  store.work.create({id,text:'Arrange and proof'},['proof']);
  const first=id+':0';
  store.work.stage(id,first,workers[0],'dispatch','Arrange',false,false,'workspace-write');
  store.work.stage(id,first+':next',workers[1],'dispatch','Proof',false,true);
  store.work.revise(id,{id:'change',text:'withdraw'},{expectedRevision:0,goal:'withdraw',criteria:['withdraw'],pauseStepIds:[first,first+':next']});
  await withdrawPausedSteps({store,broker},id);
  assert.ok(store.work.evidence(id).every(s=>s.finishedAt&&!s.taskId));
});
