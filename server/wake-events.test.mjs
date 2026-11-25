import test from 'node:test';
import assert from 'node:assert/strict';
import {configuredQueue} from './test-support/registered-queue.mjs';

test('terminal receipts can be replayed beyond the board snapshot, including cancellation', () => {
  const q=configuredQueue(':memory:');
  try {
    const submit=i=>q.submit({requestId:'personal:test:'+i,target:'desk.code',prompt:'Fixture '+i});
    const first=submit(0);
    q.claim('desk.code');
    assert.equal(q.wakeEvents({after:null}).cursor,0);
    q.finish('desk.code',{id:first.id,state:'failed'});
    q.finish('desk.code',{id:first.id,state:'failed'});
    for(let i=1;i<65;i++) q.cancel(submit(i).id);
    const a=q.wakeEvents({after:0,limit:10});
    assert.equal(a.items.length,10);assert.equal(a.items[0].id,first.id);
    assert.equal(a.items[0].state,'failed');assert.equal(a.hasMore,true);
    const b=q.wakeEvents({after:a.cursor});
    assert.equal(b.items.length,55);assert.equal(b.hasMore,false);
    assert.equal(new Set([...a.items,...b.items].map(r=>r.id)).size,65);
    assert.deepEqual(q.wakeEvents({after:null}),{items:[],cursor:b.cursor,hasMore:false});
  } finally {q.close();}
});

test('unattended reads require a negotiated isolated worker and cannot carry write or handoff privileges',()=>{
  const q=configuredQueue(':memory:');
  try {
    const spec={requestId:'personal:candidate:example',target:'desk.code',prompt:'核对给出的两条记录'};
    assert.throws(()=>q.submit(spec),/isolated/i);
    q.beat('desk.code',null,'ready',null,true);
    assert.equal(q.workers().find(x=>x.target==='desk.code').isolatedRead,true);
    assert.throws(()=>q.submit({...spec,mode:'workspace-write'}),/isolated/i);
    assert.throws(()=>q.submit({...spec,exportFile:true}),/isolated/i);
    const permitted=q.submit(spec);assert.equal(permitted.mode,'read-only');
    q.beat('desk.code',null,'ready');
    assert.equal(q.claim('desk.code'),null);
    q.beat('desk.code',null,'ready',null,true);
    assert.equal(q.claim('desk.code').id,permitted.id);
  } finally {q.close();}
});
