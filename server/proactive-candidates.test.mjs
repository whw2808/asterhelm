import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {PersonalStore} from './personal-store.mjs';
import {ProactiveCandidates} from './proactive-candidates.mjs';
import {configuredQueue} from './test-support/registered-queue.mjs';

const baseline=Date.now();
const stamp=ms=>new Date(baseline+ms).toISOString();
const goal='Verify the paper exhibit catalogue for the gallery opening.';
function source(machine, id=randomUUID(), fact='Still pending: catalogue.csv is missing the paper checklist.'){
  return {machine,id,target:machine+'.code',source:'Codex Desktop',title:'Paper gallery catalogue',cwd:'/exhibits/paper',readOnly:true,
    status:'completed',archived:false,visibility:'recent-dialogue',updatedAt:stamp(2000),evidence:[
      {role:'user',text:goal,turnId:'gallery-turn',itemId:'request',at:stamp(1000)},
      {role:'assistant',text:fact,turnId:'gallery-turn',itemId:'result',at:stamp(2000)}]};
}
async function setup(t){
  const dir=mkdtempSync(join(tmpdir(),'exhibit-candidate-'));
  const db=join(dir,'personal.sqlite'), queue=configuredQueue(join(dir,'queue.sqlite'));
  let store,engine;
  const open=()=>{store=new PersonalStore(db);engine=new ProactiveCandidates(store);};open();
  for(const device of ['desk','bench'])queue.beat(device+'.code',null,'ready',null,true);
  const broker=async(route,data={})=>{
    switch(route){
      case '/getByRequestId':return queue.getByRequestId(data.requestId);
      case '/cancelByRequestId':return queue.cancelByRequestId(data.requestId);
      case '/submit':return queue.submit(data);
      case '/get':return queue.get(data.id);
      default:throw Error('Unexpected broker operation '+route);
    }
  };
  t.after(()=>{store.db.close();queue.close();rmSync(dir,{recursive:true,force:true});});
  return {queue,broker,get store(){return store;},get engine(){return engine;},restart(){store.db.close();open();},
    turn(text){return store.receive({text,requestId:randomUUID()});},
    watch(row){const turn=this.turn('Watch this gallery session for new activity.');store.finish(turn,'Watching.');store.watch(randomUUID(),{...row,updatedAt:stamp(0)},'Gallery update',turn.id);return turn;},
    tick(rows,options={}){return engine.tick({rows,now:baseline+5000,workers:queue.workers(),broker,...options});},
    count(table){return store.db.prepare('SELECT count(*) n FROM '+table).get().n;}};
}
test('only a new authorized source can trigger a check; two sources and a lost response retain one local task across restart',async t=>{
  const f=await setup(t), desk=source('desk'),bench=source('bench');
  await f.tick([desk,bench]);assert.deepEqual(f.engine.cards(),[]);
  f.watch(desk);f.watch(bench);
  const old={...desk,updatedAt:stamp(4500),evidence:desk.evidence.map(e=>({...e,at:stamp(-3000)}))};
  await f.tick([old]);assert.equal(f.queue.list().length,0);
  bench.evidence[1].text+=' Private bench annotation.';
  let lost=false;
  await f.tick([desk,bench],{broker:async(path,data)=>{const value=await f.broker(path,data);if(path==='/submit'&&!lost){lost=true;throw Error('reply lost');}return value;}});
  f.restart();await Promise.all([f.tick([desk,bench]),f.tick([desk,bench])]);
  const [task]=f.queue.list();assert.equal(f.queue.list().length,1);assert.equal(task.mode,'read-only');assert.equal(task.target,'desk.code');
  assert.doesNotMatch(f.queue.get(task.id).prompt,/Private bench annotation/);assert.equal(task.exportFile,false);assert.equal(task.inputTaskId,null);
  assert.equal(f.engine.cards().length,1);assert.equal(f.count('work_orders'),0);assert.equal(f.count('continuity_participants'),0);
  f.queue.claim(task.target);f.queue.finish(task.target,{id:task.id,state:'failed',result:'The exhibit index could not be read.'});
  await f.tick([desk,bench]);f.restart();await f.tick([desk,bench]);
  const [card]=f.engine.cards();assert.equal(card.status,'waiting');assert.match(card.detail,/exhibit index/);
  assert.equal(f.store.notifications().items.length,1);assert.equal(f.store.notifications().items[0].id,card.messageId);
  assert.equal(f.count('work_orders'),0);assert.equal(f.queue.list().length,1);
});
test('ignore withdraws in-flight submission by request ID and remains effective for fresh wording and late receipts',async t=>{
  const f=await setup(t),row=source('desk');f.watch(row);await f.tick([row]);
  const [task]=f.queue.list();f.queue.claim(task.target);
  const [card]=f.engine.cards();f.engine.decide(f.turn('忽略'),{id:card.id,version:card.version,decision:'ignore'});
  await f.tick([row]);assert.ok(f.queue.get(task.id).cancelRequested);
  f.queue.finish(task.target,{id:task.id,state:'cancelled',result:'Withdrawal received.'});
  row.evidence[1]={...row.evidence[1],at:stamp(3000),itemId:'reworded',text:'Remaining work: check the absent catalogue.csv for the exhibit.'};
  f.restart();await f.tick([row]);assert.equal(f.engine.cards()[0].status,'ignored');assert.equal(f.queue.list().length,1);
  assert.equal(f.store.notifications().items.length,0);assert.equal(f.count('work_orders'),0);
});
test('manual recheck is a single separate grant; current explicit approval creates the real work root once',async t=>{
  const f=await setup(t),row=source('desk');f.watch(row);await f.tick([row]);
  const finish=async()=>{const task=f.queue.claim('desk.code');f.queue.finish(task.target,{id:task.id,state:'succeeded',result:'The label column in catalogue.csv is empty.'});await f.tick([row]);};
  await finish();const [old]=f.engine.cards();const decision={id:old.id,version:old.version,decision:'recheck'};
  const manual=f.turn('再查一次，先别立项');f.engine.decide(manual,decision);f.engine.decide(manual,decision);
  await f.tick([row]);assert.equal(f.queue.list().length,2);assert.equal(f.count('work_orders'),0);await finish();
  assert.throws(()=>f.engine.decide(f.turn('同意'),{...decision,decision:'approve'}));
  const [fresh]=f.engine.cards();const approval={id:fresh.id,version:fresh.version,decision:'approve'};
  assert.throws(()=>f.engine.decide({id:fresh.messageId},approval));
  const turn=f.turn('同意立项');assert.equal(f.engine.decide(turn,approval).workId,turn.id);
  f.restart();assert.equal(f.engine.decide(turn,approval).workId,turn.id);assert.equal(f.count('work_orders'),1);
  assert.equal(f.store.continuity.workForTurn(turn.id),turn.id);assert.equal(f.store.continuity.participants().length,0);
  assert.match(f.store.work.order(turn.id).goal,/catalogue/);assert.ok(f.store.work.card(turn.id).tasks.length);
});
test('a missing source connector, paused instruction, or a model-only reference cannot cause an autonomous dispatch',async t=>{
  const f=await setup(t),row=source('desk');const hint=f.turn('Which exhibits are open?');f.store.link(hint,row);
  await f.tick([row]);assert.equal(f.engine.cards().length,0);
  f.watch(row);const elsewhere=f.queue.workers().filter(w=>w.deviceId==='bench');await f.tick([row],{workers:elsewhere});
  assert.equal(f.queue.list().length,0);assert.match(f.engine.cards()[0].detail,/来源|设备|执行端/);
  const paused=source('bench');paused.evidence[0].text='Pause this work until I reply.';f.watch(paused);await f.tick([paused]);
  assert.equal(f.queue.list().length,0);
});
test('an ambiguous clue is reported without dispatch, and differently worded reports for one located resource share a budget',async t=>{
  const f=await setup(t),ambiguous=source('desk',randomUUID(),'Still pending: a few checks remain.');
  f.watch(ambiguous);await f.tick([ambiguous]);assert.equal(f.queue.list().length,0);
  assert.match(f.engine.cards()[0].detail,/依据|缺少/);
  const paper=source('desk'),copy=source('bench');copy.evidence[0].text='Check the paper gallery register and confirm omissions.';
  f.watch(paper);f.watch(copy);await f.tick([paper,copy]);assert.equal(f.queue.list().length,1);
});
test('a selected source losing body access withdraws its probe; new complete evidence retires the open suggestion',async t=>{
  const f=await setup(t),row=source('desk');f.watch(row);await f.tick([row]);
  const [task]=f.queue.list();f.queue.claim(task.target);
  await f.tick([{...row,visibility:'metadata-only',evidence:[]}]);assert.equal(f.engine.cards()[0].status,'ignored');assert.ok(f.queue.get(task.id).cancelRequested);
  const complete=source('bench');complete.cwd='/exhibits/spring';f.watch(complete);await f.tick([complete]);
  complete.evidence[1]={...complete.evidence[1],itemId:'final-entry',at:stamp(4000),text:'All entries in catalogue.csv are complete; nothing is missing.'};
  await f.tick([complete]);assert.equal(f.engine.cards().filter(c=>c.status!=='ignored').length,0);
});
test('updating an open exhibit commitment anchors a new clue to the user goal without dispatch to an unselected machine',async t=>{
  const f=await setup(t),turn=f.turn('请记为待办：展览标签 catalogue.csv 仍需核对缺项。');
  f.store.addCommitment('paper-goal','展览标签 catalogue.csv 仍需核对缺项。',null,0,turn.id);
  await f.tick([]);const [card]=f.engine.cards();assert.ok(card);assert.match(card.goal,/展览标签/);assert.equal(f.queue.list().length,0);
  assert.equal(f.count('work_orders'),0);assert.match(card.detail,/来源/);assert.equal(f.store.notifications().items.length,1);
  f.store.closeCommitment('paper-goal');await f.tick([]);assert.equal(f.engine.cards()[0].actions.length,0);
});
test('a legacy phone work created against the selected source must still match the proposal revision on approval',async t=>{
  const f=await setup(t),row=source('desk'),origin=f.watch(row);await f.tick([row]);
  const task=f.queue.claim('desk.code');f.queue.finish(task.target,{id:task.id,state:'succeeded',result:'The index does not contain a checklist.'});await f.tick([row]);
  f.store.work.create({...origin,text:'Curate the paper exhibit catalogue.'},['Check paper catalogue.']);
  f.store.work.stage(origin.id,'existing-step',f.queue.workers()[0],'consult','Collect exhibit references.');
  await f.tick([row]);const [card]=f.engine.cards();assert.equal(card.workId,origin.id);assert.ok(card.detail.includes(origin.id));
  const decision={decision:'approve',version:card.version,id:card.id};
  f.store.work.revise(origin.id,{id:'paper-revision',text:'Limit to paper.'},{expectedRevision:0,goal:'Prepare only the paper catalogue.',criteria:['Check paper.']});
  assert.throws(()=>f.engine.decide(f.turn('同意立项'),decision));
  await f.tick([row]);const approval=f.turn('同意立项');const result=f.engine.decide(approval,{...decision,version:f.engine.cards()[0].version});
  assert.equal(result.workId,origin.id);assert.equal(f.store.continuity.workForTurn(approval.id),origin.id);assert.equal(f.count('work_orders'),1);
});
test('an immutable fact replay never changes the proposal version; a worker rejecting submission leads to an honest terminal report',async t=>{
  const f=await setup(t),row=source('desk');f.watch(row);
  const rejecting=async(route,data)=>{if(route==='/submit')throw Error('Unsupported isolated executor');return f.broker(route,data);};
  for(let i=0;i<6;i++)await f.tick([row],{now:baseline+5000+120000*i,broker:rejecting});
  const [card]=f.engine.cards();assert.equal(card.status,'waiting');assert.match(card.detail,/提交|接单/);assert.equal(f.queue.list().length,0);
  row.evidence[1].at=stamp(4000);await f.tick([row]);assert.equal(f.engine.cards()[0].version,card.version);assert.equal(f.store.notifications().items.length,1);
});
test('a check is never executed using a forgotten grant, and its forgotten source excerpts leave the candidate card',async t=>{
  const f=await setup(t),row=source('desk'),origin=f.watch(row);await f.tick([row]);
  f.store.db.prepare('INSERT INTO memory_exclusions VALUES(?)').run(origin.id);
  await f.tick([row]);const [card]=f.engine.cards();assert.equal(card.status,'ignored');assert.doesNotMatch(JSON.stringify(card),/catalogue\.csv|paper checklist/);
  assert.doesNotMatch(f.store.history().messages.find(m=>m.id===card.messageId).text,/catalogue\.csv|paper checklist/);
});
test('an accepted check reports its original evidence when a new fact changes the open card, even after approval',async t=>{
  const f=await setup(t),row=source('desk');f.watch(row);await f.tick([row]);
  const task=f.queue.claim('desk.code');f.queue.finish(task.target,{id:task.id,state:'succeeded',result:'Source item result confirms the paper checklist is missing.'});
  row.evidence[1]={...row.evidence[1],text:'Still pending: catalogue.csv lacks a shipping code.',at:stamp(3100),itemId:'shipping'};
  await f.tick([row]);const [card]=f.engine.cards();assert.match(card.detail,/shipping code/);assert.match(card.detail,/paper checklist/);
  const approval=f.turn('同意立项');f.engine.decide(approval,{id:card.id,version:card.version,decision:'approve'});
  assert.match(f.engine.cards()[0].detail,/paper checklist/);assert.match(f.store.work.card(approval.id).goal,/catalogue/);
});
test('history queries load only card anchors on that page, and a terminal report provides a fresh chat reply target',async t=>{
  const f=await setup(t),a=source('desk'),b=source('bench');b.cwd='/exhibits/winter';b.evidence[0].text='Verify the winter exhibit catalogue.';f.watch(a);f.watch(b);await f.tick([a,b]);
  const before=f.engine.cards();assert.equal(before.length,2);assert.deepEqual(f.engine.cards([before[1].messageId]).map(c=>c.id),[before[1].id]);
  assert.deepEqual(f.engine.cards(new Set(['unrelated'])),[]);
  const turn=f.turn('The gallery will open this Friday.');f.store.finish(turn,'Recorded.');
  const task=f.queue.claim('desk.code');f.queue.finish(task.target,{id:task.id,state:'succeeded',result:'The paper checklist is missing.'});await f.tick([a,b]);
  const card=f.engine.cards().find(c=>c.status==='waiting');assert.equal(f.store.history().messages.at(-1).id,card.reportMessageId);
  assert.match(card.detail,/Paper gallery catalogue/);assert.ok(!card.detail.includes(a.id));
});
test('a named checklist missing from the selected directory can be checked without an extension; mirrored checkouts share the local fact budget',async t=>{
  const f=await setup(t),a=source('desk',randomUUID(),'展览目录仍缺少纸本清单。'),b=source('bench',randomUUID(),'展览目录仍缺少纸本清单。');
  a.evidence[0].text=b.evidence[0].text='核对秋季展览目录的纸本清单。';b.cwd='/gallery/copies/paper';
  f.watch(a);f.watch(b);await f.tick([a,b]);assert.equal(f.queue.list().length,1);assert.equal(f.engine.cards().length,1);
  assert.match(f.engine.cards()[0].title,/纸本清单/);
});
test('chat approval runs a native scoped step and two subsequently selected desktop chats share the work through delivery',async t=>{
  const {PersonalAgent}=await import('./personal-service.mjs');
  const f=await setup(t),initial=source('desk'),first=source('desk'),second=source('bench');
  f.watch(initial);await f.tick([initial]);const probe=f.queue.claim('desk.code');
  f.queue.finish(probe.target,{id:probe.id,state:'succeeded',result:'The checklist column is missing.'});await f.tick([initial]);
  const rows=[initial,first,second],agent=new PersonalAgent({store:f.store,
    contexts:{readContexts:()=>rows,readSession:(_home,machine,id)=>rows.find(r=>r.machine===machine&&r.id===id),contextCoverage:()=>[]},
    broker:async(route,input)=>route==='/workers'?f.queue.workers():route==='/list'?f.queue.list():route==='/wakeEvents'?f.queue.wakeEvents(input):f.broker(route,input),
    planner:{plan:async snap=>snap.phase==='delivery'?{actions:[],reply:'Paper catalogue requires the checklist column.',
      coverage:[{index:0,status:'answered',finding:'Add the checklist column.',sources:[snap.results[0].id]}]}:{reply:'收到。',actions:[],references:[]}}});
  const request={requestId:'confirm-exhibit',text:'同意'};
  const root=await agent.receive(request);assert.equal(root.workId,root.id);assert.equal((await agent.receive(request)).workId,root.id);
  await agent.step();const task=f.queue.claim('desk.code');assert.ok(task);assert.notEqual(task.id,probe.id);assert.equal(task.mode,'read-only');
  for(const row of [first,second]){
    const joined=await agent.receive({requestId:randomUUID(),text:'关联这项工作，接收摘要。',context:{machine:row.machine,id:row.id},workId:root.id});
    assert.equal(joined.workId,root.id);await agent.step();
  }
  f.queue.finish(task.target,{id:task.id,state:'succeeded',result:'The gallery catalogue lacks its checklist column.'});await agent.tick();await agent.deliver();
  assert.equal(f.store.work.order(root.id).state,'completed');assert.equal(f.store.work.card(root.id).tasks[0].taskId,task.id);
  assert.deepEqual(f.store.continuity.participants(root.id).map(p=>p.id),[first.id,second.id]);assert.equal(f.count('work_orders'),1);
  for(const row of [first,second])assert.equal(f.store.continuity.catchUp(row.machine,row.target,row.id)[0].workId,root.id);
  assert.equal(f.store.history().messages.find(m=>m.id==='delivery-'+root.id).parent,root.id);
});
test('a second machine contributes a traceable clue on the same card without changing the first machine’s execution material',async t=>{
  const f=await setup(t),first=source('desk'),second=source('bench');second.evidence[1].text='Remaining work: catalogue.csv lacks an appendix from the annex.';
  f.watch(first);f.watch(second);await f.tick([first]);const task=f.queue.claim('desk.code');
  f.queue.finish(task.target,{id:task.id,state:'succeeded',result:'The original checklist is absent.'});await f.tick([first,second]);
  const [card]=f.engine.cards();assert.ok(card.detail.includes('bench'));assert.ok(card.detail.includes('desk'));
  const consent=f.turn('同意立项');f.engine.decide(consent,{id:card.id,version:card.version,decision:'approve'});
  assert.doesNotMatch(f.store.db.prepare('SELECT plan FROM turns WHERE id=?').get(consent.id).plan,/annex|bench/);
});
