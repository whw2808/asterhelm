import test from 'node:test';
import assert from 'node:assert/strict';
import {PersonalStore} from './personal-store.mjs';
import {WorkWake} from './work-wake.mjs';
import {deliverWork} from './router-delivery.mjs';

const worker={target:'gallery.proof',deviceId:'gallery',deviceName:'Gallery',agentName:'Proofreader',online:true,capabilities:['read-only','workspace-write']};
function setup(t,text='持续核对纸本展品目录，直到两本都核对完成。'){
  t.mock.timers.enable({apis:['Date'],now:Date.parse('2030-01-01T12:00:00Z')});
  const store=new PersonalStore(':memory:'),clock=new WorkWake(store),turn=store.receive({requestId:'exhibit',text});t.after(()=>store.db.close());
  store.work.create(turn,['两本都核对完成']);store.work.stage(turn.id,'paper',worker,'consult','纸本目录');
  store.work.bind('paper',{id:'paper-1',target:worker.target,state:'succeeded',result:'第一本已核对，第二本等待清单。'});store.finish(turn,'已接单。');
  assert.equal(typeof clock.registerGoal,'function','continuous goals must have an explicit durable registration');clock.registerGoal(turn,turn.id);
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
  const f=setup(t,'解释“持续核对直到两本完成”是什么意思？');for(let i=0;i<7;i++)await f.deliver();
  assert.equal(f.store.work.order(f.turn.id).state,'partial');assert.equal(f.submits,2);
});
test('the explicit end condition must be checked even if the original planner reduced the work criteria',async t=>{
  const f=setup(t,'持续核对纸本展品目录，直到两本签名册和封面都核验完毕。');
  assert.ok(JSON.parse(f.store.work.order(f.turn.id).criteria).includes('两本签名册和封面都核验完毕'));
  const revision=f.store.receive({requestId:'paper-scope',text:'先停电子版本，只核对纸本两册，完成后交给我。'});
  f.store.work.revise(f.turn.id,{...revision,text:'先停电子版本，只核对纸本两册，完成后交给我。'},
    {expectedRevision:0,goal:'核对纸本两册',criteria:['纸本两册已经核验']});
  f.clock.registerGoal(revision,f.turn.id);assert.equal(f.clock.goal(f.turn.id).stopCondition,'纸本两册已经核验');
});
