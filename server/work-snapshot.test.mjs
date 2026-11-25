import test from 'node:test';
import assert from 'node:assert/strict';
import {PersonalStore} from './personal-store.mjs';
import {PersonalAgent} from './personal-service.mjs';

test('a linked planner receives only its own reminders, observations, reviews and applicable preferences',async t=>{
  const store=new PersonalStore(':memory:');
  t.after(()=>store.db.close());
  const now=new Date().toISOString();
  const session=(id,title)=>({machine:'studio',target:'studio.codex',id,title,cwd:'/projects/'+title,
    source:'Codex Desktop',updatedAt:now,status:'completed',evidence:[{role:'assistant',text:'Next step: still pending '+title}]});
  const atlas=session('00000000-0000-4000-8000-000000000001','Atlas');
  const garden=session('00000000-0000-4000-8000-000000000002','Garden');
  const sessions=[atlas,garden];
  const agent=new PersonalAgent({store,broker:async()=>[],contexts:{readContexts:()=>sessions,
    readSession:(_home,machine,id)=>sessions.find(s=>s.machine===machine&&s.id===id),
    contextCoverage:()=>[{machine:'elsewhere',projectAliases:[{project:'unrelated directory'}]}]}});
  store.observeSessions(sessions);
  for(const row of sessions){
    const turn=store.receive({requestId:row.id,text:'Work on '+row.title,context:{machine:row.machine,id:row.id}},row);
    store.addCommitment('todo-'+row.title,'Reminder '+row.title,null,0,turn.id);
    agent.flows.addReview('review-'+row.title,turn,'Review '+row.title,now,0);
    // Independent works can use the same checkout.
    store.remember(turn,{key:'style-'+row.title,scope:atlas.cwd,text:'Style '+row.title});
    if(row===garden)store.remember(turn,{key:'language',scope:'global',text:'Use English'});
  }
  const linked=await agent.snapshot(store.pending());
  assert.deepEqual(linked.commitments.map(i=>i.text).sort(),['Atlas · Next step: still pending Atlas','Reminder Atlas','Review Atlas'].sort());
  assert.deepEqual(linked.preferences.map(i=>i.text).sort(),['Style Atlas','Use English']);
  assert.doesNotMatch(JSON.stringify(linked.coverage),/elsewhere|unrelated directory/);
  const general=store.receive({requestId:'general',text:'What is outstanding?'});
  const overview=await agent.snapshot({...general,text:'What is outstanding?',seq:99});
  assert.match(JSON.stringify(overview.commitments),/Reminder Garden/);
  assert.match(JSON.stringify(overview.coverage),/unrelated directory/);
});
