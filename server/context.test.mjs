import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {configuredQueue} from './test-support/registered-queue.mjs';

import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {scanDesktop} from './context-desktop.mjs';
import {ContextReceiver,contextDigest} from './context-receive.mjs';
import {contextCoverage,readContexts} from './context-read.mjs';

const first='00000000-0000-4000-8000-000000000001';
const other='00000000-0000-4000-8000-000000000002';
const helper='00000000-0000-4000-8000-000000000003';
const time=Date.parse('2000-01-01T12:00:00Z');
function directory(t){
  const root=mkdtempSync(path.join(tmpdir(),'context-test-'));
  t.after(()=>rmSync(root,{recursive:true,force:true})); return root;
}
function desktop(t){
  const root=directory(t);
  const state=new DatabaseSync(path.join(root,'state_5.sqlite'));
  state.exec('CREATE TABLE threads(id,source,thread_source,originator,name,title,cwd,created_at,updated_at,created_at_ms,updated_at_ms,archived,creator_account_id,creator_user_id)');
  const insert=state.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  for(const [id,source,archived] of [[first,'vscode',0],[other,'vscode',1],[helper,'subagent',0]]){
    insert.run(id,source,'user','Codex Desktop',id===first?'图书目录':'Archived task','','/examples/catalog',time/1000,time/1000,time,time,archived,'a','u');
  }
  state.close();
  const history=new DatabaseSync(path.join(root,'thread_history_1.sqlite'));
  history.exec('CREATE TABLE thread_turns(thread_id,turn_id,rollout_ordinal,status);CREATE TABLE thread_items(thread_id,turn_id,item_id,rollout_ordinal,created_at_ms,item_json,item_type)');
  const add=history.prepare('INSERT INTO thread_items VALUES(?,?,?,?,?,?,?)');
  const messages=[
    ['userMessage',{content:[{type:'text',text:'请整理目录中的出版社。'},{type:'local_image',path:'/no/leak'}]}],
    ['commandExecution',{text:'DO_NOT_COPY_TOOL_PAYLOAD'}],
    ['agentMessage',{phase:'commentary',text:'DO_NOT_COPY_ASSISTANT_PROGRESS'}],
    ['userMessage',{content:[{type:'text',text:'<environment_context>DO_NOT_COPY_XML</environment_context>'}]}],
    ['userMessage',{content:[{type:'text',text:'password = ordinary-test-password'}]}],
    ['agentMessage',{phase:'final_answer',text:'目录现已按出版社排序。'}],
  ];
  messages.forEach(([type,data],i)=>add.run(first,'turn-1','item-'+i,i,time+i,JSON.stringify({type,...data}),type));
  add.run(helper,'turn-h','item-h',1,time,JSON.stringify({type:'agentMessage',text:'DO_NOT_COPY_SUBAGENT'}),'agentMessage');
  history.prepare('insert into thread_turns values(?,?,?,?)').run(first,'turn-1',0,'inProgress'); history.close();
  return root;
}
test('only visible top-level desktop dialogue enters the snapshot with source evidence',t=>{
  const rows=scanDesktop(desktop(t)); assert.equal(rows.length,2);
  const r=rows.find(r=>r.id===first);
  assert.equal(r.status,'inProgress');assert.equal(r.readOnly,true);
  assert.deepEqual(r.evidence.map(e=>[e.role,e.itemId,e.turnId,e.text]),[['user','item-0','turn-1','请整理目录中的出版社。'],['assistant','item-5','turn-1','目录现已按出版社排序。']]);
  assert.doesNotMatch(JSON.stringify(rows),/DO_NOT_COPY|ordinary-test-password|no\/leak/);
  assert.equal(rows.find(r=>r.id===other).visibility,'metadata-only');
  assert.equal(rows.find(r=>r.id===other).archived,true);
});
function stage(rx,machine,rows){
  const entries=rows.map(r=>[r.id,contextDigest(r)]);
  return rx.plan(machine,{entries});
}
function upload(rx,machine,rows){
  const plan=stage(rx,machine,rows);
  rx.put(machine,{generation:plan.generation,rows:rows.filter(r=>plan.missing.includes(r.id))});
  rx.commit(machine,{generation:plan.generation}); return plan;
}
test('two independent sources retain attribution, search evidence and age offline without data loss',t=>{
  const home=directory(t), rows=scanDesktop(desktop(t));
  let now=time;
  configuredQueue(path.join(home,'tasks.sqlite')).close();
  const receiver=new ContextReceiver(home,()=>now);
  assert.equal(contextCoverage(home,now).find(r=>r.machine==='bench').status,'never');
  upload(receiver,'desk',rows);upload(receiver,'bench',[rows[0]]);
  assert.equal(readContexts(home,{query:'出版社'}).length,2);
  assert.equal(readContexts(home,{query:'unfindable'}).length,0);
  assert.equal(readContexts(home,{query:'Bench 出版社'}).length,1);
  assert.equal(readContexts(home,{query:first})[0].source,'Codex Desktop');
  now+=200000;
  assert.equal(contextCoverage(home,now).find(r=>r.machine==='desk').status,'offline');
  assert.equal(readContexts(home).length,3);
  assert.equal(statSync(path.join(home,'contexts','desk.json')).mode & 0o777,0o600);
});
test('a restarted broker reconciles retries, failed partial updates and deletions atomically',t=>{
  const home=directory(t),rows=scanDesktop(desktop(t));
  let rx=new ContextReceiver(home);
  assert.equal(upload(rx,'bench',rows).missing.length,2);
  rx=new ContextReceiver(home);
  assert.equal(upload(rx,'bench',rows).missing.length,0);
  const edited={...rows[0],title:'New title'};
  const plan=stage(rx,'bench',[edited]);
  assert.throws(()=>rx.commit('bench',{generation:plan.generation}));
  assert.throws(()=>rx.put('desk',{generation:plan.generation,rows:[edited]}));
  assert.equal(readContexts(home).length,2);
  rx.put('bench',{generation:plan.generation,rows:[edited]});
  rx.commit('bench',{generation:plan.generation});
  assert.deepEqual(readContexts(home).map(r=>r.title),['New title']);
});

test('synchronizer transfers only changed records and splits bounded HTTP batches',async t=>{
  const {syncRows}=await import('./context-sync.mjs');
  const home=directory(t), [base]=scanDesktop(desktop(t));
  const rows=Array.from({length:104},(_,i)=>({...base,id:'00000000-0000-4000-8000-'+String(i).padStart(12,'0')}));
  const received=[];const rx=new ContextReceiver(home);
  const request=async(op,payload)=>{
    if(op==='put'){received.push(payload.rows.length);assert.ok(Buffer.byteLength(JSON.stringify(payload))<650000);}
    return rx[op]('desk',payload);
  };
  assert.equal((await syncRows(rows,request)).count,104);
  assert.equal(received.reduce((a,n)=>a+n,0),104);assert.ok(received.length>1);
  received.length=0;
  assert.equal((await syncRows(rows,request)).count,104);assert.equal(received.length,0);
});

test('an excerpt cut immediately after a space survives the receiver validation',async()=>{
  const {excerpt}=await import('./context-format.mjs');
  const source='a'.repeat(699)+' trailing words';
  assert.equal(excerpt(source,700),excerpt(excerpt(source,700),700));
});

test('only interactive CLI sessions get a CLI source, and metadata changes preserve the latest message time',t=>{
  const root=desktop(t), state=new DatabaseSync(path.join(root,'state_5.sqlite'));
  state.prepare("UPDATE threads SET source='cli',originator='codex-tui',updated_at_ms=? WHERE id=?").run(time+1000000,first);
  state.prepare("UPDATE threads SET source='exec',originator='codex-tui' WHERE id=?").run(other);
  state.close();
  const rows=scanDesktop(root);assert.equal(rows.length,1);
  assert.equal(rows[0].source,'Codex CLI');
  assert.equal(rows[0].lastMessageAt,'2000-01-01T12:00:00.005Z');
  assert.equal(rows[0].sourceUpdatedAt,'2000-01-01T12:16:40.000Z');
  const home=directory(t);upload(new ContextReceiver(home),'bench',rows);
  assert.equal(contextCoverage(home).find(r=>r.machine==='bench').sources.find(x=>x.source==='Codex CLI').count,1);
});
test('credential handoffs in plain language do not enter private context excerpts',async()=>{
  const {excerpt}=await import('./context-format.mjs');
  for(const s of ['SSH 密码 ordinary-test-password','my PIN is 000000','助记词是 ordinary test words','token for pairing is eXamPle-12345']){
    assert.equal(excerpt(s,700),'');
  }
});

test('line wrapping cannot conceal a token handoff from the export filter',async()=>{
  const {excerpt}=await import('./context-format.mjs');
  assert.equal(excerpt('token\nfor pairing\nis example-test-code',700),'');
});
