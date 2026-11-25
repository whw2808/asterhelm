import test from 'node:test';
import assert from 'node:assert/strict';
import {PersonalAgent} from './personal-service.mjs';
import {PersonalStore} from './personal-store.mjs';
import {configuredQueue} from './test-support/registered-queue.mjs';

test('main chat registers a standing rule, replays two independent receipts once and pauses from its original card',async t=>{
  const s=new PersonalStore(':memory:'),q=configuredQueue(':memory:');t.after(()=>{s.db.close();q.close();});
  let calls=0;
  const ruleText='每次新的目录校对任务失败都提醒我';
  const planner={plan:async()=>{calls++;return {reply:'',actions:[{type:'wake_rule',trigger:'task_failed',repeat:'each',effect:'notify',timing:'next',text:'核对目录',match:'目录校对',evidence:ruleText}]};}};
  const broker=async(route,body)=>route==='/workers'?q.workers():route==='/list'?q.list():route==='/wakeEvents'?q.wakeEvents(body):Promise.reject(Error('Unsupported route'));
  const agent=new PersonalAgent({store:s,planner,broker,contexts:{readContexts:()=>[],contextCoverage:()=>[]}});
  const first=await agent.receive({requestId:'create',text:ruleText});await agent.step();
  const get=()=>agent.history({around:first.id}).messages.find(m=>m.id===first.id)?.proactive?.[0];
  assert.equal(get()?.status,'active');
  const fail=i=>{const task=q.submit({requestId:'sample-'+i,prompt:'目录校对 '+i,target:'desk.code'});q.claim('desk.code');q.finish('desk.code',{id:task.id,state:'failed'});};
  fail(1);fail(2);await agent.tick();await agent.tick();
  assert.equal(s.notifications({}).items.length,2);
  const card=get(),text='星舵操作 '+card.id+' v'+card.version+' pause';
  await agent.receive({requestId:'pause',text});await agent.receive({requestId:'pause',text});
  assert.equal(get().status,'paused');assert.equal(calls,1);
  fail(3);await agent.tick();assert.equal(s.notifications({}).items.length,2);
});

test('a standing grant cannot turn into an immediate dispatch when planning loses the condition',async t=>{
  const s=new PersonalStore(':memory:'),q=configuredQueue(':memory:');t.after(()=>{s.db.close();q.close();});
  const text='每次新的春季目录校对任务失败都提醒我';
  let submit=0,plans=0;
  const broker=async(route,data)=>{if(route==='/submit'){submit++;return q.submit(data);}if(route==='/workers')return q.workers();
    if(route==='/list')return [];if(route==='/wakeEvents')return q.wakeEvents(data);};
  const agent=new PersonalAgent({store:s,broker,contexts:{readContexts:()=>[],contextCoverage:()=>[]},planner:{plan:async()=>{
    plans++;return {reply:'收到',actions:[{type:'consult',target:'desk.code',prompt:'马上查春季目录',evidence:text}]};}}});
  await agent.receive({requestId:'keep-waiting',text});await agent.step();assert.equal(submit,0);assert.equal(plans,2);
  assert.match(s.history({}).messages.at(-1).text,/条件|登记|触发/);
});

test('a durable event rule still notifies when the desktop index is unavailable',async t=>{
  const s=new PersonalStore(':memory:'),q=configuredQueue(':memory:');t.after(()=>{s.db.close();q.close();});
  const text='每次新的目录校对任务失败都提醒我';let unavailable=false;
  const contexts={readContexts:()=>{if(unavailable)throw Error('offline');return [];},contextCoverage:()=>[]};
  const broker=async(route,body)=>route==='/workers'?q.workers():route==='/list'?q.list():q.wakeEvents(body);
  const agent=new PersonalAgent({store:s,contexts,broker,planner:{plan:async()=>({reply:'',actions:[
    {type:'wake_rule',trigger:'task_failed',repeat:'each',effect:'notify',match:'目录校对',evidence:text}]})}});
  await agent.receive({requestId:'observe',text});await agent.step();
  const item=q.submit({target:'desk.code',prompt:'目录校对，独立校样'});q.claim('desk.code');q.finish(item.target,{id:item.id,state:'failed'});
  unavailable=true;await agent.tick();assert.equal(s.notifications().items.length,1);
});
