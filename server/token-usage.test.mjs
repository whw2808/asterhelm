import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {PersonalStore} from './personal-store.mjs';
import {PersonalAgent} from './personal-service.mjs';
import {TokenUsage,isUsageQuestion} from './token-usage.mjs';

test('coordinator receipts survive restart, are scoped to local days and count a cached input only once',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'asterhelm-meter-')),file=path.join(dir,'assistant.sqlite');
  let store=new PersonalStore(file),clock=new Date(2025,3,2,23,59,59);
  t.after(()=>{store.db.close();fs.rmSync(dir,{recursive:true,force:true});});
  let ledger=new TokenUsage(store.db,()=>clock);
  const planner={plan:async(input,{onUsage})=>{
    onUsage({model:'sample',inputTokens:100,outputTokens:7,totalTokens:107,cachedInputTokens:25});
    onUsage({model:'sample',inputTokens:100,outputTokens:7,totalTokens:107,cachedInputTokens:25});
    return {reply:'ok',actions:[]};
  }};
  const first=ledger.wrap(planner);
  await first.plan({currentUser:'DO_NOT_STORE_THIS'});
  await first.plan({phase:'delivery'});
  const since=ledger.summary().since;
  assert.equal(ledger.summary().today.totalTokens,214);
  store.db.close();store=new PersonalStore(file);clock=new Date(2025,3,3,0,0,1);
  ledger=new TokenUsage(store.db,()=>clock);
  const wrap=ledger.wrap({plan:async(i,{onUsage})=>{if(i.usage)onUsage(i.usage);if(i.fail)throw Error('invalid structured reply');}});
  await wrap.plan({phase:'workWake',usage:{totalTokens:24}});
  await assert.rejects(wrap.plan({usage:{inputTokens:0,outputTokens:0,totalTokens:0},fail:true},{phase:'review'}));
  await wrap.plan({usage:{inputTokens:4,totalTokens:4,incomplete:true}});
  await wrap.plan({fail:false});
  const s=ledger.summary();
  assert.equal(s.since,since);
  assert.equal(s.today.calls,4);
  assert.equal(s.today.totalTokens,28);
  assert.equal(s.today.reportedCalls,2);
  assert.equal(s.today.unknownCalls,2);
  assert.equal(s.today.partialCalls,1);
  assert.equal(s.today.incompleteCalls,1);
  assert.equal(s.today.inputReportedCalls,2);
  assert.equal(s.allTime.cachedInputTokens,50);
  assert.equal(s.allTime.calls,6);
  assert.equal(s.allTime.totalTokens,242);
  assert.deepEqual(Object.fromEntries(s.byPhase.map(p=>[p.phase,p.calls])),{chat:3,delivery:1,workWake:1,review:1});
  const stored=store.db.prepare('SELECT * FROM coordinator_usage').all();
  assert.ok(!JSON.stringify(stored).includes('DO_NOT_STORE_THIS'));
});

test('concurrent calls have independent receipts, including attempts without usage when a process exits',async t=>{
  const store=new PersonalStore(':memory:');t.after(()=>store.db.close());
  const ledger=new TokenUsage(store.db);
  let release;const gate=new Promise(r=>release=r);
  const routed=ledger.wrap({plan:async (input,{onUsage})=>{if(input.wait)await gate;onUsage({totalTokens:input.total});}});
  const a=routed.plan({phase:'delivery',total:6,wait:true});
  await routed.plan({phase:'workWake',total:9});
  assert.equal(new TokenUsage(store.db).summary().allTime.unknownCalls,1);
  release();await a;
  assert.deepEqual([ledger.summary().allTime.totalTokens,ledger.summary().allTime.unknownCalls],[15,0]);
});

test('both board layouts and a repeated chat inquiry use the ledger, without dispatch or model calls',async t=>{
  const store=new PersonalStore(':memory:');t.after(()=>store.db.close());
  const contexts={readContexts:()=>[],contextCoverage:()=>[]};
  let calls=0;const planner={plan:async(input,{onUsage})=>{calls++;onUsage({inputTokens:10,outputTokens:3,totalTokens:13});}};
  const agent=new PersonalAgent({store,contexts,planner,broker:()=>[]});
  await agent.planner.plan({phase:'workWake'});
  const plain=await agent.board(),machines=await agent.board({layout:'machines'});
  assert.equal(plain.usage.today.totalTokens,13);assert.deepEqual(machines.usage,plain.usage);
  const req={text:'星舵今天用了多少 token？',requestId:'inspect-once'};
  const first=await agent.receive(req);assert.deepEqual(await agent.receive(req),first);
  assert.equal(calls,1);
  assert.equal(store.pending(),undefined);
  assert.match(store.history().messages.at(-1).text,/13/);
  assert.equal(isUsageQuestion('分析这两种模型的 token 用量'),false);
  assert.equal(isUsageQuestion('展厅工作站的 Codex 今天用了多少 token？'),false);
  assert.equal(isUsageQuestion('查看 Token 用量'),true);
});
