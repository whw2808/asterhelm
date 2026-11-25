import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {receiptPrompt,isReceiptTurnInput,queueReceiptUpdate,verifyReceiptPrompt} from './codex-queue-receipt.mjs';

const threadId='11111111-1111-4111-8111-111111111111', deliveryId='22222222-2222-4222-8222-222222222222';
const update={threadId,deliveryId,text:'星舵 · 工作更新\nMaple Harbour opens in June.\n[Asterhelm sync '+deliveryId+']'};
const reply='星舵 · 已收悉。';

function setup(t){
  const codexHome=fs.mkdtempSync(path.join(os.tmpdir(),'asterhelm-queue-test-'));
  t.after(()=>fs.rmSync(codexHome,{recursive:true,force:true}));
  const state=new DatabaseSync(path.join(codexHome,'state_5.sqlite'));
  state.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,archived INTEGER,cwd TEXT)');
  state.prepare('INSERT INTO threads VALUES(?,0,?)').run(threadId,codexHome);
  const db=new DatabaseSync(path.join(codexHome,'thread_history_1.sqlite'));
  db.exec('CREATE TABLE thread_items(thread_id,turn_id,item_id,rollout_ordinal,item_type,item_json); CREATE TABLE thread_turns(thread_id,turn_id,rollout_ordinal,status,error_json,first_user_item_id,final_agent_item_id)');
  db.prepare('INSERT INTO thread_turns VALUES(?,?,?,?,NULL,NULL,NULL)').run(threadId,'seed',1,'completed');
  const queue=new DatabaseSync(path.join(codexHome,'queue_1.sqlite'));
  queue.exec('CREATE TABLE queued_items(id,thread_id,payload_json)');
  t.after(()=>{state.close();db.close();queue.close();});
  const receiptDir=path.join(codexHome,'asterhelm-owned'),calls=[];
  const options={mode:'receipt-turn',requireGuard:false,codexHome,receiptDir,enqueue:async item=>{
    assert.equal(verifyReceiptPrompt({threadId,prompt:item.prompt,receiptDir}),true);
    calls.push(item);return 'fixture-queue-ID';
  }};
  function record({answer=reply,extra=[],status='completed'}={}){
    db.prepare('INSERT INTO thread_turns VALUES(?,?,?,?,NULL,?,?)').run(threadId,'receipt',2,status,'item-0','item-'+(1+extra.length));
    const items=[{type:'userMessage',content:[{type:'text',text:receiptPrompt(update)}]},...extra,{type:'agentMessage',text:answer,phase:'final_answer'}];
    items.forEach((item,i)=>db.prepare('INSERT INTO thread_items VALUES(?,?,?,?,?,?)').run(threadId,'receipt','item-'+i,2+i,item.type,JSON.stringify(item)));
  }
  return {state,db,queue,options,calls,record};
}

test('a single durable claim survives overlap and restart, then validates the completed native receipt',async t=>{
  const {options,calls,record}=setup(t);
  assert.ok(isReceiptTurnInput(receiptPrompt(update),threadId));
  assert.equal(isReceiptTurnInput(receiptPrompt(update),deliveryId),false);
  const initial=await Promise.all([queueReceiptUpdate(update,options),queueReceiptUpdate(update,{...options})]);
  assert.equal(calls.length,1);assert.ok(initial.every(r=>!r.visible));
  assert.equal(verifyReceiptPrompt({threadId,prompt:receiptPrompt(update)+'!',receiptDir:options.receiptDir}),false);
  record();
  assert.equal((await queueReceiptUpdate(update,options)).visible,true);
  assert.equal(calls.length,1);
});

test('busy, archived, disabled and missing guard keep work pending before enqueue',async t=>{
  const {options,calls,db,state}=setup(t);
  for(const config of [{...options,mode:'passive'},{...options,requireGuard:undefined},{...options,requireGuard:true},{...options,requireGuard:true,guardReady:()=>false}]){
    assert.equal((await queueReceiptUpdate(update,config)).visible,false);
  }
  db.exec("UPDATE thread_turns SET status='inProgress'");
  await queueReceiptUpdate(update,options);
  db.exec("UPDATE thread_turns SET status='completed'");state.exec('UPDATE threads SET archived=1');
  await queueReceiptUpdate(update,options);
  assert.equal(calls.length,0);
});

test('model tool actions and a malformed answer fail settlement and prevent retries',async t=>{
  for(const opts of [{extra:[{type:'commandExecution'}]},{answer:'I did the task.'},{status:'failed'}]){
    const {options,calls,record}=setup(t);
    await queueReceiptUpdate(update,options);record(opts);
    assert.equal((await queueReceiptUpdate(update,options)).visible,false);
    assert.equal((await queueReceiptUpdate(update,options)).visible,false);
    assert.equal(calls.length,1);
  }
});

test('an ambiguous CLI failure cannot enqueue a second normal model turn',async t=>{
  const {options}=setup(t);let count=0;
  const uncertain={...options,enqueue:async()=>{count++;throw Error('lost CLI acknowledgement');}};
  await queueReceiptUpdate(update,uncertain);await queueReceiptUpdate(update,uncertain);
  assert.equal(count,1);
});

test('a recovered native queue item and an existing busy queue each prevent a duplicate submission',async t=>{
  for(const text of [receiptPrompt(update),'Another native message.']){
    const {options,calls,queue}=setup(t);
    const payload={UserInput:{client_id:'fixture',content:[{type:'text',text,text_elements:[]}]}};
    queue.prepare('INSERT INTO queued_items VALUES(?,?,?)').run('queued-1',threadId,JSON.stringify(payload));
    assert.equal((await queueReceiptUpdate(update,options)).visible,false);
    assert.equal(calls.length,0);
  }
});

test('the CLI receives the chosen home and original message as literal arguments',async t=>{
  const {options}=setup(t),argsFile=path.join(options.codexHome,'args.json');
  const codexExecutable=path.join(options.codexHome,'fixture-codex');
  fs.writeFileSync(codexExecutable,'#!/usr/bin/env node\n'
    +'require("node:fs").writeFileSync('+JSON.stringify(argsFile)+',JSON.stringify([process.env.CODEX_HOME,...process.argv.slice(2)]));',{mode:0o700});
  const literal={...update,text:update.text.replace('Maple Harbour',"'Maple Harbour' & `$(date)`")};
  const configured={...options,codexExecutable,enqueue:undefined,requireGuard:true,guardReady:()=>true};
  const result=await queueReceiptUpdate(literal,configured);
  assert.deepEqual(result,{visible:false,reason:'queued'});
  assert.deepEqual(JSON.parse(fs.readFileSync(argsFile)),[options.codexHome,'queue','--thread',threadId,'--message',receiptPrompt(literal)]);
});

test('a finished receipt in another native thread does not settle this one',async t=>{
  const {options,calls,db,record}=setup(t);
  await queueReceiptUpdate(update,options);
  record();
  db.prepare('UPDATE thread_items SET thread_id=? WHERE turn_id=?').run(deliveryId,'receipt');
  db.prepare('UPDATE thread_turns SET thread_id=? WHERE turn_id=?').run(deliveryId,'receipt');
  assert.equal((await queueReceiptUpdate(update,options)).visible,false);
  assert.equal(calls.length,1);
});

test('another local account cannot authorize model receipt prompts through a writable claim directory',async t=>{
  const {options,calls}=setup(t);
  fs.mkdirSync(options.receiptDir,{mode:0o700});
  fs.chmodSync(options.receiptDir,0o777);
  assert.equal((await queueReceiptUpdate(update,options)).visible,false);
  assert.equal(calls.length,0);
  assert.equal(verifyReceiptPrompt({threadId,prompt:receiptPrompt(update),receiptDir:options.receiptDir}),false);
});

test('receipt verification checks native turn errors, final item identity and moderation',async t=>{
  for(const change of [
    db=>db.exec("UPDATE thread_turns SET error_json='{}' WHERE turn_id='receipt'"),
    db=>db.exec("UPDATE thread_turns SET final_agent_item_id='different' WHERE turn_id='receipt'"),
    db=>db.exec("UPDATE thread_turns SET first_user_item_id='different' WHERE turn_id='receipt'"),
    db=>db.prepare("UPDATE thread_items SET item_json=? WHERE turn_id='receipt' AND item_type='agentMessage'").run(JSON.stringify({type:'agentMessage',text:reply,moderation:{moderated:true,display:{mode:'hide'}}})),
  ]){
    const {options,calls,db,record}=setup(t);await queueReceiptUpdate(update,options);record();change(db);
    assert.equal((await queueReceiptUpdate(update,options)).visible,false);
    assert.equal(calls.length,1);
  }
});
