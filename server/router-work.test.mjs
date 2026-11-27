import {approveRoute} from './test-support/route-review.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PersonalStore} from './personal-store.mjs';
import {PersonalAgent} from './personal-service.mjs';
import {routeHints} from './router-policy.mjs';

const worker={deviceId:'catalog-desk',deviceName:'Catalog Desk',platform:'Linux',deviceAliases:[],target:'catalog-desk.editor',
  agentName:'Catalog Editor',aliases:['目录编辑'],kind:'command',online:true,capabilities:['read-only'],contextSources:[]};
const contexts={readContexts:()=>[],contextCoverage:()=>[]};
const question='请比较两份目录配置的区别';
const criteria=['已核实的配置差异','仍需验证的输入'];
test('candidate hints preserve ambiguous devices without creating actions',()=>{
  const other={...worker,deviceId:'box-b',deviceName:'B',target:'box-b.tool',agentName:'Material',aliases:[]};
  assert.deepEqual(routeHints('请让目录编辑核对配置',[worker,other]).mentionedTargets,[worker.target]);
  const hints=routeHints('有人说 Linux 上帮我查配置',[worker,other]);
  assert.equal(hints.mentionedTargets.length,2);
  assert.equal(hints.actions,undefined);
});
test('durable parent/child cards survive restart, follow-up and duplicate receipts',async()=>{
  const tmp=mkdtempSync(join(tmpdir(),'router-round-'));
  const file=join(tmp,'personal.db');let store=new PersonalStore(file);
  const tasks=new Map(),submitted=new Map(),originalId=[];
  const broker=async(route,data)=>{
    if(route==='/workers')return [worker];
    if(route==='/list')return [...tasks.values()];
    if(route==='/get')return tasks.get(data.id);
    if(route==='/submit'){
      const prev=submitted.get(data.requestId);if(prev)return tasks.get(prev);
      const id='child-'+(tasks.size+1);
      tasks.set(id,{id,target:data.target,created:'2030-01-01T00:00:00Z',state:'queued'});
      submitted.set(data.requestId,id);originalId.push(data.prompt);return tasks.get(id);
    }
  };
  const planner={plan:async(input)=>{
    if(input.phase==='routeAuthority')return approveRoute(input);
    if(input.phase!=='delivery')return {reply:'',criteria,actions:[{type:'consult',target:worker.target,title:'核实配置',prompt:'读配置',evidence:'目录配置'}]};
    const gap=input.results.length===1;
    return {reply:gap?'缺第二项':'差异来自排序设置。第二份输入尚缺分类字段，先验证分类规则。',coverage:[
      {index:0,status:'answered',finding:'排序差异',sources:['child-1']},
      {index:1,status:gap?'missing':'answered',finding:'还需核实分类',sources:gap?[]:['child-2']},
    ],actions:gap?[{type:'consult',target:worker.target,title:'核实输入',prompt:'查证分类情况'}]:[]};
  }};
  let service=new PersonalAgent({store,broker,planner,contexts});
  try{
    const turn=store.receive({text:question,requestId:'checked'});
    await service.step();
    assert.equal(originalId.length,1);assert.ok(originalId[0].includes(question));
    assert.equal(store.history().messages[0].work.tasks[0].state,'queued');
    Object.assign(tasks.get('child-1'),{state:'running',progress:'working',startedAt:'2030-01-01T00:00:02Z',lastHeartbeatAt:'2030-01-01T00:00:07Z'});
    await service.tick();let first=store.work.card(turn.id).tasks[0];assert.equal(first.progress,'执行中');assert.equal(first.agentName,'Catalog Editor');
    assert.equal(first.lastHeartbeatAt,'2030-01-01T00:00:07Z');
    store.db.close();store=new PersonalStore(file);service=new PersonalAgent({store,broker,planner,contexts});
    Object.assign(tasks.get('child-1'),{state:'succeeded',result:'RAW-SORT-RUN',finishedAt:'2030-01-01T00:00:08Z'});
    await service.tick();await service.deliver();assert.ok(store.work.order(turn.id).decision);
    store.db.close();store=new PersonalStore(file);service=new PersonalAgent({store,broker,planner,contexts});
    await service.deliver();assert.equal(tasks.size,2);
    Object.assign(tasks.get('child-2'),{state:'succeeded',result:'RAW-CATEGORY-DATA',finishedAt:'2030-01-01T00:00:10Z'});
    await service.tick();await service.deliver();await service.tick();await service.deliver();
    const history=store.history();
    assert.equal(history.pending,0);assert.equal(history.messages.length,2);assert.equal(history.messages[0].work.tasks.length,2);
    assert.equal(history.messages[0].work.state,'completed');assert.equal(history.messages[0].work.tasks[0].finishedAt,'2030-01-01T00:00:08Z');
    assert.ok(history.messages[1].text.includes('排序设置'));assert.ok(!history.messages[1].text.includes('RAW-'));
  }finally{store.db.close();rmSync(tmp,{recursive:true,force:true});}
});
test('uncorroborated delivery is marked partial instead of complete',async()=>{
  const store=new PersonalStore(':memory:');
  const broker=async(route)=>route==='/workers'?[worker]:[];
  const planner={plan:async()=>({reply:'部分结论。',actions:[],coverage:[{index:0,status:'answered',finding:'证据不足',sources:['unknown']}]})};
  const agent=new PersonalAgent({store,broker,planner,contexts});
  const turn=store.receive({text:question,requestId:'partial'});
  store.work.create(turn,[question]);store.work.stage(turn.id,'1',worker,'consult','查证');
  store.work.bind('1',{id:'t',state:'failed',result:'unavailable'});
  store.db.prepare("UPDATE turns SET state='done' WHERE id=?").run(turn.id);
  await agent.deliver();assert.equal(store.work.order(turn.id).state,'partial');store.db.close();
});
