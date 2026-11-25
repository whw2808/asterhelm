import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PersonalStore} from './personal-store.mjs';

const lake={machine:'desk',target:'desk.code',source:'Codex Desktop',id:'10000000-0000-4000-8000-000000000001',title:'Lake atlas',cwd:'/example/maps',evidence:[]};
const ridge={...lake,id:'10000000-0000-4000-8000-000000000002',title:'Ridge atlas'};
const bench={...lake,machine:'bench',target:'bench.code'};
const ref=row=>({machine:row.machine,id:row.id});
const send=(s,row,requestId,text,workId)=>s.receive({context:ref(row),requestId,text,workId},row);
const evidence=(itemId,text,offset,role='assistant',turnId=itemId)=>({role,itemId,turnId,text,at:new Date(Date.now()+offset).toISOString()});
const actor={deviceId:'spare',target:'spare.agent',deviceName:'Spare',agentName:'Atlas reader'};

test('several phone turns and their temporary worker share one durable scoped outbox',t=>{
  const dir=mkdtempSync(join(tmpdir(),'atlas-continuity-'));
  let s=new PersonalStore(join(dir,'store.db'));
  t.after(()=>{s.db.close();rmSync(dir,{recursive:true,force:true});});
  const first=send(s,lake,'lake-1','Keep just the lake outlines.');
  assert.ok(first.workId);
  const second=send(s,lake,'lake-2','Use blue for the shore.');
  assert.equal(second.workId,first.workId);
  const unrelated=send(s,ridge,'ridge','Color the ridge in brown.');
  assert.notEqual(unrelated.workId,first.workId);
  s.receive({requestId:'general',text:'Choose music for the evening.'});
  const step=second.id+':0',task={id:'survey',state:'queued'};
  s.work.create(second,['Produce a map']);
  s.work.stage(second.id,step,actor,'consult','Review the shore');
  s.work.bind(step,task);
  s.work.observe({...task,state:'running',progress:'collecting_result'});
  s.work.observe({...task,state:'running',progress:'collecting_result',lastHeartbeatAt:new Date().toISOString()});
  s.work.observe({...task,state:'succeeded',result:'Map saved at maps/lake.svg.'});
  const [batch]=s.continuity.pending('desk','desk.code').filter(b=>b.threadId===lake.id);
  for(const tag of ['Keep just the lake','Use blue','Atlas reader','maps/lake.svg'])assert.ok(batch.text.includes(tag),tag);
  assert.doesNotMatch(batch.text,/收集|等待执行端接单|#\d/);
  assert.doesNotMatch(batch.text,/ridge|music/);
  assert.deepEqual(s.continuity.pending('desk','desk.other'),[]);
  assert.deepEqual(s.continuity.pending('spare'),[]);
  assert.equal(s.continuity.ack('bench',batch,'bench.code'),false);
  assert.equal(s.continuity.ack('desk',batch,'desk.other'),false);
  assert.equal(s.continuity.ack('desk',{...batch,threadId:ridge.id},'desk.code'),false);
  const status=()=>s.history().messages.find(m=>m.id===second.id).continuity.delivery;
  assert.equal(status(),'pending');
  s.db.close();s=new PersonalStore(join(dir,'store.db'));
  const third=send(s,lake,'lake-3','Add a small legend.');
  assert.deepEqual(s.continuity.pending('desk','desk.code').find(b=>b.threadId===lake.id),batch);
  assert.equal(s.continuity.ack('desk',batch,'desk.code'),true);
  assert.equal(s.continuity.ack('desk',batch,'desk.code'),true);
  assert.equal(status(),'delivered');
  const next=s.continuity.pending('desk','desk.code').find(b=>b.threadId===lake.id);
  assert.match(next.text,/small legend/);assert.doesNotMatch(next.text,/Use blue/);
  assert.notEqual(next.deliveryId,batch.deliveryId);
  assert.equal(send(s,lake,'lake-3','Add a small legend.').id,third.id);
  const history=JSON.stringify(s.continuity.recentForTurn(third.id));
  assert.match(history,/Keep just/);assert.doesNotMatch(history,/ridge|music/);
  const seq=s.history().messages.find(m=>m.id===third.id).seq;
  assert.doesNotMatch(JSON.stringify(s.previous(seq)),/ridge|music/);
});

test('explicitly adding a session shares history with its own cursor without merging independent work',()=>{
  const s=new PersonalStore(':memory:');
  try{
    const first=send(s,lake,'origin','Use the shoreline layer.');
    const another=send(s,ridge,'other','Study the northern ridge.');
    const linked=send(s,bench,'link','Compare the print preview.',first.workId);
    assert.ok(linked.workId);assert.equal(linked.workId,first.workId);
    assert.throws(()=>send(s,ridge,'conflict','Cross-check.',first.workId));
    assert.throws(()=>send(s,bench,'link','Compare the print preview.',another.workId));
    assert.throws(()=>s.receive({workId:first.workId,requestId:'unscoped',text:'Attach someone'}));
    const [out]=s.continuity.pending('bench','bench.code');
    assert.match(out.text,/shoreline/);assert.doesNotMatch(out.text,/ridge/);
    s.continuity.ack('bench',out,'bench.code');
    assert.ok(s.continuity.pending('desk','desk.code').some(b=>b.threadId===lake.id));
    assert.equal(s.continuity.participants(first.workId).length,2);
  }finally{s.db.close();}
});

test('desktop replies after binding reach the phone and other participants exactly once with provenance',()=>{
  const s=new PersonalStore(':memory:');
  try{
    const old=evidence('older','Old archived sketch.',-45000);
    const initial={...lake,evidence:[old]};
    const first=send(s,initial,'phone','Finish the map legend.');
    send(s,bench,'join','Also check layout.',first.workId);
    const fresh=evidence('result','The legend is now aligned.',5000);
    const echo=evidence('ack','星舵 · 工作更新 [Asterhelm sync example] Phone note.',6000,'user');
    const echoAnswer=evidence('agent-ack','Received the sync.',7000,'assistant','ack');
    const secret=evidence('secret','The password is fiction.',8000);
    const receipt=evidence('receipt','星舵 · 回执请求 请显示这条摘要。',9000,'user');
    const stray=evidence('bad-receipt','Unexpected acknowledgement without a marker.',10000,'assistant','receipt');
    const row={...lake,evidence:[old,fresh,echo,echoAnswer,secret,receipt,stray]};
    s.continuity.observeDesktop([row,row,{...ridge,evidence:[evidence('other','Stray message.',10000)]}]);
    s.continuity.observeDesktop([{...lake,evidence:[echoAnswer]}]);
    const replies=s.history().messages.filter(m=>m.role==='assistant');
    assert.equal(replies.length,1);
    assert.equal(replies[0].parent,first.id);assert.match(replies[0].text,/desk.*Lake atlas/s);
    assert.match(replies[0].text,/legend is now aligned/);
    assert.equal(replies[0].provenance.itemId,'result');
    assert.equal(replies[0].provenance.threadId,lake.id);
    assert.equal(s.notifications().items.length,1);
    assert.doesNotMatch(s.continuity.pending('desk','desk.code')[0].text,/legend is now aligned/);
    const [out]=s.continuity.pending('bench','bench.code');
    assert.match(out.text,/legend is now aligned/);assert.doesNotMatch(out.text,/archived|Stray|fiction|Received/);
  }finally{s.db.close();}
});

test('old and missing desktop snapshots suppress pre-binding items and observe a real subsequent reply',()=>{
  const s=new PersonalStore(':memory:');
  try{
    const first=send(s,lake,'start','Show the location.');
    const old=evidence('old','History before binding.',-5000);
    s.continuity.observeDesktop([{...lake,evidence:[old]},{...lake,evidence:[]}]);
    const newer=evidence('new','Moved the pin to the lake.',5000);
    s.continuity.observeDesktop([{...lake,target:'other',evidence:[old,newer]}]);
    assert.equal(s.history().messages.length,1);
    s.continuity.observeDesktop([{...lake,evidence:[old,newer]}]);
    assert.equal(s.history().messages.at(-1).parent,first.id);
    assert.match(s.history().messages.at(-1).text,/Moved the pin/);
  }finally{s.db.close();}
});

test('task cancellation requests, confirmed stops and filtered worker receipts stay distinct',()=>{
  const s=new PersonalStore(':memory:');
  try{
    const first=send(s,lake,'start','Check the lake map.');
    send(s,lake,'sensitive','My password is fictional-only.');
    s.work.create(first,['Review the map']);
    for(const id of ['stop','output','key']){
      s.work.stage(first.id,id,actor,'consult','Check map labels');
      s.work.bind(id,{id,state:'running',progress:'running_executor'});
    }
    s.work.observe({id:'stop',state:'running',cancelRequested:1});
    const [before]=s.continuity.pending('desk','desk.code');
    assert.match(before.text,/已请求停止/);assert.doesNotMatch(before.text,/已确认停止|fictional-only/);
    s.continuity.ack('desk',before,'desk.code');
    s.work.observe({id:'stop',state:'cancelled'});
    s.work.observe({id:'output',state:'succeeded',result:'Chunk ID: DEMO\nProcess exited with code 0\nInternal diagnostic'});
    s.work.observe({id:'key',state:'succeeded',result:'Summary: access token = fictional-only'});
    const [after]=s.continuity.pending('desk','desk.code');
    assert.match(after.text,/已确认停止/);assert.doesNotMatch(after.text,/Internal diagnostic|fictional-only/);
  }finally{s.db.close();}
});

test('catch-up serves the latest decisions behind an unacknowledged batch without changing delivery',()=>{
  const s=new PersonalStore(':memory:');
  try{
    const first=send(s,lake,'start','Use blue on the outline.');
    const [frozen]=s.continuity.pending('desk','desk.code');
    send(s,lake,'amend','Use green for the final outline.');
    send(s,ridge,'other','Keep the mountain outline white.');
    send(s,bench,'join','Print the map in portrait.',first.workId);
    s.work.create(first,['Confirm paper size']);
    s.work.stage(first.id,'paper',actor,'consult','Confirm paper size');
    s.work.bind('paper',{id:'paper-task',state:'running',progress:'claimed'});
    const baseline=s.continuity.catchUp('desk','desk.code').find(item=>item.threadId===lake.id);
    s.work.observe({id:'paper-task',state:'succeeded',result:'A4 paper confirmed.'});
    const answer=evidence('desk-result','I put the scale on the map.',5000);
    s.continuity.observeDesktop([{...lake,evidence:[answer]}]);
    const next=s.continuity.catchUp('desk','desk.code').find(item=>item.threadId===lake.id);
    assert.equal(next.workId,first.workId);assert.ok(next.revision>baseline.revision);
    assert.match(JSON.stringify(next.events),/Use green/);assert.match(JSON.stringify(next.events),/A4 paper/);
    assert.doesNotMatch(JSON.stringify(next.events),/已接单|mountain|put the scale/);
    assert.match(JSON.stringify(s.continuity.catchUp('bench','bench.code')),/put the scale/);
    assert.deepEqual(s.continuity.catchUp('desk','other'),[]);
    assert.deepEqual(s.continuity.catchUp('spare','spare.agent'),[]);
    assert.equal(s.history().messages[0].continuity.delivery,'pending');
    assert.deepEqual(s.continuity.pending('desk','desk.code').find(item=>item.threadId===lake.id),frozen);
    for(let i=0;i<15;i++)send(s,lake,'detail-'+i,'Map detail '+i);
    const compact=s.continuity.catchUp('desk','desk.code').find(item=>item.threadId===lake.id);
    assert.equal(compact.events.length,8);assert.match(compact.events.at(-1).text,/Map detail 14/);
  }finally{s.db.close();}
});

test('worker output contains only compact human-facing findings and retains a trailing artifact reference',()=>{
  const s=new PersonalStore(':memory:');
  try{
    const parent=send(s,lake,'report','Produce an atlas.');
    s.work.create(parent,['Produce an atlas']);
    for(const id of ['report','tool-log','stderr']){
      s.work.stage(parent.id,id,actor,'consult','Atlas findings');
      s.work.bind(id,{id,state:'running'});
    }
    s.work.observe({id:'tool-log',state:'succeeded',result:'{"type":"item.completed","item":{"type":"command_execution","aggregated_output":"debug-metadata"}}'});
    s.work.observe({id:'stderr',state:'failed',result:'Private diagnostic directory.'});
    s.work.observe({id:'report',state:'succeeded',result:'Verified the contour levels. '+('Additional map detail. '.repeat(30))+'Use output/atlas.svg next.'});
    const [out]=s.continuity.pending('desk','desk.code');
    assert.match(out.text,/Verified the contour levels/);assert.match(out.text,/output\/atlas.svg/);
    assert.doesNotMatch(out.text,/debug-metadata|Private diagnostic directory/);
    assert.doesNotMatch(JSON.stringify(s.continuity.catchUp('desk','desk.code')),/debug-metadata/);
  }finally{s.db.close();}
});

test('phone scope, its proposed layout and final findings survive many newer independent steps',()=>{
  const s=new PersonalStore(':memory:');
  try{
    const parent=send(s,lake,'start','Focus only on the western shoreline.');
    s.finish(parent,'I suggest a two-column legend with tide marks.');
    const amend=send(s,lake,'amend','Yes, exclude the eastern shore.');
    s.finish(amend,'Understood. I will check the revised scope.');
    s.work.create(amend,['Inspect the atlas']);
    for(let i=0;i<36;i++){
      const id='check-'+i;
      s.work.stage(amend.id,id,actor,'consult','Inspect tile '+i);
      s.work.bind(id,{id,state:'running'});
      if(i<8)s.work.observe({id,state:'succeeded',result:'Tile '+i+' saved.'});
    }
    for(const item of [s.continuity.catchUp('desk','desk.code',lake.id)[0],s.continuity.recentForTurn(amend.id)]){
      const rows=item.events;
      assert.ok(rows.some(e=>e.source==='手机' && e.text.includes('exclude the eastern shore')));
      assert.ok(rows.some(e=>e.source==='手机助手' && e.text.includes('two-column legend')));
      assert.ok(rows.some(e=>e.text.includes('Tile 7 saved')));
      assert.ok(rows.some(e=>e.text.includes('Inspect tile 35')));
      assert.equal(item.hasMore,true);
      assert.equal(item.historyAnchor,parent.id);
    }
    send(s,ridge,'other','Do not share this ridge description.');
    assert.deepEqual(s.continuity.catchUp('desk','desk.code',lake.id).map(x=>x.threadId),[lake.id]);
    assert.deepEqual(s.continuity.catchUp('bench','desk.code',lake.id),[]);
    for(const invalid of ['',null,undefined]){
      assert.deepEqual(s.continuity.catchUp('desk','desk.code',invalid),[]);
    }
  }finally{s.db.close();}
});

test('direct replies and actual router synthesis are attributed and filtered by source and memory',async()=>{
  const {deliverWork}=await import('./router-delivery.mjs');
  const s=new PersonalStore(':memory:');
  try{
    const initial=send(s,lake,'begin','Use a compact legend.');
    s.finish(initial,'I propose three columns.');
    const privateTurn=send(s,lake,'private','Personal preference: alphabetize the tulips.');
    const frozen=s.continuity.pending('desk','desk.code')[0];
    assert.match(frozen.text,/alphabetize the tulips/);
    s.remember(privateTurn,{key:'sorting',scope:'global',text:'alphabetize the tulips'});
    assert.equal(s.continuity.ack('desk',frozen,'desk.code'),false);
    s.finish(privateTurn,'I remembered that you alphabetize the tulips.');
    const unsafe=send(s,lake,'unsafe','Check the labeling.');
    s.finish(unsafe,'The password is private-example.');
    const order=send(s,lake,'order','Check the selected columns.');
    s.work.create(order,['Check all three columns']);
    s.work.stage(order.id,'columns',actor,'consult','Inspect columns');
    s.work.bind('columns',{id:'column-report',state:'succeeded',result:'Three columns verified.'});
    s.db.prepare("UPDATE turns SET state='done' WHERE id=?").run(order.id);
    await deliverWork({store:s,broker:async()=>[],planner:{plan:async()=>({reply:'All three columns fit a single page.',coverage:[{index:0,status:'answered',finding:'They fit.',sources:['column-report']}]})}});
    const [out]=s.continuity.catchUp('desk','desk.code',lake.id);
    assert.ok(out.events.some(e=>e.source==='手机助手' && e.text==='I propose three columns.'));
    assert.ok(out.events.some(e=>e.source==='手机助手' && e.text==='All three columns fit a single page.'));
    assert.doesNotMatch(JSON.stringify(out),/remembered|private-example/);
    const drop=send(s,lake,'drop','Forget the sorting preference.');
    s.forget(drop,s.preferences()[0].id);
    s.work.create(privateTurn,['Check the old preference']);
    s.work.stage(privateTurn.id,'deferred',actor,'consult','Follow the old preference');
    s.work.bind('deferred',{id:'late',state:'succeeded',result:'Late reply: alphabetize the tulips.'});
    for(const summary of [s.continuity.catchUp('desk','desk.code',lake.id),s.continuity.recentForTurn(drop.id),s.continuity.pending('desk','desk.code')]){
      assert.doesNotMatch(JSON.stringify(summary),/alphabetize the tulips/);
    }
  }finally{s.db.close();}
});
