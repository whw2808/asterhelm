import test from 'node:test';
import assert from 'node:assert/strict';
import {syncWorkUpdates} from './context-sync.mjs';

const threadId='00000000-0000-4000-8000-000000000002';
const next='00000000-0000-4000-8000-000000000003';
const update={threadId,deliveryId:'a',text:'Review complete'};
const rows=[{id:threadId,source:'Codex Desktop',status:'completed'},{id:next,source:'Codex Desktop',status:'inProgress'}];

test('connector acknowledges only confirmed visibility for its exact idle native thread',async()=>{
  const acks=[], attempts=[];
  const request=async(op,body)=>op==='updates'?[
    update,{...update,threadId:next,deliveryId:'running'},{...update,threadId:'unrelated',deliveryId:'missing'}
  ]:acks.push(body);
  await syncWorkUpdates(rows,request,async item=>{attempts.push(item.deliveryId);return {visible:true};});
  assert.deepEqual(attempts,['a']);
  assert.deepEqual(acks,[{threadId,deliveryId:'a'}]);
});

test('a missing desktop or an ambiguous reply leaves delivery pending',async()=>{
  for(const deliver of [async()=>({}),async()=>({visible:false}),async()=>{throw Error('unavailable');}]){
    const acks=[];
    await syncWorkUpdates(rows,async(op,body)=>op==='updates'?[update]:acks.push(body),deliver);
    assert.deepEqual(acks,[]);
  }
});
