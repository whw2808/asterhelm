import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PersonalStore} from './personal-store.mjs';
import {PersonalAgent} from './personal-service.mjs';
import {configuredQueue} from './test-support/registered-queue.mjs';
import {approveRoute} from './test-support/route-review.mjs';
import {checkedWorkControl,WorkWake} from './work-wake.mjs';
import {deliverWork} from './router-delivery.mjs';

const worker={target:'gallery.proof',deviceId:'gallery',deviceName:'Gallery',agentName:'Proofreader',online:true,capabilities:['read-only','workspace-write']};
function setup(t,{text='持续核对纸本展品目录，直到两本都核对完成。',stopCondition='两本都核对完成'}={}){
  t.mock.timers.enable({apis:['Date'],now:Date.parse('2030-01-01T12:00:00Z')});
  const store=new PersonalStore(':memory:'),clock=new WorkWake(store),turn=store.receive({requestId:'exhibit',text});t.after(()=>store.db.close());
  store.work.create(turn,['两本都核对完成']);store.work.stage(turn.id,'paper',worker,'consult','纸本目录');
  store.work.bind('paper',{id:'paper-1',target:worker.target,state:'succeeded',result:'第一本已核对，第二本等待清单。'});store.finish(turn,'已接单。');
  clock.registerGoal(turn,turn.id,stopCondition?{mode:'until',evidence:text,stopCondition}:undefined);
  let calls=0,submits=0,nextResult='第一本已核对，第二本等待清单。';
  const broker=async(route,data)=>{if(route==='/workers')return [worker];assert.equal(route,'/submit');assert.equal(data.mode,'read-only');submits++;
    return {id:'receipt-'+submits,target:worker.target,state:'succeeded',result:nextResult};};
  const defaults=input=>{calls++;const done=input.results.find(r=>r.result==='已核对两本纸本目录。');
    return done?{reply:'已核对两本。',coverage:[{index:0,status:'answered',finding:'两本齐备',sources:[done.id]}],actions:[]}:
      {reply:'仍在等第二本。',coverage:[{index:0,status:'missing',finding:'第二本尚未核对',sources:[]}],actions:[{type:'consult',target:worker.target,prompt:'只读检查纸本清单。'}]};};
  return {store,turn,clock,get calls(){return calls;},get submits(){return submits;},receipt(text){nextResult=text;},
    deliver(plan=defaults){return deliverWork({store,broker,workWake:clock,planner:{plan}});},
    due(){const next=clock.card(turn.id)?.nextWakeAt;assert.ok(next);const wait=Date.parse(next)-Date.now();assert.ok(wait>=30000);t.mock.timers.tick(wait);return wait;}};
}
test('an explicit continuing goal survives identical receipts and waits increasingly long before working again until acceptance',async t=>{
  const f=setup(t);let lastWait=0;
  for(let i=0;i<3;i++){
    await f.deliver();if(!f.store.work.order(f.turn.id).decision){const wait=f.due();assert.ok(wait>=lastWait);lastWait=wait;await f.deliver();}
    if(i===2)f.receipt('已核对两本纸本目录。');await f.deliver();assert.equal(f.submits,i+1);
  }
  await f.deliver();assert.equal(f.store.work.order(f.turn.id).state,'completed');assert.equal(f.clock.card(f.turn.id)?.nextWakeAt??null,null);
  assert.equal(f.store.continuity.workForTurn(f.turn.id),f.turn.id);const count=f.calls;await f.deliver();assert.equal(f.calls,count);
});
test('a continuous goal without a supported next action retains its check and advances early on a newly linked desktop result',async t=>{
  const f=setup(t);let calls=0;
  const missing=()=>{calls++;return {reply:'仍缺第二本纸本目录。',coverage:[{index:0,status:'missing',finding:'缺少证据',sources:[]}],actions:[]};};
  await f.deliver(missing);await f.deliver(missing);assert.equal(calls,1);assert.equal(f.store.work.order(f.turn.id).state,'working');
  const id='00000000-0000-4000-8000-000000000123';const linked=f.store.receive({requestId:'join',text:'接收展览工作摘要',context:{machine:worker.deviceId,id},workId:f.turn.id},{machine:worker.deviceId,target:worker.target,id});f.store.finish(linked,'已关联。');
  const at=new Date(Date.now()+1000).toISOString();f.store.continuity.observeDesktop([{id,machine:worker.deviceId,target:worker.target,title:'纸本展览',archived:false,
    evidence:[{role:'assistant',text:'已核对两本纸本目录。',turnId:'checked',itemId:'proof',at}]}]);
  await f.clock.advance({planner:{plan:missing},broker:async()=>[worker]});await f.deliver();assert.equal(f.store.work.order(f.turn.id).state,'completed');
});
test('a new permission or user decision suspends an ongoing goal without an automatic retry or write',async t=>{
  const f=setup(t);
  await f.deliver(()=>({reply:'请你批准将目录写入新的设备。',coverage:[{index:0,status:'missing',finding:'需要新的写入权限',sources:[]}],
    actions:[{type:'dispatch',target:'unknown',write:true,prompt:'改写纸本目录。'}]}));
  assert.equal(f.store.work.order(f.turn.id).state,'paused');assert.equal(f.submits,0);
  t.mock.timers.tick(86400000);await f.deliver();assert.equal(f.calls,0);
});
test('a question quoting a continuous request cannot extend an ordinary work beyond its two follow-ups',async t=>{
  const f=setup(t,{text:'解释“持续核对直到两本完成”是什么意思？',stopCondition:null});for(let i=0;i<7;i++)await f.deliver();
  assert.equal(f.store.work.order(f.turn.id).state,'partial');assert.equal(f.submits,2);
});
test('the explicit end condition must be checked even if the original planner reduced the work criteria',async t=>{
  const f=setup(t,{text:'持续核对纸本展品目录，直到两本签名册和封面都核验完毕。',stopCondition:'两本签名册和封面都核验完毕'});
  assert.ok(JSON.parse(f.store.work.order(f.turn.id).criteria).includes('两本签名册和封面都核验完毕'));
  const revision=f.store.receive({requestId:'paper-scope',text:'先停电子版本，只核对纸本两册，完成后交给我。'});
  f.store.work.revise(f.turn.id,{...revision,text:'先停电子版本，只核对纸本两册，完成后交给我。'},
    {expectedRevision:0,goal:'核对纸本两册',criteria:['纸本两册已经核验']});
  f.clock.registerGoal(revision,f.turn.id);assert.equal(f.clock.goal(f.turn.id).stopCondition,'纸本两册已经核验');
});

test('the same authenticated request gets an ordinary budget unless its plan explicitly grants ongoing work',t=>{
  const f=setup(t,{text:'Keep checking the proof until every sheet is signed.',stopCondition:null});
  assert.equal(f.clock.goal(f.turn.id),undefined);
  const request='Ce tirage est sous ta responsabilité. Reviens vers moi une fois chaque feuille signée, compris ?';
  const revision=f.store.receive({requestId:'signed',text:request});
  const control={mode:'until',evidence:request,stopCondition:'chaque feuille signée'};
  f.clock.registerGoal(revision,f.turn.id,control);
  assert.equal(f.clock.goal(f.turn.id),undefined);
  f.store.work.revise(f.turn.id,{...revision,text:request},{expectedRevision:0,goal:'Relire le tirage',criteria:['compter les feuilles']});
  f.clock.registerGoal(revision,f.turn.id,control);
  assert.equal(f.clock.goal(f.turn.id).origin,revision.id);
  assert.deepEqual(JSON.parse(f.store.work.order(f.turn.id).criteria),['compter les feuilles','chaque feuille signée']);
  f.clock.registerGoal(revision,f.turn.id,control);
  assert.equal(JSON.parse(f.store.work.order(f.turn.id).criteria).length,2);
});

test('an ongoing goal only pauses for the structured hold on an accepted revision',t=>{
  const f=setup(t);
  f.clock.registerGoal(f.turn,f.turn.id,{mode:'pause',evidence:'纸本展品目录'});
  assert.equal(f.store.work.order(f.turn.id).state,'working');
  const revise=(requestId,text,expectedRevision)=>{
    const turn=f.store.receive({requestId,text});
    f.store.work.revise(f.turn.id,{...turn,text},{expectedRevision,goal:'核对纸本',criteria:['纸本齐备']});
    return turn;
  };
  const quote=revise('quote','目录标题改为《等我确认》。',0);
  f.clock.registerGoal(quote,f.turn.id);
  assert.equal(f.store.work.order(f.turn.id).state,'working');
  const text='Giữ việc này ở đây cho đến khi tôi phản hồi.';
  const hold=revise('hold',text,1);
  f.clock.registerGoal(hold,f.turn.id,{mode:'pause',evidence:text});
  assert.equal(f.store.work.order(f.turn.id).state,'paused');
  assert.equal(f.clock.goal(f.turn.id).scopeRevision,2);
  f.clock.registerGoal(quote,f.turn.id,{mode:'until',evidence:'目录标题',stopCondition:'旧版已签字'});
  assert.equal(f.clock.goal(f.turn.id).stopCondition,'纸本齐备');
});

test('a stored goal and its backoff survive restart and replay even without control metadata in an older plan',()=>{
  const directory=mkdtempSync(join(tmpdir(),'gallery-goal-')),filename=join(directory,'chat.db');
  let store=new PersonalStore(filename);
  try{
    let clock=new WorkWake(store);
    const text='Aim for a signed proof on every page.',turn=store.receive({requestId:'proof',text});
    store.work.create(turn,['every page signed']);
    const control={mode:'until',evidence:text,stopCondition:'every page signed'};
    clock.registerGoal(turn,turn.id,control);
    clock.waitForEvidence(store.work.order(turn.id),'proof-count','Waiting for the second proof');
    const before=clock.goal(turn.id),card=clock.card(turn.id);
    store.db.close();store=new PersonalStore(filename);clock=new WorkWake(store);
    clock.registerGoal(turn,turn.id);
    clock.registerGoal(turn,turn.id,control);
    assert.deepEqual(clock.goal(turn.id),before);
    assert.deepEqual(clock.card(turn.id),card);
  }finally{store.db.close();rmSync(directory,{recursive:true,force:true});}
});

test('a linked instruction may extend an active order and replaying its older grant cannot roll it back',t=>{
  const f=setup(t);
  const session={machine:worker.deviceId,id:'00000000-0000-4000-8000-000000000456'};
  const text='Include the third proof in the final count.';
  const next=f.store.receive({requestId:'add-proof',text,context:session,workId:f.turn.id},{...session,target:worker.target});
  f.clock.registerGoal(next,f.turn.id,{mode:'until',evidence:text,stopCondition:'all three proofs signed'});
  assert.equal(f.clock.goal(f.turn.id).origin,next.id);
  f.clock.registerGoal(f.turn,f.turn.id,{mode:'until',evidence:'两本都核对完成',stopCondition:'两本都核对完成'});
  assert.equal(f.clock.goal(f.turn.id).stopCondition,'all three proofs signed');
});

test('delivery holds use the structured waiting decision even when reply wording suggests the opposite',async t=>{
  const f=setup(t);
  const report=(reply,awaitingUser)=>({reply,awaitingUser,actions:[],coverage:[{index:0,status:'missing',finding:'缺少证据',sources:[]}]});
  await f.deliver(()=>report('请你批准是旧目录上的页眉。仍缺第二本。',false));
  assert.equal(f.store.work.order(f.turn.id).state,'working');
  f.due();
  await f.deliver(()=>report('À vous de choisir le volume.',true));
  assert.equal(f.store.work.order(f.turn.id).state,'paused');
  assert.equal(f.clock.card(f.turn.id).nextWakeAt,undefined);
});

test('ongoing controls must use current-turn evidence and a bounded stop condition',()=>{
  const text='Review each new edition through the final proof.';
  const valid={mode:'until',evidence:text,stopCondition:'the final proof'};
  assert.deepEqual(checkedWorkControl(valid,text),valid);
  assert.equal(checkedWorkControl(undefined,text),undefined);
  for(const control of [{...valid,evidence:'earlier request'},{...valid,evidence:' '},{...valid,stopCondition:null},
    {...valid,stopCondition:'x'.repeat(481)},{...valid,mode:'maybe'}]){
    assert.throws(()=>checkedWorkControl(control,text));
  }
});

test('a whole-work pause reviews and withdraws running, queued and unbound assignments while a partial pause preserves the other branches',async t=>{
  for(const whole of [true,false]){
    const store=new PersonalStore(':memory:'),queue=configuredQueue(':memory:');
    t.after(()=>{store.db.close();queue.close();});
    const broker=async(route,args={})=>{
      if(route==='/workers')return queue.workers();
      if(route==='/list')return queue.list();
      if(route==='/wakeEvents')return queue.wakeEvents(args);
      if(route==='/cancel')return queue.cancel(args.id);
      if(route==='/cancelByRequestId')return queue.cancelByRequestId(args.requestId);
      throw Error(route);
    };
    const start='Keep the exhibition project going through final proof.';
    const order=store.receive({requestId:'open',text:start});
    const requested=whole?'Put the whole exhibition on hold until I decide.':'Hold the index only. Carry on with the booklet and other assignments.';
    const reviewed=[];
    const planner={plan:async input=>{
      if(input.phase==='routeAuthority'){
        const proposal=input.proposals.find(p=>p.kind==='revise');
        reviewed.push(proposal.pauseStepIds.slice().sort());
        if(!whole&&input.proposals.some(p=>p.kind==='work_control'))return {reply:'Retain the booklet and pause only the index.',directBasis:'replan',actions:[]};
        return approveRoute(input);
      }
      // The first proposal always omits some branches from a whole-work hold.
      const hold=input.routingCorrection?undefined:{mode:'pause',evidence:requested};
      return {reply:'',workControl:hold,actions:[{type:'revise',id:order.id,goal:'Exhibition proof',criteria:['Final proof'],
        pauseStepIds:['index'],evidence:requested}]};
    }};
    const agent=new PersonalAgent({store,planner,broker,contexts:{readContexts:()=>[],contextCoverage:()=>[]}});
    store.work.create(order,['Final proof']);
    agent.workWake.registerGoal(order,order.id,{mode:'until',evidence:start,stopCondition:'Final proof'});
    const desk=queue.workers().find(w=>w.target==='desk.code'),bench=queue.workers().find(w=>w.target==='bench.code');
    const stage=(key,worker,options={})=>{
      store.work.stage(order.id,key,worker,'dispatch',key,false,false,options.mode);
      const task=queue.submit({target:worker.target,prompt:key,requestId:'personal:'+key,...options});
      store.work.bind(key,task);return task;
    };
    const finished=stage('cover',desk);queue.claim(desk.target);queue.finish(desk.target,{id:finished.id,state:'succeeded',result:'cover verified'});
    store.work.observe(queue.get(finished.id));
    const booklet=stage('booklet',desk,{mode:'workspace-write',exportFile:true});
    store.work.observe(queue.claim(desk.target));
    store.work.stage(order.id,'booklet:next',bench,'consult','review booklet',false,true);
    agent.flows.handoff(booklet.id,order,{to:bench.target,second:'review booklet'});
    const index=stage('index',bench);
    store.work.stage(order.id,'appendix',desk,'consult','appendix');
    store.finish(order,'Exhibition started.');
    const change=await agent.receive({requestId:'amend',text:requested});await agent.step();
    const all=['appendix','booklet','booklet:next','index'];
    assert.deepEqual(reviewed,whole?[all]:[all,['index']]);
    assert.equal(store.work.order(order.id).state,whole?'paused':'working');
    assert.equal(queue.get(index.id).state,'cancelled');
    assert.equal(queue.get(booklet.id).state,'running');
    assert.equal(queue.get(booklet.id).cancelRequested,whole?1:0);
    const steps=store.work.evidence(order.id);
    assert.deepEqual(steps.filter(s=>s.scope==='paused').map(s=>s.id).sort(),whole?all:['index']);
    assert.equal(steps.find(s=>s.id==='cover').result,'cover verified');
    assert.equal(store.db.prepare('SELECT state FROM handoffs WHERE first=?').get(booklet.id).state,whole?'scope_paused':'waiting');
    for(const [key,requestId] of [['appendix','personal:appendix'],['booklet:next','handoff:'+booklet.id]]){
      assert.equal(steps.find(s=>s.id===key).state,whole?'cancelled':'queued');
      assert.equal(Boolean(queue.db.prepare('SELECT 1 FROM stopped_handoffs WHERE requestId=?').get(requestId)),whole);
    }
    assert.ok(store.history().messages.some(m=>m.id==='reply-'+change.id));
  }
});
