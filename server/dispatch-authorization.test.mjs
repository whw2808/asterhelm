import test from 'node:test';
import assert from 'node:assert/strict';
import {PersonalAgent} from './personal-service.mjs';
import {PersonalStore} from './personal-store.mjs';
import {configuredQueue} from './test-support/registered-queue.mjs';

function fixture(t,text,{review,plan}={}){
  const store=new PersonalStore(':memory:'),queue=configuredQueue(':memory:');
  t.after(()=>{queue.close();store.db.close();});
  const prior=store.receive({requestId:'earlier',text:'看看纸本目录的校对评分'});
  store.finish(prior,'Bench 的纸本目录格式 3/5、准确度 4/5。');
  const phases=[];
  const planner={plan:async input=>{
    phases.push(input.phase??'chat');
    if(input.phase==='dispatchAuthority'){
      assert.equal(input.currentUser,text);
      assert.ok(input.history.some(m=>m.text.includes('3/5')));
      return review?review(input):{reply:'',actions:input.proposals.map(p=>({type:'allow_workspace',index:p.index,target:p.target,evidence:text}))};
    }
    return plan??{reply:'',criteria:['每一项至少 4 分'],actions:[{type:'dispatch',target:'bench.code',title:'继续纸本校对',prompt:'继续纸本目录校对，每项至少 4 分，附校验证据。',write:true,evidence:text}]};
  }};
  const agent=new PersonalAgent({store,planner,contexts:{readContexts:()=>[],contextCoverage:()=>[]},
    broker:async(route,args)=>{
      if(route==='/workers')return queue.workers();if(route==='/list')return queue.list();
      if(route==='/submit')return queue.submit(args);if(route==='/wakeEvents')return queue.wakeEvents(args);
      throw Error('unexpected '+route);
    }});
  return {store,queue,phases,async send(){const result=await agent.receive({requestId:'phone',text});await agent.step();return result;}};
}
test('an outcome request and a contextual continuation reach the worker without file verbs',async t=>{
  for(const text of ['请让负责纸本的继续，直到每一项都过四分','交给 Bench 接着做']){
    const f=fixture(t,text),sent=await f.send();
    assert.deepEqual(await f.send(),sent);
    assert.equal(f.queue.list().length,1);
    const task=f.queue.claim('bench.code');
    assert.equal(task.mode,'workspace-write');assert.match(task.prompt,/每项至少 4 分/);
    assert.equal(f.store.work.card(sent.id).tasks[0].target,'bench.code');
    assert.deepEqual(f.phases,['chat','dispatchAuthority']);
  }
});
test('a planner cannot grant itself a write for a quotation, a status question, or a different worker',async t=>{
  for(const [text,review] of [
    ['编辑说“创建新版”，这句话什么意思？',()=>({reply:'',actions:[]})],
    ['纸本目录做到哪了？',()=>({reply:'',actions:[]})],
    ['让 Bench 接着做',()=>({reply:'',actions:[{type:'allow_workspace',index:0,target:'desk.code',evidence:'接着做'}]})],
    ['让 Bench 接着做',()=>({reply:'',actions:[{type:'allow_workspace',index:0,target:'bench.code',evidence:'旧指令'}]})]
  ]){
    const f=fixture(t,text,{review});const sent=await f.send();
    assert.equal(f.queue.list().length,0);assert.equal(f.store.work.card(sent.id),null);
  }
});
test('a restriction on the original permits a separately authorized working copy',async t=>{
  const f=fixture(t,'原件只读，请在独立副本把纸本目录磨到四分');
  await f.send();assert.equal(f.queue.list().length,1);assert.deepEqual(f.phases,['chat','dispatchAuthority']);
});
test('partial grants cannot start any step of a multi-device plan',async t=>{
  const text='请两台设备各做一个样张';
  const actions=['desk.code','bench.code'].map(target=>({type:'dispatch',target,title:'样张',prompt:'在本次任务目录做样张',write:true,evidence:text}));
  const f=fixture(t,text,{plan:{reply:'',actions},review:()=>({reply:'缺少另一项分工的依据。',actions:[{type:'allow_workspace',index:0,target:'desk.code',evidence:text}]})});
  await f.send();assert.equal(f.queue.list().length,0);assert.equal(f.store.work.activeCount(),0);
});
