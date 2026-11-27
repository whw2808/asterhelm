import test from 'node:test';
import assert from 'node:assert/strict';
import {PersonalAgent} from './personal-service.mjs';
import {PersonalStore} from './personal-store.mjs';
import {configuredQueue} from './test-support/registered-queue.mjs';

function setup(t,text,action,allowed,seed,onReview){
  const store=new PersonalStore(':memory:'),queue=configuredQueue(':memory:');
  t.after(()=>{store.db.close();queue.close();});
  const workers=queue.workers();
  const data=seed?.(store,queue,workers);
  const phases=[];
  const agent=new PersonalAgent({store,contexts:{readContexts:()=>[],contextCoverage:()=>[]},broker:async(route,arg)=>{
    if(route==='/workers')return workers;
    if(route==='/list')return queue.list();
    if(route==='/wakeEvents')return queue.wakeEvents(arg);
    if(route==='/submit')return queue.submit(arg);
    if(route==='/cancel')return queue.cancel(arg.id);
    if(route==='/cancelByRequestId')return queue.cancelByRequestId(arg.requestId);
    throw Error('Unexpected '+route);
  },planner:{plan:async s=>{
    phases.push(s.phase??'chat');
    if(s.phase==='routeAuthority'){
      onReview?.(store,data);
      return {reply:allowed?'':'这句只是在讨论示例。',actions:allowed?s.proposals.map(p=>({type:'allow_effect',index:p.index,kind:p.kind,evidence:text})):[]};
    }
    return {reply:'',actions:[{...action(data),evidence:text}]};
  }}});
  return {queue,store,phases,async send(){const input={text,requestId:'phone'};const r=await agent.receive(input);await agent.step();assert.deepEqual(await agent.receive(input),r);return r;}};
}
const exchange=()=>({type:'handoff',from:'desk.code',to:'bench.code',first:'拟纸本目录',second:'据目录写摘要'});
const event=()=>({type:'wake_rule',trigger:'task_failed',repeat:'each',effect:'notify',match:'样张',timing:'next'});
const order=(s,q,ws)=>{
  const {id}=s.receive({requestId:'origin',text:'准备展册'});
  s.work.create({id,text:'准备展册'},['内页','封面']);
  for(const [i,w] of ws.entries()){
    const key='print-'+i;s.work.stage(id,key,w,'consult',['内页','封面'][i],false);
    s.work.bind(key,q.submit({target:w.target,prompt:key,requestId:key}));
  }
  s.finish({id},'两处排版都已接单。');return id;
};
for(const [label,make,utterances,verify,seed] of [
  ['handoff',exchange,['甲机拟稿，乙机据此出摘要','初稿出自甲，摘要由乙照着初稿做'],(f,yes)=>assert.equal(f.queue.list().length,yes?1:0)],
  ['whole order',id=>({type:'cancel',id}),['这本展册撤了吧','这单作废，两处都收工'],(f,yes)=>assert.equal(f.queue.list().filter(t=>t.state==='cancelled').length,yes?2:0),order],
  ['calendar rule',()=>({type:'wake_rule',trigger:'time',repeat:'daily',effect:'notify',dueAt:new Date(Date.now()+86400000).toISOString(),timeZone:'UTC',timing:'next'}),['从明天起，每天这个点敲我一下','明儿开始照这个钟点来，每天提醒我'],(f,yes)=>assert.equal(f.store.db.prepare('select count(*) n from wake_rules').get().n,yes?1:0)],
  ['event rule',event,['样张今后凡是没跑成，就敲我一下','样张以后哪次出岔子，我这边都要有个信儿'],(f,yes)=>assert.equal(f.store.db.prepare('select count(*) n from wake_rules').get().n,yes?1:0)]
]){
  test(label+' executes either wording and suppresses an incorrectly proposed effect for quote, question and negation',async t=>{
    for(const [text,yes] of [...utterances.map(x=>[x,true]),...['有人说「'+utterances[0]+'」，给我解释一下','这样安排会怎么样？','别这么做。'].map(x=>[x,false])]){
      const f=setup(t,text,make,yes,seed);await f.send();verify(f,yes);
      assert.ok(f.phases.includes('routeAuthority'),text);
    }
  });
}
test('a whole-order stop fences a branch whose broker receipt was lost',async t=>{
  const seed=(store,queue,workers)=>{
    const id=order(store,queue,workers);
    const key=id+':extra',target=workers[1].target;
    store.work.stage(id,key,workers[1],'consult','附录',false);
    queue.submit({target,prompt:'附录',requestId:'personal:'+key});
    return id;
  };
  const f=setup(t,'展册整个撤掉',id=>({type:'cancel',id}),true,seed);
  await f.send();
  assert.deepEqual(f.queue.list().map(t=>t.state),['cancelled','cancelled','cancelled']);
});

test('a whole-order stop cannot cancel a newer revision even after review approved the old one',async t=>{
  const f=setup(t,'这本展册撤了吧',id=>({type:'cancel',id}),true,order,(store,id)=>{
    store.work.revise(id,{id:'newer',text:'调整验收标准'},{expectedRevision:0,goal:'新的展册要求',criteria:['新的纸书版本'],pauseStepIds:[]});
  });
  await f.send();
  assert.ok(f.queue.list().every(t=>t.state==='queued'));
  assert.ok(f.store.history().messages.some(m=>m.text.includes('状态已变化')));
});
