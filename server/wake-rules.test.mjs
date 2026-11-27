import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PersonalStore} from './personal-store.mjs';
import {configuredQueue} from './test-support/registered-queue.mjs';

import {WakeRules} from './wake-rules.mjs';
const instant='2026-03-05T15:00:00.000Z';
const ms=Date.parse(instant);
function rig(t){
  const dir=mkdtempSync(join(tmpdir(),'exhibit-wake-'));
  const queue=configuredQueue(':memory:');
  const state={queue,events:[],lost:false};
  function open(){
    state.store=new PersonalStore(join(dir,'chat.db'));
    state.rules=new WakeRules(state.store);
  }
  open();
  t.after(()=>{state.store.db.close();queue.close();rmSync(dir,{recursive:true,force:true});});
  state.restart=()=>{state.store.db.close();open();};
  queue.beat('desk.code',null,'ready',null,true);
  const broker=async(path,input)=>{
    if(path==='/wakeEvents'){
      const items=state.events.filter(e=>e.seq>input.after).slice(0,2);
      return {items,cursor:items.at(-1)?.seq??input.after,hasMore:state.events.some(e=>e.seq>(items.at(-1)?.seq??input.after))};
    }
    if(path==='/submit'){
      const task=queue.submit(input);
      if(state.lost){state.lost=false;throw Error('response lost');}
      return task;
    }
    if(path==='/getByRequestId')return queue.getByRequestId(input.requestId);
    if(path==='/cancelByRequestId')return queue.cancelByRequestId(input.requestId);
    if(path==='/get')return queue.get(input.id);
    throw Error('Unknown route '+path);
  };
  state.add=(text,a,extra={})=>{
    const turn={...state.store.receive({requestId:crypto.randomUUID(),text}),text};
    const snap={timeZone:'UTC',now:instant,workers:queue.workers(),tasks:[],sessions:[],wakeCursor:state.events.at(-1)?.seq??0,...extra};
    const action=state.rules.check({type:'wake_rule',effect:'notify',repeat:'each',evidence:text,...a},turn,snap);
    state.store.transact(()=>{state.rules.register(turn.id+'-0',turn,action);state.store.finish(turn,'已登记');});
    return turn;
  };
  state.decide=(decision,options={})=>{
    const text='规则卡操作 '+decision;
    const turn={...state.store.receive({requestId:crypto.randomUUID(),text}),text};
    const {id,version}=state.rules.cards()[0];
    const card=state.rules.decide(turn,{decision,id,version,...options});
    state.store.transact(()=>state.store.finish(turn,'已处理'));
    return card;
  };
  state.tick=(now=ms,extra={})=>state.rules.tick({broker,workers:queue.workers(),tasks:queue.list(),rows:[],now,...extra});
  state.event=(id,seq,over={})=>state.events.push({seq,id,target:'desk.code',title:'纸本校对：展览图册',state:'failed',finishedAt:new Date(ms+seq*1000).toISOString(),requestId:'phone-'+id,...over});
  state.notices=()=>state.store.notifications().items.map(n=>n.text);
  return state;
}
const failure={trigger:'task_failed',match:'校对'};
const notify='每次新的校对任务失败都提醒我';
const consult='每次新的校对任务失败就让 desk.code 做一次只读复核';

test('replays each in-scope failure once after registration, across restarts and pages',async t=>{
  const f=rig(t);f.event('old',1);
  f.add(notify,failure);
  f.event('one',2);f.event('one',3);f.event('shipment',4,{title:'展品运输'});f.event('two',5);
  await f.tick(ms+10000);f.restart();await f.tick(ms+12000);
  assert.equal(f.notices().length,2);
  assert.equal(f.queue.list().length,0);
  assert.equal(f.rules.cards()[0].status,'active');
  assert.equal(f.store.continuity.participants().length,0);
});

test('each review keeps one work identity, reconciles a lost response and excludes rule-generated receipts',async t=>{
  const f=rig(t),turn=f.add(consult,{...failure,effect:'consult',target:'desk.code'});
  f.event('one',1);f.lost=true;
  await f.tick(ms+1000);f.restart();await f.tick(ms+65000);
  let queued=f.queue.list();
  assert.equal(queued.length,1);
  assert.equal(queued[0].mode,'read-only');
  assert.equal(queued[0].exportFile,false);
  const task=f.queue.claim('desk.code');
  f.queue.finish('desk.code',{id:task.id,state:'failed',result:'虚构的图册清单缺页'});
  f.event(task.id,2,{title:'校对任务',requestId:task.requestId});f.event('two',3);
  await f.tick(ms+70000);await f.tick(ms+75000);
  assert.equal(f.queue.list().length,2);
  assert.match(f.notices().join('\n'),/失败/);
  const card=f.rules.cards()[0];
  assert.equal(card.workId,turn.id);assert.equal(card.status,'active');
  assert.equal(f.store.continuity.workForTurn(turn.id),turn.id);
  assert.equal(f.store.continuity.participants().length,0);
});

test('cancelling an ambiguous submission after restart withdraws the original key and still records the real worker receipt',async t=>{
  const f=rig(t);
  f.add(consult,{...failure,effect:'consult',target:'desk.code'});
  f.event('one',1);f.lost=true;
  await f.tick(ms+5000);const active=f.queue.claim('desk.code');
  assert.ok(active);
  f.decide('cancel');f.restart();await f.tick(ms+10000);
  assert.equal(f.queue.get(active.id).cancelRequested,1);
  f.queue.finish('desk.code',{id:active.id,state:'succeeded',result:'取消时已完成对照'});
  f.event('two',2);await f.tick(ms+30000);
  assert.equal(f.queue.list().length,1);
  const card=f.rules.cards()[0];
  assert.equal(card.status,'cancelled');assert.match(card.detail,/回执|已完成/);
  assert.ok(card.finishedAt);
});

test('missed weekday reviews coalesce after a DST change and continue at the local hour',async t=>{
  const f=rig(t);
  f.add('每个工作日上午九点提醒我看纸本图册',{trigger:'time',repeat:'weekdays',dueAt:'2026-03-06T09:00:00-05:00',timeZone:'America/New_York'});
  await f.tick(Date.parse('2026-03-11T16:00:00Z'));f.restart();await f.tick(Date.parse('2026-03-11T16:01:00Z'));
  assert.equal(f.notices().length,1);assert.equal(f.rules.cards()[0].nextAt,'2026-03-12T13:00:00.000Z');
});

test('snapshot-only online edges retain baseline through unavailable data and report observation gaps',async t=>{
  const f=rig(t),workers=f.queue.workers();
  f.add('每次 desk.code 重新上线都提醒我',{trigger:'agent_online',sourceTarget:'desk.code'},{workers});
  await f.tick(ms+1000,{workers:[]});
  f.restart();await f.tick(ms+86400000,{workers});
  assert.equal(f.notices().length,0);assert.match(f.rules.cards()[0].detail,/观测缺口/);
  await f.tick(ms+86401000,{workers:workers.map(w=>({...w,online:false}))});
  await f.tick(ms+86402000,{workers});await f.tick(ms+86403000,{workers});
  assert.equal(f.notices().length,1);
});

test('a one-shot current condition uses an existing registered-agent status immediately',async t=>{
  const f=rig(t);
  f.add('desk.code 如果已在线就提醒我一次',{trigger:'agent_online',sourceTarget:'desk.code',repeat:'once',timing:'current'});
  await f.tick();await f.tick(ms+500);
  assert.equal(f.notices().length,1);assert.equal(f.rules.cards()[0].status,'completed');
});

test('a rule needs a signed source excerpt, a supported effect and an observable trigger',t=>{
  const f=rig(t);
  assert.throws(()=>f.add(notify,{...failure,evidence:'另一条留言'}));
  assert.throws(()=>f.add(notify,{...failure,effect:'dispatch'}));
  assert.throws(()=>f.add(notify,{...failure,trigger:'wind_changed'}));
  assert.throws(()=>f.add(notify,{trigger:['task_failed']}));
  assert.throws(()=>f.add(notify,failure,{wakeCursor:null}));
  assert.throws(()=>f.add(notify,{...failure,sourceTarget:'missing.agent'}));
  assert.throws(()=>f.add(notify,{...failure,taskId:'missing-task'}));
  assert.equal(f.rules.cards().length,0);
});

test('a resumed rule skips paused receipts by cursor but catches new late-arriving ones',async t=>{
  const f=rig(t);
  f.add(notify,failure);
  f.event('one',1);await f.tick(ms+2000);f.decide('pause');
  f.event('paused',2);await f.tick(ms+8000);
  f.decide('resume',{cursor:2});
  f.event('arrived-later',3);await f.tick(ms+12000);
  assert.equal(f.notices().length,2);assert.match(f.notices()[1],/arrived-later/);
  assert.throws(()=>f.decide('cancel',{version:1}));
});

test('a scheduled rule reconciles its last due report after the end date, and closes at that boundary',async t=>{
  const f=rig(t);
  f.add('每天九点提醒我看纸本图册，截止周一',{trigger:'time',repeat:'daily',dueAt:'2026-03-06T09:00:00Z',endAt:'2026-03-09T12:00:00Z'});
  await f.tick(Date.parse('2026-03-12T17:00:00Z'));await f.tick(Date.parse('2026-03-12T17:01:00Z'));
  assert.equal(f.notices().length,1);assert.equal(f.rules.cards()[0].status,'completed');
});

test('review requires an isolated read-only worker with available credentials',t=>{
  const f=rig(t),review={...failure,effect:'consult',target:'desk.code'};
  for(const override of [{isolatedRead:false},{capabilities:['workspace-write']},{needsCredentials:true}]){
    assert.throws(()=>f.add(consult,review,{workers:f.queue.workers().map(w=>({...w,...override}))}));
  }
  assert.equal(f.rules.cards().length,0);
});

test('only the originating reviewer receives a bounded copy of its own terminal evidence',async t=>{
  const f=rig(t);
  f.queue.beat('bench.code',null,'ready',null,true);
  f.add(consult,{...failure,effect:'consult',target:'desk.code'});
  for(const target of ['desk.code','bench.code']){
    const item=f.queue.submit({target,prompt:'校对纸本图册'});
    f.queue.claim(target);f.queue.finish(target,{id:item.id,state:'failed',result:target==='desk.code'?'虚构页码 17 缺项':'异机私有运单 55'});
    f.event(item.id,f.events.length+1,{target});
  }
  await f.tick(ms+5000);
  const tasks=f.queue.list().filter(t=>t.state==='queued').map(t=>f.queue.get(t.id).prompt);
  assert.equal(tasks.length,2);
  assert.ok(tasks.some(text=>text.includes('虚构页码 17 缺项')));
  assert.ok(tasks.every(text=>!text.includes('异机私有运单 55')));
});

test('an explicit session monitor uses its own stable watermark without treating missing or stale snapshots as updates',async t=>{
  const f=rig(t),row={machine:'desk',id:'session-blue',target:'desk.code',title:'虚构展厅清单',updatedAt:instant};
  f.add('每次虚构展厅清单会话更新都提醒我',{trigger:'session_changed',machine:'desk',sessionId:row.id},{sessions:[row]});
  await f.tick(ms+2000,{rows:[]});
  const next={...row,updatedAt:new Date(ms+1000).toISOString()};
  await f.tick(ms+3000,{rows:[next]});f.restart();
  await f.tick(ms+4000,{rows:[row]});await f.tick(ms+5000,{rows:[next]});
  assert.equal(f.notices().length,1);assert.match(f.rules.cards()[0].detail,/观测缺口/);
});

test('an observational gap and reacquisition cannot widen a rule past the original work revision',async t=>{
  const f=rig(t);
  const turn=f.add(consult,{...failure,effect:'consult',target:'desk.code'});
  // The same work can acquire a formal order later.
  f.store.work.create(turn,['展厅清单']);
  f.store.work.setState(turn.id,'cancelled');
  f.event('one',1);await f.tick(ms+2000);
  assert.equal(f.queue.list().length,0);
  assert.equal(f.rules.cards()[0].status,'blocked');
});

test('task titles containing command words are literal event filters',async t=>{
  const f=rig(t);
  f.add('Si «cancel» échoue, un mot sur mon téléphone.',{
    trigger:'task_failed',match:'cancel',sourceTarget:'',dueAt:'',endAt:'',
  });
  f.event('other-exhibit',1,{title:'Photo catalogue'});
  f.event('matching-exhibit',2,{title:'Cancel — exhibit catalogue'});
  await f.tick(ms+3000);
  assert.equal(f.notices().length,1);
  assert.match(f.notices()[0],/matching-exhibit/);
});

test('an event source that fails backs off and retries without swallowing its unprocessed receipt',async t=>{
  const f=rig(t);
  f.add(notify,failure);f.event('receipt',1);
  let calls=0;
  const unavailable=async()=>{calls++;throw Error('temporary transport');};
  await f.tick(ms+1000,{broker:unavailable});await f.tick(ms+1250,{broker:unavailable});
  assert.equal(calls,1);
  assert.match(f.rules.cards()[0].detail,/回执来源/);
  await f.tick(ms+15000);assert.match(f.notices().join(' '),/receipt/);
  assert.doesNotMatch(f.rules.cards()[0].detail,/暂不可用/);
});

test('registered snapshot monitors record loss of visibility without disclosing cross-connector desktop bodies',async t=>{
  const f=rig(t),row={machine:'desk',id:'session-blue',target:'desk.code',title:'虚构展厅清单',updatedAt:instant,readOnly:true,visibility:'recent-dialogue'};
  f.add('每次虚构展厅清单会话更新就让 desk.code 只读复核',{trigger:'session_changed',machine:'desk',sessionId:row.id,effect:'consult',target:'desk.code'},{sessions:[row]});
  const at=toISO(ms+2000);
  const change={...row,updatedAt:at,evidence:[{role:'assistant',text:'虚构的插页清单少第六页',at,turnId:'gallery-turn',itemId:'item-a'}]};
  await f.tick(ms+3000,{rows:[change]});
  const created=f.queue.list().at(0);assert.ok(created);
  assert.match(f.queue.get(created.id).prompt,/虚构的插页清单少第六页/);
  function toISO(n){return new Date(n).toISOString();}
});

test('inputs held for a new decision freeze notifications and release once the decision is classified',async t=>{
  const f=rig(t);
  f.add(notify,failure);
  const correction=f.store.receive({requestId:'later',text:'Il faut mon accord avant de poursuivre.'});
  f.event('wait',1);await f.tick(ms+5000);
  assert.equal(f.notices().length,0);
  f.store.finish(correction,'已收到');
  await f.tick(ms+10000);assert.equal(f.notices().length,1);
});

test('the phone can select one page of rules by the original grant messages',t=>{
  const f=rig(t),one=f.add(notify,failure),two=f.add(notify,failure);
  assert.deepEqual(f.rules.cards([two.id]).map(c=>c.messageId),[two.id]);
  assert.equal(f.rules.cards([]).length,0);
  assert.ok(f.rules.cards().some(c=>c.messageId===one.id));
});

test('session monitoring pins a live source by machine and id and consults only its owning connector',t=>{
  const f=rig(t),row={machine:'desk',target:'desk.code',id:'same-title-a',title:'展厅清单',updatedAt:instant};
  const event={trigger:'session_changed',machine:'desk',sessionId:row.id};
  const text='Ce dossier-ci mérite un suivi.';
  for(const sessions of [[],[{...row,archived:true}],[{...row,machine:'bench'}]]){
    assert.throws(()=>f.add(text,event,{sessions}));
  }
  const workers=f.queue.workers(),own=workers.find(w=>w.target==='desk.code');
  const other={...own,target:'desk.archive',agentName:'Archive'};
  assert.throws(()=>f.add(text,{...event,effect:'consult',target:other.target},{sessions:[row],workers:[own,other]}));
  f.add(text,event,{sessions:[{...row,id:'same-title-b'},row]});
  assert.match(f.rules.cards()[0].detail,/same-title-a/);
});

test('a reviewer with a blocked occurrence clears the mobile blockage once the same request resumes',async t=>{
  const f=rig(t);f.add(consult,{...failure,effect:'consult',target:'desk.code'});
  f.event('one',1);
  await f.tick(ms+1000,{workers:f.queue.workers().map(w=>({...w,isolatedRead:false}))});
  assert.match(f.rules.cards()[0].detail,/受阻/);
  await f.tick(ms+11000);assert.equal(f.queue.list().length,1);
  assert.doesNotMatch(f.rules.cards()[0].detail,/受阻/);
});

test('an expired consult does not acquire a new worker task after a long shutdown',async t=>{
  const f=rig(t);
  f.add('每天九点让 desk.code 只读复核纸本图册，截止周一',{trigger:'time',repeat:'daily',dueAt:'2026-03-06T09:00:00Z',endAt:'2026-03-09T12:00:00Z',effect:'consult',target:'desk.code'});
  await f.tick(Date.parse('2026-03-12T17:00:00Z'));
  assert.equal(f.queue.list().length,0);assert.equal(f.rules.cards()[0].status,'completed');
});

test('a calendar rule keeps the local time and weekday schedule for a paraphrased instruction',async t=>{
  const f=rig(t),text='Les jours ouvrés à neuf heures, un mot pour relire le catalogue.';
  f.add(text,{trigger:'time',repeat:'weekdays',dueAt:'2026-03-06T09:00:00+01:00',timeZone:'Europe/Paris'});
  await f.tick(Date.parse('2026-03-06T08:00:00Z'));
  assert.equal(f.notices().length,1);
  assert.equal(f.rules.cards()[0].nextAt,'2026-03-09T08:00:00.000Z');
});

test('rules can share the same evidence and exact duplicate proposals keep one registration across retries',async t=>{
  const f=rig(t),text='校对每次失败、图册运输每次成功，都给我一个提醒。';
  const turn={...f.store.receive({requestId:'shared-clause',text}),text};
  const snap={now:instant,timeZone:'UTC',wakeCursor:0,workers:f.queue.workers(),tasks:[],sessions:[]};
  const check=(fields,cursor)=>f.rules.check({type:'wake_rule',repeat:'each',effect:'notify',evidence:text,...fields},turn,{...snap,wakeCursor:cursor});
  const first=check(failure,0),retry=check(failure,7);
  const other=check({trigger:'task_succeeded',match:'图册运输'},0);
  assert.deepEqual(f.rules.uniqueGrants([first,retry,other]),[first,other]);
  f.rules.register('first',turn,first);
  f.rules.register('other',turn,other);
  f.restart();
  assert.equal(f.rules.register('duplicate-position',turn,retry).id,'first');
  assert.equal(f.rules.cards().length,2);
  f.store.finish(turn,'已登记');
  f.event('paper',1);f.event('shipping',2,{state:'succeeded',title:'图册运输'});
  await f.tick(ms+5000);assert.equal(f.notices().length,2);
});

test('separate reminders at the same hour keep the individual subject of each grant',async t=>{
  const f=rig(t),first='每天九点提醒我核对纸本',second='每天九点提醒我检查展柜';
  const text=first+'。'+second;
  const turn={...f.store.receive({requestId:'separate-reminders',text}),text};
  const grants=[first,second].map(evidence=>f.rules.check({type:'wake_rule',trigger:'time',repeat:'daily',effect:'notify',dueAt:'2026-03-06T09:00:00Z',evidence},turn,{now:instant,timeZone:'UTC'}));
  assert.equal(f.rules.uniqueGrants(grants).length,2);
  grants.forEach((g,i)=>f.rules.register('schedule-'+i,turn,g));f.store.finish(turn,'已登记');
  await f.tick(Date.parse('2026-03-06T09:00:00Z'));
  assert.deepEqual(f.rules.cards().map(c=>c.title).sort(),[first,second].sort());
  assert.equal(f.notices().length,2);assert.ok(f.notices().every(n=>!(n.includes('展柜')&&n.includes('纸本'))));
});

test('overlapping excerpts at one scheduled time keep the two distinct reminder subjects',async t=>{
  const f=rig(t),text='每天九点分别给我两条提醒，第一条写「展柜图册」，第二条写「展柜」。';
  const turn={...f.store.receive({requestId:'overlapping-labels',text}),text};
  const actions=['展柜图册','展柜'].map(evidence=>f.rules.check({type:'wake_rule',trigger:'time',
    repeat:'daily',dueAt:'2026-03-06T09:00:00Z',evidence},turn,{now:instant,timeZone:'UTC'}));
  const rules=f.rules.uniqueGrants(actions);
  assert.equal(rules.length,2);
  rules.forEach((g,i)=>f.rules.register('schedule-'+i,turn,g));f.store.finish(turn,'已登记');
  await f.tick(Date.parse('2026-03-06T09:00:00Z'));
  assert.deepEqual(f.rules.cards().map(c=>c.title).sort(),['展柜','展柜图册']);
  assert.equal(f.notices().length,2);
});

test('event machine qualifiers resolve to the registered source device',t=>{
  const f=rig(t);
  for(const event of [failure,{trigger:'task_succeeded'},{trigger:'agent_online'}]){
    assert.throws(()=>f.add(notify,{...event,sourceTarget:'desk.code',machine:'bench'}));
    assert.throws(()=>f.add(notify,{...event,machine:'desk'}));
    const turn=f.add(notify,{...event,sourceTarget:'desk.code',machine:'desk'});
    const spec=JSON.parse(f.rules.rule(turn.id+'-0').spec);
    assert.equal(spec.sourceDevice,'desk');assert.equal(spec.sourceTarget,'desk.code');
  }
});

test('an open rule has no deadline and bounded rules require valid instants in range',t=>{
  const f=rig(t);
  f.add('每次新的图册校对任务失败都提醒我，直到我取消',{trigger:'task_failed',match:'图册校对'});
  f.add('Whenever a proofreading task fails, notify me until I cancel.',{trigger:'task_failed',match:'proofreading'});
  assert.equal(f.rules.cards().filter(c=>c.status==='active'&&c.nextAt===null).length,2);
  for(const endAt of ['2026-03-06','invalid','2026-03-04T12:00:00Z','2026-04-31T12:00:00Z']){
    assert.throws(()=>f.add(notify,{...failure,endAt}));
  }
  const schedule={trigger:'time',repeat:'weekdays',dueAt:'2026-03-06T09:00:00Z'};
  assert.throws(()=>f.add(notify,{...schedule,endAt:'2026-03-06T08:59:00Z'}));
  assert.throws(()=>f.add(notify,{...schedule,dueAt:'2026-03-07T09:00:00Z'}));
  assert.throws(()=>f.add(notify,{...schedule,timeZone:'Planet/Nowhere'}));
});

test('each trigger retains only the scopes and schedules it can enforce',t=>{
  const f=rig(t),time={trigger:'time',dueAt:'2026-03-06T09:00:00Z',repeat:'once'};
  for(const spec of [
    {...failure,repeat:'daily'},{...failure,dueAt:time.dueAt},{...failure,match:42},
    {...failure,target:'desk.code'},{...failure,remindEveryHours:2},
    {...time,timing:'current'},{...time,repeat:'each'},{...time,taskId:'catalogue'},{...time,match:'校对'},
    {...time,sourceTarget:'desk.code'},{...failure,sessionId:'blue'},{...failure,machine:'desk'},
  ]){
    assert.throws(()=>f.add(notify,spec),JSON.stringify(spec));
  }
  assert.equal(f.rules.cards().length,0);
});

test('sustained online notifications use a bounded interval on a recurring status rule',async t=>{
  const f=rig(t),text='Tant que mon atelier reste connecté, un signe toutes les deux heures.';
  const base={trigger:'agent_online',sourceTarget:'desk.code',repeat:'each',remindEveryHours:2};
  for(const remindEveryHours of [0,169,1.5,'bad',true,[2]]){
    assert.throws(()=>f.add(text,{...base,remindEveryHours}));
  }
  assert.throws(()=>f.add(text,{...base,repeat:'once'}));
  f.add(text,base);
  await f.tick(ms+3600000);assert.equal(f.notices().length,0);
  await f.tick(ms+7200000);assert.equal(f.notices().length,1);
});

test('a current task rule includes existing matching receipts while a next-event rule starts at its cursor',async t=>{
  const f=rig(t),text='Préviens-moi si cette épreuve a déjà échoué.';
  const tasks=[{id:'paper-17',title:'épreuve',state:'failed',target:'desk.code'}];
  const task={trigger:'task_failed',taskId:'paper-17',match:'épreuve',repeat:'once'};
  f.add(text,{...task,timing:'current'},{tasks});
  f.add('Et lors du prochain incident sur cette épreuve.',{...task,timing:'next'},{tasks});
  await f.tick(ms+3000);
  assert.equal(f.notices().length,1);
  assert.match(f.notices()[0],/paper-17/);
});
