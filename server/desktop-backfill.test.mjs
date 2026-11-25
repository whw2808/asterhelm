import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {PersonalStore} from './personal-store.mjs';
import {scanDesktop} from './context-desktop.mjs';

test('offline desktop replies survive several pages, a lost receipt and hub restart, in source order',async t=>{
  const hub=mkdtempSync(join(tmpdir(),'work-backfill-'));
  let store=new PersonalStore(join(hub,'hub.sqlite'));
  const db=new DatabaseSync(join(hub,'thread_history_1.sqlite'));
  t.after(()=>{db.close();store.db.close();rmSync(hub,{recursive:true,force:true});});
  const threadId='00000000-0000-4000-8000-000000000001';
  const otherId='00000000-0000-4000-8000-000000000002';
  const scope={machine:'studio',target:'studio.code'};
  const row={...scope,id:threadId,source:'Codex Desktop',title:'Lake atlas',archived:false,evidence:[]};
  const unrelated={...row,id:otherId,title:'Private diary'};
  mkdirSync(join(hub,'contexts'));
  writeFileSync(join(hub,'contexts','studio.json'),JSON.stringify([row,unrelated]));
  const work=store.receive({requestId:'mobile',text:'Review my map',context:{machine:scope.machine,id:threadId}},row);
  db.exec(`CREATE TABLE thread_turns(thread_id,turn_id,rollout_ordinal,status);
    CREATE TABLE thread_items(thread_id,turn_id,item_id,rollout_ordinal,created_at_ms,item_json,item_type);
    CREATE UNIQUE INDEX idx_items ON thread_items(thread_id,rollout_ordinal);`);
  const addTurn=db.prepare('INSERT INTO thread_turns VALUES(?,?,?,?)');
  const addItem=db.prepare('INSERT INTO thread_items VALUES(?,?,?,?,?,?,?)');
  const now=Date.now()+5000;
  function turn(id,n,content,status='completed',at=now){
    addTurn.run(id,'t'+n,n*4,status);
    addItem.run(id,'t'+n,'i'+n,n*4+2,at,JSON.stringify(content),content.type);
  }
  const final=text=>({type:'agentMessage',phase:'final_answer',text});
  turn(threadId,0,final('Before binding'), 'completed',now-15000);
  turn(otherId,1,final('Unrelated private reply'));
  for(let i=1;i<=75;i++)turn(threadId,i,final('Map result '+i));
  turn(threadId,76,{...final('Hidden reply'),moderation:{display:{mode:'hide'}}});
  turn(threadId,77,{...final('Internal progress'),phase:'commentary'});
  turn(threadId,78,final('My password is fictional-only.'));
  turn(threadId,79,final('Receipt echo'));
  const marker='星舵 · 工作更新\n手机：Review the map\n[Asterhelm sync 00000000-0000-4000-8000-000000000010]';
  addItem.run(threadId,'t79','user',79*4+1,now,JSON.stringify({type:'userMessage',content:[{type:'text',text:marker}]}),'userMessage');
  turn(threadId,80,final('Draft in active turn'),'inProgress');
  turn(threadId,81,final('Later settled turn'));
  const deliveryId='00000000-0000-4000-8000-000000000010';
  const receipt='星舵 · 回执请求\n[Asterhelm receipt v1 '+threadId+' '+deliveryId+']\n只回复收悉。\n'+marker;
  addTurn.run(threadId,'receipt-turn',400,'completed');
  addItem.run(threadId,'receipt-turn','request',401,now,JSON.stringify({type:'userMessage',content:[{type:'text',text:receipt}]}),'userMessage');
  for(let i=0;i<125;i++){
    addItem.run(threadId,'receipt-turn','progress'+i,402+i,now,JSON.stringify({...final('Working'),phase:'commentary'}),'agentMessage');
  }
  addItem.run(threadId,'receipt-turn','receipt-result',530,now,JSON.stringify(final('Malformed receipt with no marker')),'agentMessage');
  const state=new DatabaseSync(join(hub,'state_5.sqlite'));
  state.exec('CREATE TABLE threads(id,source,thread_source,originator,name,title,cwd,created_at,updated_at,created_at_ms,updated_at_ms,archived,creator_account_id,creator_user_id)');
  state.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(threadId,'vscode','user','Codex Desktop','Map','','/fiction/maps',0,0,now,now,0,'fiction','user');
  state.close();
  assert.doesNotMatch(JSON.stringify(scanDesktop(hub)),/Malformed receipt/);
  const {desktopBackfill,desktopHasBackfill}=await import('./desktop-backfill.mjs');
  const {syncDesktopBackfill}=await import('./context-backfill.mjs');
  const route=(op,body,device=scope)=>desktopBackfill(store,'/contexts/'+op,{...device,...body},hub);
  assert.deepEqual(route('desktopCursors',{}, {...scope,target:'studio.other'}),{threads:[]});
  assert.deepEqual(route('desktopCursors',{}).threads.map(r=>r.threadId),[threadId]);
  let lost;
  await assert.rejects(syncDesktopBackfill(hub,[row,unrelated],async(op,body)=>{
    const ack=route(op,body);
    if(op==='desktopPage'){lost=body;throw Error('Lost receipt');}
    return ack;
  }),/Lost receipt/);
  assert.ok(lost.evidence.length>0 && lost.evidence.length<75);
  assert.equal(desktopHasBackfill(store,row),true);
  store.db.close();store=new PersonalStore(join(hub,'hub.sqlite'));
  assert.deepEqual(route('desktopPage',lost),{after:lost.through});
  assert.throws(()=>route('desktopPage',{...lost,threadId:otherId}));
  assert.throws(()=>route('desktopPage',lost,{machine:'elsewhere',target:'elsewhere.code'}));
  await syncDesktopBackfill(hub,[row,unrelated],route);
  const replies=()=>store.history({limit:150}).messages.filter(m=>m.provenance);
  assert.deepEqual(replies().map(r=>r.text.split('\n').at(-1)),Array.from({length:75},(_,i)=>'Map result '+(i+1)));
  db.prepare("UPDATE thread_turns SET status='completed' WHERE thread_id=? AND turn_id='t80'").run(threadId);
  db.prepare("UPDATE thread_items SET item_json=? WHERE turn_id='t80'").run(JSON.stringify(final('Finished atlas')));
  await syncDesktopBackfill(hub,[row],route);
  await syncDesktopBackfill(hub,[row],route);
  assert.deepEqual(replies().slice(-2).map(r=>r.text.split('\n').at(-1)),['Finished atlas','Later settled turn']);
  assert.equal(replies().length,77);
  assert.ok(replies().every(m=>m.parent===work.id&&m.provenance.threadId===threadId));
});
