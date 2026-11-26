import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {PersonalStore} from './personal-store.mjs';
import {PersonalAgent} from './personal-service.mjs';
import {configuredQueue} from './test-support/registered-queue.mjs';

function setup(t,file=':memory:'){
  const store=new PersonalStore(file),queue=configuredQueue(':memory:');
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

test('a contextual follow uses the recent chat only to identify its subject and reuses its original preview',async t=>{
  const f=setup(t);
  await f.send('样张目录的也跟进');
  const first=f.agent.goals.cards()[0];assert.equal(first?.title,'样张目录');
  const question='不是有个样张目录项目吗，用 Iris 的';
  f.store.receive({requestId:'ask-status',text:question},null,turn=>f.store.finish(turn,'Iris3 已完成第一轮目录校对。'));
  const correction='对啊我让你把这份工作也跟进，为什么回复我：不能设置唤醒';
  f.agent.planner={plan:async snap=>{
    assert.equal(snap.follow.candidates[0].id,first.id);assert.equal(snap.history.at(-2).text,question);
    return {reply:'',actions:[{type:'follow_goal',goalId:first.id,evidence:'把这份工作也跟进'}]};
  }};
  await f.send(correction);await f.agent.step();
  const cards=f.agent.goals.cards();assert.equal(cards.length,1);assert.equal(cards[0].id,first.id);assert.equal(cards[0].status,'preview');
  assert.match(f.store.history().messages.at(-1).text,/样张目录/);
  assert.ok(!f.routes.includes('/submit'));assert.equal(f.store.notifications().items.length,0);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM follow_goal_decisions').get().n,0);
});
test('ambiguous or invented references cannot enroll a goal or perform a different action',async t=>{
  const f=setup(t);
  f.store.receive({requestId:'prior',text:'比较春季书展和冬季画展'},null,turn=>f.store.finish(turn,'两个展览各有不同日期。'));
  let proposed={type:'wake_rule',evidence:'这份工作也跟进'};
  f.agent.planner={plan:async()=>({reply:'已开启通知',actions:[proposed]})};
  await f.send('这份工作也跟进');await f.agent.step();
  assert.match(f.store.history().messages.at(-1).text,/哪|具体/);
  proposed={type:'follow_goal',title:'并未提过的目标',evidence:'这份工作也跟进'};
  await f.send('这份工作也跟进');await f.agent.step();
  assert.equal(f.agent.goals.cards().length,0);assert.equal(f.routes.includes('/submit'),false);
});
test('the ordinary planner can enroll a paraphrased observation, without dispatch or a wake rule',async t=>{
  const f=setup(t),text='帮我留心春季图书展后续的动向';
  f.agent.planner={plan:async()=>({reply:'',actions:[{type:'follow_goal',title:'春季图书展',evidence:text}]})};
  await f.send(text);await f.agent.step();
  assert.equal(f.agent.goals.cards()[0]?.title,'春季图书展');
  assert.equal(f.store.db.prepare('select count(*) as n from wake_rules').get().n,0);
  assert.equal(f.routes.includes('/submit'),false);
});

test('an unfinished observation survives a restart and a noun-only clarification creates exactly one preview',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'follow-restart-')),file=join(dir,'personal.sqlite');
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const f=setup(t,file);
  await f.send('我的目标是音频目录');
  const voice=f.agent.goals.cards()[0];
  await f.send('星舵操作 '+voice.id+' v1 enable');
  const before=()=>f.store.db.prepare('SELECT * FROM follow_goals WHERE id=?').get(voice.id);
  const original=before();
  const first='纸本那一摊，之后我想一直知道进度',qualifier='用 Iris 的';
  Object.assign(f.rows[0],{title:'纸本目录',summary:'Iris 整理纸本目录'});
  f.rows[0].evidence[0].text='纸本目录 Iris 已完成第一轮校对，核对了 12 页。';
  const plan=async snap=>{
    if(snap.currentUser===first)return {reply:'',actions:[{type:'follow_goal',question:'哪一版纸本目录？',evidence:first}]};
    if(snap.currentUser===qualifier){
      assert.equal(snap.follow.pending.request,first);
      return {reply:'',actions:[{type:'follow_goal',title:'纸本目录',source:{machine:'desk',id:f.rows[0].id},terms:['Iris'],evidence:qualifier}]};
    }
    return {reply:'',actions:[{type:'follow_goal',goalId:snap.follow.focus.id,evidence:snap.currentUser}]};
  };
  f.agent.planner={plan};
  await f.send(first);await f.agent.step();
  assert.match(f.store.history().messages.at(-1).text,/哪一版纸本目录/);
  assert.equal(f.agent.goals.cards().length,1);
  const reopened=new PersonalStore(file);t.after(()=>reopened.db.close());
  const next=new PersonalAgent({store:reopened,planner:{plan},broker:f.agent.broker,contexts:f.agent.contexts});
  const input={requestId:'qualifier',text:qualifier};
  const sent=await next.receive(input);await next.step();assert.deepEqual(await next.receive(input),sent);
  await next.receive({requestId:'again',text:'上面那个也放在我的清单里'});await next.step();
  const print=next.goals.cards().filter(g=>g.title==='纸本目录');
  assert.equal(print.length,1);assert.deepEqual(print[0].findings.map(f=>f.sourceId),[f.rows[0].id]);
  assert.equal(print[0].status,'preview');assert.deepEqual(before(),original);
  assert.equal(next.goals.cards().length,2);assert.ok(!f.routes.includes('/submit'));
  for(const table of ['work_orders','wake_rules','notices','assignments','continuity_participants'])
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM '+table).get().n,0,table);
});
test('pending observation rejects mixed effects and unknown source identities',async t=>{
  const f=setup(t);
  let actions=[{type:'follow_goal',evidence:'纸本那摊也算上',question:'哪一版？'}];
  f.agent.planner={plan:async()=>({reply:'已派单',actions})};
  await f.send('纸本那摊也算上');await f.agent.step();
  for(const action of [{type:'dispatch'},{type:'follow_goal',source:{machine:'missing',id:randomUUID()},title:'海岸索引',evidence:'海岸索引'}]){
    actions=action.type==='dispatch'?[{type:'follow_goal',title:'海岸索引',evidence:'海岸索引'},action]:[action];
    await f.send('海岸索引');await f.agent.step();
    assert.equal(f.agent.goals.cards().length,0);assert.equal(f.store.work.activeCount(),0);
  }
});
test('a follow clarification cannot be promoted to an executable plan by a stray model action',async t=>{
  const f=setup(t),first='样张目录未来的进度也算我一份';
  let proposal={reply:'',actions:[{type:'follow_goal',title:'样张目录',evidence:first}]};
  f.agent.planner={plan:async()=>proposal};
  await f.send(first);await f.agent.step();
  proposal={reply:'',actions:[{type:'todo',text:'印刷结算',evidence:'印刷版'}]};
  await f.send('印刷版');await f.agent.step();
  assert.deepEqual(f.store.commitments(),[]);
  assert.equal(f.agent.goals.cards().length,1);
});
test('withdrawal abandons a pending observation and a pause only affects the named existing preview',async t=>{
  const f=setup(t);
  let action;
  f.agent.planner={plan:async()=>({reply:'',actions:[action]})};
  const say=async(text,fields)=>{action={...fields,evidence:text};await f.send(text);await f.agent.step();};
  await say('纸本清单之后我也想知道',{type:'follow_goal',question:'哪一版清单？'});
  await say('先算了',{type:'dismiss_follow'});
  assert.equal(f.agent.follow.context().pending,null);
  await say('纸本清单之后我也想知道',{type:'follow_goal',title:'纸本清单'});
  const [{id}]=f.agent.goals.cards();
  await say('这一项暂时不用了',{type:'pause_follow',goalId:id});
  assert.equal(f.agent.goals.get(id).status,'paused');assert.equal(f.store.notifications().items.length,0);
});
test('a previously identified source remains addressable when it drops off the recent list',async t=>{
  const f=setup(t),source={machine:f.rows[0].machine,id:f.rows[0].id};
  f.agent.contexts.readSession=()=>f.rows[0];
  f.agent.planner={plan:async s=>({reply:'',actions:[{type:'follow_goal',evidence:s.currentUser,title:'纸本目录',source,
    ...(s.follow.focus?{goalId:s.follow.focus.id}:{})}]})};
  await f.send('我想持续了解纸本目录');await f.agent.step();
  f.agent.contexts.readContexts=()=>[];
  await f.send('印刷版');await f.agent.step();
  assert.match(f.store.history().messages.at(-1).text,/纸本目录/);
  assert.equal(f.agent.goals.cards().length,1);
});
test('a selected desktop chat can be followed semantically and malformed classifications never bind the thread',async t=>{
  const f=setup(t),context={machine:f.rows[0].machine,id:f.rows[0].id};
  let actions=[];
  f.agent.planner={plan:async()=>({reply:'',actions})};
  await f.send('我想看到这份目录以后的变化',{context});
  assert.equal(f.store.continuity.participants().length,0);
  actions=[{type:'follow_goal',title:'春季图书展',evidence:'把它列在我的观察清单里'}];
  await f.send('把它列在我的观察清单里',{context});
  const [card]=f.agent.goals.cards();
  assert.deepEqual(card.findings.map(f=>f.deviceId),['desk']);
  assert.equal(f.store.continuity.participants().length,0);
});
test('an existing goal ID cannot broaden its subject or absorb a newly named sibling',async t=>{
  const f=setup(t);
  await f.send('我的目标是音频校对');
  const [audio]=f.agent.goals.cards();
  await f.send('星舵操作 '+audio.id+' v1 enable');
  const text='纸本校对也算上一份';
  let count=0;
  f.agent.planner={plan:async()=>{
    count++;
    const action=count===1?{goalId:audio.id,title:'校对（音频与纸本）'}:{title:'纸本校对'};
    return {reply:'',actions:[{type:'follow_goal',...action,evidence:text}]};
  }};
  await f.send(text);await f.agent.step();
  assert.equal(f.agent.goals.cards().find(c=>c.title==='纸本校对')?.status,'preview');
  assert.equal(f.agent.goals.get(audio.id).status,'enabled');
});
