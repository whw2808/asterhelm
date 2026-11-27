import test from 'node:test';
import assert from 'node:assert/strict';
import {PersonalStore} from './personal-store.mjs';
import {ProactiveCandidates} from './proactive-candidates.mjs';
import {configuredQueue} from './test-support/registered-queue.mjs';

async function gallery(t){
  const store=new PersonalStore(':memory:'),queue=configuredQueue(':memory:'),engine=new ProactiveCandidates(store);
  t.after(()=>{store.db.close();queue.close();});
  queue.beat('desk.code',null,'ready',null,true);
  const start=Date.now(),stamp=delta=>new Date(start+delta).toISOString();
  const row={machine:'desk',id:'paper-catalogue',target:'desk.code',source:'Codex Desktop',title:'Paper catalogue',cwd:'/gallery/paper',
    visibility:'recent-dialogue',readOnly:true,archived:false,status:'completed',updatedAt:stamp(-10000),evidence:[
      {role:'user',turnId:'print',itemId:'ask',at:stamp(-15000),text:'Check this catalogue for the exhibition.'},
      {role:'assistant',turnId:'print',itemId:'gap',at:stamp(-10000),text:'Still pending: catalogue.csv is missing the paper checklist.'}]};
  const grant=store.receive({requestId:'source',text:'Watch this catalogue session.'});
  store.finish(grant,'Watching.');store.watch('watch-paper',{...row,updatedAt:stamp(-20000)},'Gallery update',grant.id);
  const broker=async(route,arg)=>{
    if(route==='/submit')return queue.submit(arg);
    if(route==='/get')return queue.get(arg.id);
    if(route==='/cancelByRequestId')return queue.cancelByRequestId(arg.requestId);
    if(route==='/getByRequestId')return queue.getByRequestId(arg.requestId);
    throw Error('Unexpected '+route);
  };
  const tick=planner=>engine.tick({rows:[row],workers:queue.workers(),now:start+9000,broker,planner});
  await tick();
  const initial=queue.claim('desk.code');
  queue.finish(initial.target,{id:initial.id,state:'succeeded',result:'The checklist has not arrived.'});await tick();
  return {engine,queue,row,tick,update(role,text,delta){
    row.evidence.push({role,text,at:stamp(delta),turnId:'later',itemId:'item-'+delta});row.updatedAt=stamp(delta);
  },recheck(){
    const [c]=engine.cards(),turn=store.receive({requestId:'again',text:'One more check on the paper list.'});
    engine.decide(turn,{id:c.id,version:c.version,decision:'recheck'});
  }};
}
function response(input,state){
  const event=input.events.at(-1);
  return {reply:'',actions:[{type:'candidate_source_status',id:input.candidate.id,version:input.candidate.version,
    state,turnId:event.turnId,itemId:event.itemId}]};
}
test('a source discussing withdrawal preserves the phone recheck and the same event is reviewed once',async t=>{
  const f=await gallery(t);f.recheck();
  f.update('user','Does “cancel the checklist” mean we would lose the catalogue? Keep the check going.',3000);
  let calls=0;
  const planner={plan:async input=>{calls++;return response(input,'keep');}};
  await f.tick(planner);await f.tick(planner);
  assert.equal(f.engine.cards()[0].status,'checking');assert.equal(f.queue.list().length,2);assert.equal(calls,1);
});
test('a later desktop user withdrawal can cancel an in-flight phone recheck without a matching keyword',async t=>{
  const f=await gallery(t);f.recheck();await f.tick();
  const active=f.queue.claim('desk.code');
  f.update('user','Ce contrôle du catalogue ne doit plus avoir lieu.',4000);
  await f.tick({plan:async input=>response(input,'withdrawn')});
  assert.equal(f.engine.cards()[0].status,'ignored');assert.equal(f.queue.get(active.id).cancelRequested,1);
});
test('an older source message cannot countermand a newer phone recheck',async t=>{
  const f=await gallery(t);
  f.update('user','Cancel this catalogue check.',-6000);
  f.recheck();
  let calls=0;await f.tick({plan:async input=>{calls++;return response(input,'withdrawn');}});
  assert.equal(calls,0);assert.equal(f.engine.cards()[0].status,'checking');assert.equal(f.queue.list().length,2);
});

test('a newer phone decision supersedes a desktop assessment already in flight',async t=>{
  const f=await gallery(t);
  f.update('user','Please close this candidate.',-2000);
  let received,complete;
  const ready=new Promise(resolve=>{received=resolve;});
  const result=new Promise(resolve=>{complete=resolve;});
  const assessing=f.tick({plan:async input=>{received(input);return result;}});
  const input=await ready;f.recheck();complete(response(input,'withdrawn'));
  await assessing;await f.tick();
  assert.equal(f.engine.cards()[0].status,'checking');assert.equal(f.queue.list().length,2);
});
test('a changed timestamp cannot turn the original immutable source item into a new instruction',async t=>{
  const f=await gallery(t);
  f.row.evidence[1].at=new Date().toISOString();
  let calls=0;
  await f.tick({plan:async input=>{calls++;return response(input,'resolved');}});
  assert.equal(calls,0);assert.equal(f.engine.cards()[0].status,'waiting');
});
test('a newer assistant report does not withhold an independently requested phone recheck when the model is offline',async t=>{
  const f=await gallery(t);f.recheck();
  f.update('assistant','All entries in catalogue.csv are complete; nothing is missing.',3000);
  await f.tick({offline:true});
  assert.equal(f.engine.cards()[0].status,'checking');assert.equal(f.queue.list().length,2);
});
