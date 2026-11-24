import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {configuredQueue} from './test-support/registered-queue.mjs';
import {prepareHandoff,readOutput,stageInput} from './handoff.mjs';

function root(t){
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'handoff-test-')));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;
}
const bytes=Buffer.from([0,255,65,66]);
const payload={size:4,sha256:createHash('sha256').update(bytes).digest('hex'),data:bytes.toString('base64')};
test('fixed paths preserve binary data, verify the digest and handle retries',t=>{
  const workspace=root(t),a=randomUUID(),b=randomUUID();
  prepareHandoff(workspace,a);prepareHandoff(workspace,b);
  fs.writeFileSync(path.join(workspace,a,'handoff','output'),bytes);
  assert.deepEqual(readOutput(workspace,a),payload);
  stageInput(workspace,b,payload);stageInput(workspace,b,payload);
  assert.deepEqual(fs.readFileSync(path.join(workspace,b,'handoff','input')),bytes);
  assert.throws(()=>stageInput(workspace,b,{...payload,sha256:'0'.repeat(64)}));
  assert.throws(()=>prepareHandoff(workspace,'../escape'));
});
test('file exports reject oversized data, linked directories, symlinks and hardlinks',t=>{
  const workspace=root(t),a=randomUUID(),b=randomUUID(),other=root(t);
  prepareHandoff(workspace,a);const out=path.join(workspace,a,'handoff','output');
  fs.writeFileSync(path.join(other,'private'),'private');fs.symlinkSync(path.join(other,'private'),out);
  assert.throws(()=>readOutput(workspace,a));fs.unlinkSync(out);
  fs.linkSync(path.join(other,'private'),out);assert.throws(()=>readOutput(workspace,a));fs.unlinkSync(out);
  fs.writeFileSync(out,Buffer.alloc(1048577));assert.throws(()=>readOutput(workspace,a));
  fs.rmSync(path.join(workspace,a,'handoff'),{recursive:true});fs.symlinkSync(other,path.join(workspace,a,'handoff'));
  assert.throws(()=>readOutput(workspace,a));assert.throws(()=>stageInput(workspace,a,payload));
  fs.symlinkSync(other,path.join(workspace,b));assert.throws(()=>prepareHandoff(workspace,b));
});
test('handoff is bound to successful producer and claimed consumer, with immutable receipts',t=>{
  const file=path.join(root(t),'queue.sqlite');let q=configuredQueue(file);
  const start={target:'desk.code',mode:'workspace-write',prompt:'create synthetic file',exportFile:true,requestId:'producer'};
  const a=q.submit(start), producer={id:a.id,state:'succeeded',attachment:payload};
  assert.throws(()=>q.submit({...start,exportFile:false}));
  assert.throws(()=>q.submit({...start,mode:'read-only',requestId:'readonly'}));
  const next={target:'bench.code',prompt:'check bytes',inputTaskId:a.id,requestId:'consumer'};
  assert.throws(()=>q.submit(next));
  q.claim('desk.code');assert.throws(()=>q.finish('bench.code',producer));
  assert.throws(()=>q.finish('desk.code',{...producer,attachment:{...payload,sha256:'0'.repeat(64)}}));
  assert.throws(()=>q.finish('desk.code',{id:a.id,state:'succeeded'}));
  q.finish('desk.code',producer);q.finish('desk.code',producer);
  const meta={size:4,sha256:payload.sha256};
  assert.deepEqual(q.get(a.id).attachment,meta);assert.deepEqual(q.list()[0].attachment,meta);
  assert.doesNotMatch(JSON.stringify([q.get(a.id),q.list()]),new RegExp(payload.data));
  q.close();q=configuredQueue(file);
  const b=q.submit(next);assert.throws(()=>q.input('bench.code',b.id));
  q.claim('bench.code');assert.throws(()=>q.input('desk.code',b.id));assert.deepEqual(q.input('bench.code',b.id),payload);
  q.cancel(b.id);assert.throws(()=>q.input('bench.code',b.id));
  q.finish('bench.code',{id:b.id,state:'cancelled'});
  const r=q.submit({...start,requestId:'cancelled'});q.claim('desk.code');q.cancel(r.id);
  q.finish('desk.code',{...producer,id:r.id});assert.equal(q.get(r.id).attachment,null);
  q.close();
});
test('a stopped handoff cannot be dispatched after an acknowledgement loss or broker restart',t=>{
  const file=path.join(root(t),'queue.sqlite');let q=configuredQueue(file);
  const spec={target:'bench.code',prompt:'use staged file',requestId:'handoff:workflow-1:consumer'};
  assert.equal(q.getByRequestId(spec.requestId),null);assert.throws(()=>q.cancelByRequestId('ordinary-task'));
  assert.equal(q.cancelByRequestId('handoff:'+'x'.repeat(152)).cancelled,true);
  const a=q.submit(spec);assert.equal(q.getByRequestId(spec.requestId).id,a.id);
  assert.equal(q.cancelByRequestId(spec.requestId).task.state,'cancelled');
  const future={...spec,requestId:'handoff:workflow-2:consumer'};
  assert.equal(q.cancelByRequestId(future.requestId).task,null);
  q.close();q=configuredQueue(file);
  assert.throws(()=>q.submit(spec));assert.throws(()=>q.submit(future));
  assert.equal(q.cancelByRequestId(spec.requestId).task.id,a.id);q.close();
});

test('a named file nested below output cannot substitute for the fixed export file',t=>{
  const workspace=root(t),id=randomUUID();
  prepareHandoff(workspace,id);
  const destination=path.join(workspace,id,'handoff','output');
  fs.mkdirSync(destination);
  fs.writeFileSync(path.join(destination,'named.txt'),bytes);
  assert.throws(()=>readOutput(workspace,id));
});
