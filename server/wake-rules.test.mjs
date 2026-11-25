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

test('an invented monitor, widened scope, quoted instruction or upgraded notification cannot grant recurring execution',t=>{
  const f=rig(t);
  const review={...failure,effect:'consult',target:'desk.code'};
  assert.throws(()=>f.add(notify,review));
  assert.throws(()=>f.add('请解释这句话：“'+consult+'”',review));
  assert.throws(()=>f.add(notify,{...failure,match:undefined}));
  assert.throws(()=>f.add(notify,failure,{wakeCursor:null}));
  assert.throws(()=>f.add('这段话是什么意思？',failure));
  assert.throws(()=>f.add('明早提醒我看图册',{trigger:'time',repeat:'daily',dueAt:'2026-03-06T09:00:00Z'}));
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

test('registration rejects a check when isolation is unavailable and protects a scoped task qualifier',t=>{
  const f=rig(t);
  assert.throws(()=>f.add(consult,{...failure,effect:'consult',target:'desk.code'},{workers:f.queue.workers().map(w=>({...w,isolatedRead:false}))}));
  assert.throws(()=>f.add('每次新的纸本校对任务失败都提醒我',{...failure,match:'任务'}));
  assert.throws(()=>f.add('能不能举例说明每次新的校对任务失败就让 desk.code 做一次只读复核是什么意思',{...failure,effect:'consult',target:'desk.code'}));
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

test('quoted task names work, but text from inside a quotation cannot authorize an action',t=>{
  const f=rig(t);
  f.add('每次“纸本校对”任务失败都提醒我',{trigger:'task_failed',match:'纸本校对'});
  assert.throws(()=>f.add('上条消息是：“'+consult+'”',{...failure,effect:'consult',target:'desk.code'}));
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
  const correction=f.store.receive({requestId:'later',text:'等我确认目录范围'});
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

test('ambiguous desktop titles or another connector on the same device cannot receive review permission',t=>{
  const f=rig(t);
  const workers=f.queue.workers(),own=workers.find(w=>w.target==='desk.code');
  assert.throws(()=>f.add(consult,{...failure,effect:'consult',target:'desk.archive'},{workers:[...workers,{...own,target:'desk.archive',agentName:'Archive'}]}));
  const row={machine:'desk',target:'desk.code',id:'same-title-a',title:'展厅清单',updatedAt:instant};
  assert.throws(()=>f.add('每次展厅清单会话更新都提醒我',{trigger:'session_changed',machine:'desk',sessionId:row.id},{sessions:[row,{...row,id:'same-title-b'}]}));
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

test('ordinary notification wording and a natural task filter work without inventing a timer for an unavailable external condition',async t=>{
  const f=rig(t);
  f.add('Whenever a new proofreading task fails, let me know.',{trigger:'task_failed',match:'proofreading'});
  f.event('single',1,{title:'proofreading the gallery label'});await f.tick(ms+2000);
  assert.equal(f.notices().length,1);
  assert.throws(()=>f.add('外面起风的时候通知我',{trigger:'time',repeat:'once',dueAt:'2026-03-06T09:00:00Z'}));
});

test('one grant can stage only one action across duplicate planner positions and retries; distinct user clauses remain independent',async t=>{
  const f=rig(t);
  const second='每次新的图册运输任务成功都提醒我';
  const text=notify+'。'+second;
  const turn={...f.store.receive({requestId:'two-clauses',text}),text};
  const snap={now:instant,timeZone:'UTC',wakeCursor:0,workers:f.queue.workers(),tasks:[],sessions:[]};
  const check=(evidence,fields)=>f.rules.check({type:'wake_rule',repeat:'each',effect:'notify',evidence,...fields},turn,snap);
  const first=check(notify,failure);
  const equivalent=check(notify+'。',failure);
  const other=check(second,{trigger:'task_succeeded',match:'图册运输'});
  assert.equal(f.rules.uniqueGrants([first,equivalent,other]).length,2);
  const conflict={...first,repeat:'once'}; // Also fence inconsistent grants in a saved plan.
  assert.throws(()=>f.rules.uniqueGrants([first,conflict]),/委托/);
  f.rules.register('first',turn,first);
  assert.equal(f.rules.register('second-position',turn,equivalent).id,'first');
  assert.throws(()=>f.rules.register('conflict',turn,conflict),/委托/);
  f.rules.register('other',turn,other);
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

test('explicit manual cancellation keeps a recurring grant open in Chinese and English, without converting external stop conditions into dates',t=>{
  const f=rig(t);
  f.add('每次新的图册校对任务失败都提醒我，直到我取消',{trigger:'task_failed',match:'图册校对'});
  f.add('Whenever a proofreading task fails, notify me until I cancel.',{trigger:'task_failed',match:'proofreading'});
  assert.equal(f.rules.cards().filter(c=>c.status==='active'&&c.nextAt===null).length,2);
  assert.throws(()=>f.add('每次新的图册校对任务失败都提醒我，直到鸟类迁徙结束',{trigger:'task_failed',match:'图册校对',endAt:'2027-01-01T00:00:00Z'}));
  assert.throws(()=>f.add('每次新的图册校对任务失败都提醒我，直到我取消',{trigger:'task_failed',match:'图册校对',endAt:'2027-01-01T00:00:00Z'}));
  assert.throws(()=>f.add('每次新的图册校对任务失败都提醒我，直到鸟类迁徙结束',{trigger:'task_failed',match:'图册校对',evidence:'每次新的图册校对任务失败都提醒我'}));
});

test('registration preserves every occurrence and requires affirmative permission to include already-true conditions',t=>{
  const f=rig(t);
  assert.throws(()=>f.add(notify,{...failure,repeat:'once'}));
  assert.throws(()=>f.add('每个工作日上午九点提醒我核对纸本',{trigger:'time',repeat:'once',dueAt:'2026-03-06T09:00:00Z'}));
  assert.throws(()=>f.add('每当校对失败就通知我',{...failure,timing:'current'}));
  assert.throws(()=>f.add('Whenever a proofreading task fails, notify me',{trigger:'task_failed',match:'proofreading',timing:'current'}));
  f.add('下一个工作日上午九点提醒我核对纸本一次',{trigger:'time',repeat:'once',dueAt:'2026-03-06T09:00:00Z'});
  f.add('如果当前已有纸本校对任务失败，请马上通知我',{trigger:'task_failed',match:'纸本校对',repeat:'once',timing:'current'});
});
