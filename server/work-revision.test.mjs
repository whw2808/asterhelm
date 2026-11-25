import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PersonalStore} from './personal-store.mjs';
import {deliverWork} from './router-delivery.mjs';

const desk={target:'atlas.editor',deviceId:'atlas',deviceName:'Atlas Desk',agentName:'Editor',capabilities:['read-only','workspace-write']};
const amendment={id:'print-only',text:'Pause the digital proof and finish the print edition.'};
const change={expectedRevision:0,goal:'Finish the print edition',criteria:['Printable proof'],pauseStepIds:['digital']};
function order(store,id='atlas-request'){
  const turn=store.receive({requestId:id,text:'Prepare print and digital proofs'});
  store.work.create(turn,['Both proofs']);
  store.db.prepare("UPDATE turns SET state='done' WHERE id=?").run(turn.id);
  return turn.id;
}
function step(store,parent,id,state,mode='read-only'){
  store.work.stage(parent,id,desk,'dispatch',id,false,false,mode);
  store.work.bind(id,{id:id+'-task',state,target:desk.target,startedAt:state==='queued'?null:'2030-01-03T00:00:00Z',
    result:state==='succeeded'?id+' evidence':'',progress:state==='running'?'running_executor':null});
}
const plan=reply=>({reply,actions:[],coverage:[{index:0,status:'answered',finding:'Proof checked',sources:['print-task']}]});
const find=(store,parent,id)=>store.work.card(parent).tasks.find(s=>s.id===id);

test('a replayed amendment preserves its revision, child receipts and remaining scope across restart',()=>{
  const temp=mkdtempSync(join(tmpdir(),'atlas-revise-')),file=join(temp,'chat.db');
  let store=new PersonalStore(file);
  try{
    const parent=order(store);
    step(store,parent,'digital','running');
    step(store,parent,'print','queued');
    assert.equal(store.work.revise(parent,amendment,change),1);
    store.db.close();store=new PersonalStore(file);
    assert.equal(store.work.revise(parent,amendment,change),1);
    assert.deepEqual(store.work.evidence(parent).map(s=>[s.id,s.scope]),[['digital','paused'],['print','active']]);
    assert.equal(store.work.card(parent).revision,1);
    assert.equal(store.work.card(parent).goal,'Finish the print edition');
    assert.equal(store.work.order(parent).amendment,amendment.text);
    assert.equal(find(store,parent,'digital').state,'running');
    assert.match(find(store,parent,'digital').progress,/等待.*回执|等待.*确认/);
    assert.equal(store.work.ready(),undefined);
    for(const [id,proposal] of [
      ['invalid',{...change,expectedRevision:1,pauseStepIds:['print','another-order-step']}],
      ['stale',{...change,expectedRevision:0,pauseStepIds:['print']}],
    ])assert.throws(()=>store.work.revise(parent,{id,text:id},proposal));
    assert.equal(find(store,parent,'print').scope,'active');
    assert.equal(store.work.card(parent).revision,1);
  }finally{store.db.close();rmSync(temp,{recursive:true,force:true});}
});

test('a withdrawn queue entry, pending worker stop, and a late worker finish have different receipts',()=>{
  const store=new PersonalStore(':memory:');
  try{
    const parent=order(store);
    for(const id of ['queued','stopping','late','done'])step(store,parent,id,id==='queued'?'queued':id==='done'?'succeeded':'running');
    store.work.revise(parent,amendment,{...change,pauseStepIds:['queued','stopping','late','done']});
    store.work.observe({id:'queued-task',state:'cancelled',cancelRequested:1});
    store.work.observe({id:'stopping-task',state:'running',cancelRequested:1,progress:'running_executor'});
    store.work.observe({id:'late-task',state:'cancelled',cancelRequested:1,workerState:'succeeded',result:'Retired digital proof'});
    assert.match(find(store,parent,'queued').progress,/撤回.*未接单|未接单.*撤回/);
    assert.match(find(store,parent,'stopping').progress,/等待执行端确认/);
    assert.match(find(store,parent,'late').progress,/回执|交回/);
    assert.doesNotMatch(find(store,parent,'late').progress,/确认停止/);
    assert.match(find(store,parent,'done').progress,/不采用|不纳入/);
    store.work.observe({id:'stopping-task',state:'cancelled',workerState:'cancelled',cancelRequested:1});
    assert.match(find(store,parent,'stopping').progress,/确认停止/);
    assert.equal(store.work.order(parent).state,'paused');
    assert.equal(store.work.ready(),undefined);
    store.work.revise(parent,{id:'new-proof',text:'Resume with a fresh print proof'},{...change,expectedRevision:1,pauseStepIds:[]});
    store.work.stage(parent,'new',desk,'dispatch','New print proof');
    assert.equal(store.work.card(parent).state,'working');
  }finally{store.db.close();}
});

test('delivery drops a superseded synthesis and completes only the current goal with current evidence',async()=>{
  const store=new PersonalStore(':memory:');
  try{
    const parent=order(store);
    step(store,parent,'digital','succeeded');
    step(store,parent,'print','succeeded');
    const broker=async()=>[desk];
    let inputs=[];
    const planner={plan:async input=>{
      inputs.push(input);
      if(inputs.length===1){
        store.work.revise(parent,amendment,change);
        // Simulate a resumed synthesis being in the same phase as the old one.
        store.work.setState(parent,'synthesizing');
        return plan('Discard this old digital proof.');
      }
      return plan('Print proof ready.');
    }};
    await deliverWork({store,broker,planner});
    assert.deepEqual(store.history().messages.map(m=>m.role),['user']);
    await deliverWork({store,broker,planner});
    assert.equal(store.history().messages.at(-1).text,'Print proof ready.');
    assert.equal(inputs[1].originalQuestion,change.goal);
    assert.deepEqual(inputs[1].criteria,change.criteria);
    assert.deepEqual(inputs[1].results.map(r=>r.id),['print-task']);
    assert.equal(inputs[1].amendment,amendment.text);
    assert.equal(store.work.order(parent).state,'completed');
  }finally{store.db.close();}
});

test('a paused running child cannot block delivery of an independent finished child',async()=>{
  const store=new PersonalStore(':memory:');
  try{
    const parent=order(store);
    step(store,parent,'digital','running');step(store,parent,'print','succeeded');
    store.work.revise(parent,amendment,change);
    await deliverWork({store,broker:async()=>[desk],planner:{plan:async()=>plan('The print proof is ready.')}});
    assert.equal(store.work.order(parent).state,'completed');
    assert.equal(find(store,parent,'digital').state,'running');
  }finally{store.db.close();}
});

test('missing work permits bounded adaptive dispatch within the active device grant',async()=>{
  const store=new PersonalStore(':memory:');
  try{
    const parent=order(store);
    step(store,parent,'print','succeeded','workspace-write');
    const submits=[];
    const broker=async(route,data)=>{
      if(route==='/workers')return [desk];
      assert.equal(route,'/submit');submits.push(data);
      return {id:'follow-'+submits.length,target:data.target,state:'succeeded',result:'Updated proof'};
    };
    const planner={plan:async()=>({reply:'Still needs a fold mark.',coverage:[{index:0,status:'missing',finding:'Fold mark',sources:[]}],
      actions:[{type:'dispatch',target:desk.target,title:'Adjust fold mark',prompt:'Update the fold mark',write:true}]})};
    for(let i=0;i<6;i++)await deliverWork({store,broker,planner});
    assert.deepEqual(submits.map(s=>s.mode),['workspace-write','workspace-write']);
    assert.equal(new Set(submits.map(s=>s.requestId)).size,2);
    assert.equal(store.work.card(parent).state,'partial');
    assert.equal(store.work.card(parent).tasks.at(-1).kind,'dispatch');
  }finally{store.db.close();}
});

test('an amendment removes previous write authority from adaptive dispatch',async()=>{
  const store=new PersonalStore(':memory:');
  try{
    const parent=order(store);
    step(store,parent,'print','succeeded','workspace-write');step(store,parent,'digital','succeeded','workspace-write');
    store.work.revise(parent,amendment,change);
    let input;
    const planner={plan:async(snapshot)=>{
      input=snapshot;
      return {reply:'Print evidence is incomplete.',coverage:[{index:0,status:'missing',finding:'Fold mark',sources:[]}],
        actions:[{type:'dispatch',target:desk.target,title:'Update fold mark',prompt:'Update the proof',write:true}]};
    }};
    await deliverWork({store,broker:async()=>[desk],planner});
    assert.deepEqual(input.workers[0].modes,['read-only']);
    assert.equal(store.work.order(parent).decision,null);
    assert.equal(store.work.card(parent).tasks.length,2);
  }finally{store.db.close();}
});

test('a follow-up accepted during an amendment remains tracked and the obsolete submission is withdrawn',async()=>{
  const store=new PersonalStore(':memory:');
  try{
    const parent=order(store);step(store,parent,'digital','succeeded');
    const key=parent+':follow:1';
    const planner={plan:async()=>({reply:'Missing a source',coverage:[{index:0,status:'missing',finding:'Source',sources:[]}],
      actions:[{type:'consult',target:desk.target,title:'Check source',prompt:'Check proof source'}]})};
    const broker=async(route,data)=>{
      if(route==='/workers')return [desk];
      if(route==='/submit'){
        store.work.revise(parent,amendment,change);
        return {id:'delayed-claim',target:desk.target,state:'running',startedAt:'2030-01-03T00:00:00Z'};
      }
      assert.equal(route,'/cancelByRequestId');assert.equal(data.requestId,'personal:'+key);
      return {cancelled:true,task:{id:'delayed-claim',target:desk.target,state:'running',cancelRequested:1}};
    };
    await deliverWork({store,broker,planner});
    await deliverWork({store,broker,planner});
    const child=find(store,parent,key);
    assert.equal(child.scope,'paused');
    assert.equal(child.taskId,'delayed-claim');
    assert.match(child.progress,/等待执行端确认/);
    assert.equal(store.waiting().find(a=>a.id==='delayed-claim').turnId,parent);
    assert.equal(store.work.order(parent).state,'paused');
  }finally{store.db.close();}
});

test('an awaiting phone turn holds a fresh synthesis and prevents a stale reply after planning',async()=>{
  const store=new PersonalStore(':memory:');
  try{
    const parent=order(store);
    step(store,parent,'print','succeeded');
    let held=true,calls=0;
    store.heldForInput=()=>held;
    const planner={plan:async()=>{calls++;held=true;return plan('Old proof');}};
    const broker=async()=>[desk];
    await deliverWork({store,broker,planner});
    assert.equal(calls,0);
    held=false;await deliverWork({store,broker,planner});
    assert.equal(calls,1);
    assert.equal(store.history().messages.length,1);
    assert.equal(store.work.order(parent).failures,0);
  }finally{store.db.close();}
});

test('a legacy terminal receipt for a known running task cannot claim it was never picked up',()=>{
  const store=new PersonalStore(':memory:');
  try{
    const parent=order(store);
    store.work.stage(parent,'old-worker',desk,'dispatch','Check a proof');
    store.work.bind('old-worker',{id:'legacy',state:'running'});
    store.work.observe({id:'legacy',state:'cancelled',cancelRequested:1});
    store.work.revise(parent,amendment,{...change,pauseStepIds:['old-worker']});
    const progress=find(store,parent,'old-worker').progress;
    assert.match(progress,/回执/);
    assert.doesNotMatch(progress,/未接单|执行端已确认停止/);
  }finally{store.db.close();}
});

test('an ambiguous last submit failure recovers an accepted follow-up before reporting partial delivery',async()=>{
  const store=new PersonalStore(':memory:');
  try{
    const parent=order(store);
    step(store,parent,'print','succeeded');
    const key=parent+':follow:1';
    const planner={plan:async()=>({reply:'Need another sample.',coverage:[{index:0,status:'missing',finding:'Another sample',sources:[]}],
      actions:[{type:'consult',target:desk.target,prompt:'Check the sample'}]})};
    const broker=async(route,data)=>{
      if(route==='/workers')return [desk];
      assert.equal(data.requestId,'personal:'+key);
      if(route==='/submit')throw Error('Reply to accepted submission was lost');
      assert.equal(route,'/getByRequestId');
      return {id:'accepted-follow',state:'running',target:desk.target};
    };
    await deliverWork({store,broker,planner});
    store.db.prepare('UPDATE work_orders SET failures=3 WHERE id=?').run(parent);
    await deliverWork({store,broker,planner});
    assert.equal(store.work.order(parent).state,'working');
    assert.equal(find(store,parent,key).taskId,'accepted-follow');
    assert.equal(store.work.order(parent).decision,null);
    assert.equal(store.waiting().at(-1).id,'accepted-follow');
    assert.equal(store.history().messages.length,1);
  }finally{store.db.close();}
});

test('a late bind replaces an unsubmitted-stop assumption with the actual worker status',()=>{
  const store=new PersonalStore(':memory:');
  try{
    const parent=order(store);
    store.work.stage(parent,'pending',desk,'consult','Check page order');
    store.work.stopUnsubmitted('pending','cancelled','已取消');
    store.work.bind('pending',{id:'already-claimed',state:'running',startedAt:'2030-01-03T00:00:00Z',cancelRequested:1});
    const child=find(store,parent,'pending');
    assert.equal(child.state,'running');
    assert.equal(child.finishedAt,null);
    assert.match(child.progress,/等待执行端确认/);
  }finally{store.db.close();}
});

test('a stop can independently evidence status without sharing retired output or becoming a deliverable',async t=>{
  const store=new PersonalStore(':memory:');t.after(()=>store.db.close());
  const parent=order(store);
  step(store,parent,'digital','running');step(store,parent,'print','succeeded');
  store.work.revise(parent,amendment,{...change,criteria:['Print proof','Confirm stopped assignment']});
  store.work.observe({id:'digital-task',state:'cancelled',workerState:'cancelled',cancelRequested:1,result:'DO NOT DELIVER'});
  const planner={plan:async input=>{
    assert.deepEqual(input.results.map(r=>r.id),['print-task']);
    const [event]=input.scopeReceipts;
    assert.equal(event.workerConfirmedStop,true);
    assert.equal(event.result,undefined);
    return {reply:'Print proof ready, digital stopped.',actions:[],coverage:[
      {index:0,status:'answered',finding:'Print proof ready',sources:['print-task']},
      {index:1,status:'answered',finding:'Digital stopped',sources:[event.id],kind:'status'}]};
  }};
  await deliverWork({store,broker:async()=>[desk],planner});
  assert.equal(store.work.order(parent).state,'completed');
});

test('a status receipt cannot satisfy a content requirement',async t=>{
  const store=new PersonalStore(':memory:');t.after(()=>store.db.close());
  const parent=order(store);
  step(store,parent,'digital','running');step(store,parent,'print','succeeded');
  store.work.revise(parent,amendment,change);
  store.work.observe({id:'digital-task',state:'cancelled',workerState:'cancelled',cancelRequested:1});
  await deliverWork({store,broker:async()=>[desk],planner:{plan:async({scopeReceipts})=>({
    reply:'Missing print evidence.',actions:[],coverage:[
      {index:0,status:'answered',finding:'Missing print evidence.',sources:[scopeReceipts[0].id]}],
  })}});
  assert.equal(store.work.order(parent).state,'partial');
});
