import test from 'node:test';
import assert from 'node:assert/strict';
import {PersonalStore} from './personal-store.mjs';
import {WorkWake} from './work-wake.mjs';
const base=Date.parse('2030-01-01T12:00:00Z');
const worker={deviceId:'studio',deviceName:'Studio',agentName:'Proof',target:'studio.proof',online:true,capabilities:['read-only']};
const other={...worker,target:'desk.proof',deviceId:'desk'};
function fixture() {
  const s=new PersonalStore(':memory:');
  const t=s.receive({requestId:'open',text:'核对两份展览目录'}), w=s.work;
  w.create({...t,text:'核对两份展览目录'},['纸本齐备']); w.stage(t.id,'a',worker,'consult','纸本',false);
  w.bind('a',{id:'A',state:'running'});w.stage(t.id,'b',other,'consult','目录',false);
  w.bind('b',{id:'B',state:'running'});s.finish(t,'已派单');
  return {s,t,w};
}
test('work plans its next check, wakes early on evidence, and queues at most one authorized follow-up',async()=>{
  const {s,t,w}=fixture(); const clock=new WorkWake(s);
  let calls=0;
  const planner={plan:async input=>{calls++;return {reply:'等待另一份目录',actions:input.completed.length?
    [{type:'consult',stepId:'a',target:worker.target,title:'补齐页数',prompt:'核对刚交回目录中遗漏的页数'}]:[],nextCheckSeconds:600};}};
  const args={planner,broker:async()=>[worker,other],now:base};
  await clock.advance(args);
  assert.equal(calls,1);assert.equal(clock.card(t.id).nextWakeAt,new Date(base+600000).toISOString());
  await clock.advance({...args,now:base+1000});assert.equal(calls,1);
  w.observe({id:'A',state:'succeeded',result:'第2页页数待核对',updated:new Date(base+2000).toISOString(),finishedAt:new Date(base+2000).toISOString()},worker);
  await clock.advance({...args,now:base+2000});assert.equal(calls,2);
  assert.equal(w.evidence(t.id).length,3);assert.equal(w.evidence(t.id).at(-1).mode,'read-only');
  await clock.advance({...args,now:base+3000});assert.equal(w.evidence(t.id).length,3);
  s.db.close();
});
test('a user stopping work during inference prevents both a follow-up and a stale wake plan',async()=>{
  const {s,t,w}=fixture(),clock=new WorkWake(s);
  await clock.advance({now:base,broker:async()=>[worker,other],planner:{plan:async()=>{w.setState(t.id,'cancelled');return {reply:'再看',actions:[],nextCheckSeconds:60};}}});
  assert.equal(clock.card(t.id),null);assert.equal(w.evidence(t.id).length,2);s.db.close();
});
