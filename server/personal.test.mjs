import {approveRoute} from './test-support/route-review.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PersonalStore} from './personal-store.mjs';
import {PersonalAgent} from './personal-service.mjs';
const worker=(deviceId,target,kind='codex',online=true)=>({deviceId,target,deviceName:deviceId,agentName:kind,kind,online,
  contextSources:kind==='codex'?['Codex CLI','Codex Desktop']:[],capabilities:['workspace-write','read-only']});
const stores=()=>new PersonalStore(':memory:');
test('board groups the two Codex agents independently and preserves older clients',async()=>{
  const sessions=[
    {id:'shared',machine:'bench',source:'Codex CLI',evidence:['private']},
    {id:'shared',machine:'desk',source:'Codex Desktop'},
    {id:'other',machine:'desk',source:'Unknown'},
  ];
  const tasks=[{id:'one',target:'desk.reader'},{id:'two',target:'retired'}];
  const store=stores();
  try {
    const agent=new PersonalAgent({store,contexts:{readContexts:()=>sessions,contextCoverage:()=>[]},
      broker:async route=>route==='/workers'?[worker('desk','desk.code','codex',false),worker('desk','desk.reader','deepseek'),worker('bench','bench.code','codex',false)]:tasks});
    const legacy=await agent.board();
    assert.deepEqual(legacy.tasks,tasks);
    const b=await agent.board({layout:'machines'});
    const [desk,bench]=b.machines;
    const [codex,dsh]=desk.agents;
    assert.equal(desk.online,true);assert.equal(bench.online,false);
    assert.deepEqual(codex.sessions,[sessions[1]]);
    assert.deepEqual(bench.agents[0].sessions,[{id:'shared',machine:'bench',source:'Codex CLI'}]);
    assert.deepEqual(dsh.tasks,[tasks[0]]);assert.equal(dsh.sessionsIndexed,false);
    assert.equal(codex.worker.online,false);assert.equal(codex.sessionsIndexed,true);
    assert.deepEqual(b.unassignedSessions,[sessions[2]]);assert.deepEqual(b.unassignedTasks,[tasks[1]]);
    assert.equal('sessions' in b,false);
  } finally {store.db.close();}
});
test('paired retries, background reminders, history deep link and restart',()=>{
  const dir=mkdtempSync(join(tmpdir(),'persona-test-')),file=join(dir,'db');
  let store=new PersonalStore(file);
  const turn=store.receive({requestId:'same',text:'提醒我核对书名'});
  assert.equal(store.receive({requestId:'same',text:'提醒我核对书名'}).id,turn.id);
  assert.throws(()=>store.receive({requestId:'same',text:'different'}));
  store.addCommitment('c','核对书名','2030-01-02T04:00:00.000Z',1,turn.id);
  store.db.close();store=new PersonalStore(file);
  store.wake(new Date('2030-01-02T04:01:00Z'));store.wake(new Date('2030-01-02T04:02:00Z'));
  const list=store.notifications({after:0});
  assert.equal(list.items.length,1);
  assert.ok(store.history({around:list.items[0].id}).messages.some(r=>r.id===list.items[0].id));
  assert.equal(store.notifications({after:list.cursor}).items.length,0);
  assert.equal(store.commitments()[0].dueAt,'2030-01-03T04:00:00.000Z');
  store.db.close();rmSync(dir,{recursive:true,force:true});
});
test('preference replacement scoped to project, forget ignores previous turns',()=>{
 const s=stores();
 s.receive({requestId:'a',text:'使用项目符号'});const t=s.pending();
 s.remember(t,{key:'voice',text:'first',scope:'global'});
 s.remember(t,{key:'voice',text:'second',scope:'global'});
 s.remember(t,{key:'voice',text:'other',scope:'a project'});
 assert.equal(s.preferences().length,2);
 s.forget(t,s.preferences().find(r=>r.scope==='global').id);
 assert.deepEqual(s.previous(t.seq+1),[]);
 assert.equal(s.remember(t,{key:'voice',text:'second',scope:'global'}),false);
 assert.equal(s.preferences()[0].text,'other');
});
test('persist planned actions, report only once and keep active commitments',async()=>{
 const store=stores(),row={id:'external',title:'demo',updatedAt:'2030-01-01T01:00:00Z',machine:'bench',evidence:[]};
 let rev=row.updatedAt;const tasks=new Map();let modelCalls=0;
 const chat='帮我在 Bench 检查状态，完成提醒我。';
 const agent=new PersonalAgent({store,contexts:{readContexts:()=>[{...row,updatedAt:rev}],contextCoverage:()=>[]},
   planner:{plan:async(input)=>{modelCalls++;
     if(input.phase==='routeAuthority')return approveRoute(input);
     if(input.phase==='delivery')return {reply:'检查完毕，结果已核实。',actions:[],coverage:[{index:0,status:'answered',finding:'检查完毕',sources:['test-task']}]};
     return {reply:'我来检查。',references:[row],actions:[{type:'dispatch',target:'bench.code',sessionId:'external',notify:true,prompt:'检查状态',evidence:'检查状态'}]};}},
   broker:async(route,args)=>{if(route==='/workers')return [worker('bench','bench.code')];if(route==='/list')return [];
   if(route==='/submit'){if(!tasks.has(args.requestId))tasks.set(args.requestId,{id:'test-task',result:'检查完毕',state:'succeeded'});return tasks.get(args.requestId);}
   if(route==='/get')return [...tasks.values()][0];}});
 store.receive({text:chat,requestId:'r1'});await agent.step();await agent.tick();await agent.deliver();await agent.deliver();await agent.tick();
 assert.equal(modelCalls,3);assert.equal(tasks.size,1);assert.equal(store.notifications({}).items.length,1);
 assert.ok(store.history().messages.some(m=>m.text==='检查完毕，结果已核实。'));assert.equal(store.history().messages[0].work.state,'completed');
 store.watch('watchId',row,'等待活动','r1');await agent.tick();
 assert.equal(store.notifications({}).items.length,1);
 rev='2030-01-02T01:00:00Z';await agent.tick();await agent.tick();
 assert.equal(store.notifications({}).items.length,2);
});
test('independent session attachment is idempotent and part of the request identity',()=>{
 const s=stores(),v={requestId:'attachment',text:'同一句话',context:{id:'00000000-0000-4000-8000-000000000004',machine:'desk'}};
 const t=s.receive(v);assert.deepEqual({...s.sourceFor(t.id)},v.context);
 assert.equal(s.receive(v).id,t.id);
 assert.throws(()=>s.receive({...v,context:{...v.context,machine:'bench'}}));
});
test('scheduled review coalesces missed intervals, notifies once and executes no model-proposed action',async()=>{
 const s=stores(),agent=new PersonalAgent({store:s,planner:null,contexts:{}});
 agent.flows.addReview('rule',{id:'src'},'检查两台机器','2000-01-12T04:00:00.000Z',1);
 agent.flows.wake(new Date('2000-01-17T06:00:00Z'));agent.flows.wake(new Date('2000-01-17T06:10:00Z'));
 const planner={plan:async()=>({reply:'今天有一项异常。',actions:[{type:'dispatch'}]})};
 await agent.flows.processReview(planner,async()=>({}));await agent.flows.processReview(planner,async()=>({}));
 assert.equal(s.notifications({}).items.length,1);
 assert.equal(agent.flows.listReviews()[0].dueAt,'2000-01-18T04:00:00.000Z');
});
test('handoff waits for source success and passes exactly one immutable attachment id',async()=>{
 const s=stores(),agent=new PersonalAgent({store:s,planner:null,contexts:{}});
 let state='running',submitted=[];
 agent.flows.handoff('upstream',{id:'origin'},{to:'desk.code',second:'read data',notify:true});
 const op=async(route,args)=>{
  if(route==='/get')return {state,attachment:{sha256:'test',size:20}};
  submitted.push(args);return {id:'downstream'};
 };
 await agent.flows.advance(op);assert.equal(submitted.length,0);state='succeeded';
 await agent.flows.advance(op);await agent.flows.advance(op);assert.equal(submitted.length,1);
 assert.equal(submitted[0].inputTaskId,'upstream');assert.equal(s.waiting()[0].turnId,'origin');
});
test('forgetting removes related history only and requires explicit reinstatement after rephrasing',()=>{
 const s=stores();
 s.receive({requestId:'keep',text:'目录需要补充索引'});const unrelated=s.pending();s.finish(unrelated,'已记录。');
 s.receive({requestId:'forget',text:'偏好短句'});const keyed=s.pending();s.remember(keyed,{key:'voice',scope:'global',text:'偏好短句'});
 s.finish(keyed,'已更新。');
 s.receive({requestId:'drop',text:'忘掉短句偏好'});const drop=s.pending();s.forget(drop,s.preferences()[0].id);
 assert.ok(s.previous(drop.seq+1).some(r=>r.text==='目录需要补充索引'));
 assert.ok(!s.previous(drop.seq+1).some(r=>r.text.includes('短句')));
 assert.equal(s.remember(drop,{key:'voice',scope:'global',text:'我爱短句子'}),false);
});
test('selected source and explicit negative language guard against a bad model plan',()=>{
 const agent=new PersonalAgent({store:stores(),planner:null,contexts:{}});
 const snap={attachedSession:{machine:'desk',id:'x'},sessions:[],preferences:[],commitments:[]};
 const plan={actions:[{type:'dispatch',target:'bench.code',prompt:'edit file',write:true,evidence:'修改文件'}],reply:'',references:[]};
 assert.throws(()=>agent.check({text:'只解释文件状态，不要修改文件'},plan,snap));
});
test('API runtime receives persisted preference and open work after a runtime switch',async()=>{
 const {ChatApiPlanner}=await import('./personal-model.mjs');
 const s=stores();s.receive({requestId:'before',text:'使用项目符号，明天复查。'});const t=s.pending();
 s.remember(t,{key:'answer_style',scope:'global',text:'使用项目符号'});s.addCommitment('todo','明天复查',null,0,t.id);s.finish(t,'已记录。');
 let calls=0;
 const planner=new ChatApiPlanner({endpoint:'https://planner.example.test/chat/completions',model:'fixture-model',key:'synthetic-test-key',request:async(url,req)=>{
  calls++;assert.equal(url,'https://planner.example.test/chat/completions');
  const input=JSON.parse(JSON.parse(req.body).messages[1].content);
  assert.equal(input.preferences[0].text,'使用项目符号');assert.equal(input.commitments[0].text,'明天复查');
  return Response.json({choices:[{message:{content:JSON.stringify({reply:'使用项目符号，明天复查。',directBasis:'memory',actions:[]})}}]});
 }});
 const ag=new PersonalAgent({store:s,planner,contexts:{readContexts:()=>[],contextCoverage:()=>[]},broker:async()=>[]});
 s.receive({requestId:'after',text:'按上次的方式继续。'});await ag.step();
 assert.equal(calls,1);assert.equal(s.history().messages.at(-1).text,'使用项目符号，明天复查。');
});
test('duplicate suggestion needs the same live objective and artifact; same titles alone stay quiet',async()=>{
 const {findSharedWork}=await import('./personal-opportunities.mjs');const now=Date.now();
 const row={id:'a',title:'分析',machine:'desk',status:'inProgress',evidence:[{role:'user',at:new Date(now).toISOString(),text:'请统计 catalog.csv 中缺少作者的条目，并列出书名'}]};
 const other={...row,machine:'bench',id:'b'};assert.equal(findSharedWork([row,other],{since:now-1,now}).length,1);
 const different={...other,evidence:[{...row.evidence[0],text:'请核对 catalog.csv 中重复出现的书名，并列出编号'}]};
 assert.equal(findSharedWork([row,different],{since:now-1,now}).length,0);
});
