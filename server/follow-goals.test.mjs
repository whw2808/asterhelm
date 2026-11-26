import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PersonalStore} from './personal-store.mjs';
import {FollowGoals} from './follow-goals.mjs';

const start=Date.UTC(2026,3,2,10);
const at=offset=>new Date(start+offset).toISOString();
const spec={title:'Cobalt atlas',terms:['Cobalt atlas']};
const workers=['desk','bench'].map(deviceId=>({deviceId,deviceName:deviceId,target:deviceId+'.code',agentName:'Studio',
  kind:'codex',online:true,capabilities:['contexts','read-only'],contextSources:['Codex Desktop']}));
function session(machine,title,text,time){
  const id=randomUUID();
  return {id,machine,target:machine+'.code',title,source:'Codex Desktop',createdAt:at(time-500),updatedAt:at(time),
    status:'completed',readOnly:true,visibility:'recent-dialogue',archived:false,summary:'',
    evidence:[{role:'assistant',text,at:at(time),turnId:id,itemId:'answer'}]};
}
function setup(t){
  t.mock.timers.enable({apis:['Date'],now:start});
  const dir=mkdtempSync(join(tmpdir(),'follow-goals-')),file=join(dir,'chat.sqlite');
  let store,goals;
  function open(){store=new PersonalStore(file);goals=new FollowGoals(store);}
  open();
  t.after(()=>{store.db.close();rmSync(dir,{recursive:true,force:true});});
  function receive(text,action,requestId=randomUUID()){
    return store.receive({requestId,text},null,turn=>{
      const card=action(turn);store.finish(turn,'OK');return {id:turn.id,card};
    });
  }
  return {
    register(input=spec,requestId){return receive('Follow '+input.title,turn=>goals.register(turn,input),requestId);},
    choose(card,decision){return receive(`星舵操作 ${card.id} v${card.version} ${decision}`,turn=>goals.decide(turn,{id:card.id,version:card.version,decision})).card;},
    observe(rows,offset){t.mock.timers.setTime(start+offset);goals.observe({rows,workers,tasks:[],coverage:[],now:Date.now()});},
    notices(){return store.notifications().items;},get goals(){return goals;},get store(){return store;},
    restart(){store.db.close();open();}
  };
}
test('a preview stays in its original chat with attributed examples across devices and no side effects',t=>{
  const f=setup(t),creation=f.register(spec,'follow-atlas'),{card}=creation;
  const a=session('desk','Cobalt atlas','Completed the Cobalt atlas index and verified all 23 entries.',-2000);
  const b=session('bench','Cobalt atlas','Blocked on the Cobalt atlas cover pending approval.',-1000);
  const unrelated=session('bench','Maple quilt','Completed the Maple quilt stitching guide.',-500);
  f.observe([a,b,unrelated],1000);
  const preview=f.goals.get(card.id);
  assert.equal(preview.kind,'goal');assert.equal(preview.status,'preview');assert.equal(preview.messageId,creation.id);
  assert.deepEqual(new Set(preview.findings.map(x=>x.deviceId)),new Set(['desk','bench']));
  assert.ok(preview.findings.every(x=>x.wouldNotify&&x.notificationText.includes(x.summary)&&x.notifyReason));
  assert.ok(preview.findings.every(x=>x.notificationText.includes(x.sourceLabel)&&x.notificationText.includes('GMT')&&!x.notificationText.includes(x.at)));
  assert.deepEqual(f.notices(),[]);
  assert.equal(f.register(spec,'follow-atlas').id,creation.id);
  assert.deepEqual(f.goals.cards(new Set([creation.id])),[preview]);
  assert.deepEqual(f.goals.cards([]),[]);
  assert.equal(f.store.history().messages.length,2);
  assert.equal(f.store.work.activeCount(),0);
  assert.doesNotMatch(JSON.stringify(preview),/Maple quilt/);
  f.observe([],2000);f.restart();
  assert.deepEqual(f.goals.get(card.id).findings.map(x=>x.key),preview.findings.map(x=>x.key));
  assert.ok(f.goals.get(card.id).findings.every(x=>!x.wouldNotify));
});
test('only later facts alert, once per refresh, and queued snapshots cannot revive alerts after pause or stop',t=>{
  const f=setup(t),{card}=f.register(),prior=session('desk','Cobalt atlas','Completed the Cobalt atlas binding.',-3000);
  f.observe([prior],1000);
  const enabled=f.choose(card,'enable');
  assert.equal(enabled.status,'enabled');assert.deepEqual(f.notices(),[]);
  const backfill=session('bench','Cobalt atlas','Completed the Cobalt atlas checklist.',500);
  const newDesk=session('desk','Cobalt atlas','Completed Cobalt atlas final proofs for all 12 plates.',3000);
  const newBench=session('bench','Cobalt atlas','Blocked on Cobalt atlas print approval.',4000);
  f.observe([prior,backfill,newDesk,newBench],5000);
  const [notice]=f.notices();assert.equal(f.notices().length,1);
  assert.ok(notice.text.includes(f.goals.get(card.id).findings.find(x=>x.sourceId===newDesk.id).notificationText));
  assert.doesNotMatch(notice.text,/checklist|binding/);
  assert.equal(f.store.history().messages.find(x=>x.id===notice.id).parent,card.messageId);
  f.restart();f.observe([newBench,newDesk],6000);assert.equal(f.notices().length,1);
  assert.throws(()=>f.choose(card,'enable'));
  const paused=f.choose(enabled,'pause');assert.equal(paused.status,'paused');
  const during=session('desk','Cobalt atlas','Completed Cobalt atlas cover samples.',7000);
  f.observe([during],8000);assert.equal(f.notices().length,1);
  const resume=f.choose(paused,'enable');f.observe([during],9000);
  assert.equal(f.notices().length,1);
  const stop=f.choose(resume,'stop');assert.equal(stop.status,'stopped');assert.deepEqual(stop.actions,[]);
  const after=session('desk','Cobalt atlas','Completed Cobalt atlas delivery.',10000);
  f.observe([after],11000);f.restart();assert.equal(f.notices().length,1);
  assert.ok(f.goals.get(card.id).findings.every(x=>x.sourceId!==after.id));
});
test('registration, expiration and decisions require valid user-owned state',t=>{
  const f=setup(t);
  assert.throws(()=>f.goals.register({id:'no-user'},spec));
  const historical=f.store.receive({requestId:'old-message',text:'Which atlas do I own?'});
  f.store.finish(historical,'The cobalt edition.');
  assert.throws(()=>f.goals.register(historical,spec));
  assert.throws(()=>f.register({...spec,scopes:[{}]}));
  assert.throws(()=>f.register({...spec,until:'tomorrow'}));
  const {card}=f.register({...spec,until:at(3000)});
  assert.throws(()=>f.goals.decide({id:'reply-'+card.messageId},{id:card.id,version:1,decision:'enable'}));
  assert.throws(()=>f.goals.decide({id:card.messageId},{id:card.id,version:1,decision:'enable'}));
  const enabled=f.choose(card,'enable');
  const late=session('desk','Cobalt atlas','Completed Cobalt atlas final volume.',3500);
  f.observe([late],4000);assert.deepEqual(f.notices(),[]);
  assert.equal(f.goals.get(card.id).status,'stopped');assert.throws(()=>f.choose(enabled,'enable'));
});
test('explicit signal categories narrow the preview and live notices to the selected kind',t=>{
  const f=setup(t),{card}=f.register({...spec,signals:['blocker']});
  const result=session('desk','Cobalt atlas','Completed the Cobalt atlas proof pages.',-1000);
  const blocked=session('bench','Cobalt atlas','Blocked on Cobalt atlas approval.',-500);
  const requested=session('bench','Cobalt atlas','Please finish the Cobalt atlas paper samples.',-100);
  requested.evidence[0].role='user';
  f.observe([result,blocked,requested],1000);
  const findings=f.goals.get(card.id).findings;
  assert.equal(findings.find(x=>x.sourceId===result.id)?.wouldNotify,false);
  assert.equal(findings.find(x=>x.sourceId===blocked.id)?.wouldNotify,true);
  assert.ok(!findings.find(x=>x.sourceId===requested.id)?.wouldNotify);
  f.choose(card,'enable');
  f.observe([session('desk','Cobalt atlas','Completed the Cobalt atlas proofs and verified all pages.',2000)],2500);
  assert.equal(f.notices().length,0);
  f.observe([session('bench','Cobalt atlas','Blocked on Cobalt atlas approval for the final volume.',3000)],3500);
  assert.equal(f.notices().length,1);
});
test('paused and expired goals need no background observations',t=>{
  const f=setup(t);assert.equal(f.goals.hasActive(),false);
  const {card}=f.register({...spec,until:at(3000)});assert.equal(f.goals.hasActive(),true);
  const paused=f.choose(card,'pause');assert.equal(f.goals.hasActive(),false);
  const preview=f.choose(paused,'preview');assert.equal(f.goals.hasActive(),true);
  t.mock.timers.setTime(start+3000);assert.equal(f.goals.hasActive(),false);
  assert.equal(f.goals.get(preview.id).status,'stopped');
});
test('refresh planning excludes inactive scopes and cached evidence loses its live status after an outage',t=>{
  const f=setup(t),row=session('desk','Cobalt atlas','Completed the Cobalt atlas index.',-1000);
  const scope={machine:row.machine,id:row.id,target:row.target};
  const {card}=f.register({...spec,scopes:[scope]});
  assert.deepEqual(f.goals.activeSpecs(),[{title:'Cobalt atlas',scopes:[scope]}]);
  f.observe([row],1000);
  assert.equal(f.goals.get(card.id).findings[0].wouldNotify,true);
  t.mock.timers.setTime(start+2*86400000);
  const cached=f.goals.get(card.id).findings[0];
  assert.equal(cached.sourceId,row.id);assert.equal(cached.wouldNotify,false);assert.notEqual(cached.freshness,'recent');
  f.choose(card,'pause');assert.deepEqual(f.goals.activeSpecs(),[]);
});
test('a failed observation rolls back its delivery and can retry without losing or duplicating the new fact',t=>{
  const f=setup(t),{card}=f.register();f.observe([],1000);f.choose(card,'enable');
  const row=session('desk','Cobalt atlas','Completed the Cobalt atlas index.',2000);
  f.store.db.exec("CREATE TRIGGER fail_notice BEFORE INSERT ON notices BEGIN SELECT raise(ABORT,'disk issue'); END");
  assert.throws(()=>f.observe([row],3000),/disk issue/);
  assert.deepEqual(f.goals.get(card.id).findings,[]);assert.deepEqual(f.notices(),[]);
  f.store.db.exec('DROP TRIGGER fail_notice');
  f.restart();f.observe([row],4000);f.observe([row],5000);
  assert.equal(f.goals.get(card.id).findings.length,1);assert.equal(f.notices().length,1);
});
