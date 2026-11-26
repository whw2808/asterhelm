import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PersonalStore} from './personal-store.mjs';
import {PersonalAgent} from './personal-service.mjs';
import {configuredQueue} from './test-support/registered-queue.mjs';

function setup(t){
  const store=new PersonalStore(':memory:'),queue=configuredQueue(':memory:');
  t.after(()=>{store.db.close();queue.close();});
  const rows=['desk','bench'].map(machine=>{
    const stamp=new Date(Date.now()-1200).toISOString();
    return {machine,id:randomUUID(),target:machine+'.code',source:'Codex Desktop',title:'春季图书展',status:'completed',
      readOnly:true,visibility:'recent-dialogue',archived:false,updatedAt:stamp,createdAt:stamp,summary:'',
      evidence:[{role:'assistant',text:'已完成春季图书展的索引校对，核对了 12 条目录。',itemId:'sample',turnId:'t1',at:stamp}]};
  });
  const routes=[];
  const agent=new PersonalAgent({store,planner:{offline:true},contexts:{readContexts:()=>rows,contextCoverage:()=>[]},
    broker:async route=>{routes.push(route);if(route==='/workers')return queue.workers();if(route==='/list')return [];
      throw Error('Unexpected route');}});
  const send=(text,extra={})=>agent.receive({text,requestId:randomUUID(),...extra});
  const card=id=>agent.history({around:id}).messages.find(row=>row.id===id).proactive[0];
  return {store,agent,send,rows,routes,card};
}
test('paired phone can enroll, preview evidence from two agents, and inspect the same board without routing work',async t=>{
  const f=setup(t);
  const {id}=await f.send('我的目标是春季图书展');
  const card=f.card(id);
  assert.equal(card.status,'preview');assert.deepEqual(new Set(card.findings.map(x=>x.deviceId)),new Set(['desk','bench']));
  const board=await f.agent.board({layout:'machines'});
  assert.ok(board.machines.every(m=>m.agents[0].activity?.sourceId));
  await f.send('这个目标会提醒我什么？');
  assert.match(f.store.history().messages.at(-1).text,/春季图书展/);
  assert.deepEqual(f.store.notifications().items,[]);
  assert.equal(f.routes.includes('/submit'),false);assert.equal(f.store.work.activeCount(),0);
  assert.equal(f.store.continuity.participants().length,0);
  const action='星舵操作 '+card.id+' v'+card.version+' enable';
  await f.send(action,{requestId:'confirmation'});await f.send(action,{requestId:'confirmation'});
  assert.equal(f.card(id).status,'enabled');assert.deepEqual(f.store.notifications().items,[]);
});
test('a goal scoped to a selected session neither joins its work nor leaks other matching sessions',async t=>{
  const f=setup(t),{machine,id}=f.rows[0];
  const added=await f.send('帮我关注春季图书展',{context:{machine,id},requestId:'scope'});
  assert.deepEqual(f.card(added.id).findings.map(x=>x.deviceId),['desk']);
  assert.equal(f.store.continuity.participants().length,0);
  await assert.rejects(f.send('帮我关注春季图书展',{context:{machine:'bench',id:f.rows[1].id},requestId:'scope'}));
});
