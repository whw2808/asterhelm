import test from 'node:test';
import assert from 'node:assert/strict';
import {hookReply} from './work-context.mjs';

const session_id='fb1dd775-8ed7-40ad-8ed5-b0693e55a40f';
const work={threadId:session_id,events:[{source:'手机',text:'只做纸本。'}]};
test('resuming or continuing a linked original chat shows its own dated facts without elevating their authority',async()=>{
  for(const hook_event_name of ['SessionStart','UserPromptSubmit']){
    const output=await hookReply({session_id,hook_event_name,source:'resume'},async id=>id===session_id?{work,ticket:'grant'}:null);
    assert.match(output.systemMessage,/只做纸本/);
    if(hook_event_name==='SessionStart'){assert.equal(output.hookSpecificOutput,undefined);continue;}
    assert.match(output.hookSpecificOutput.additionalContext,/get_work_context/);
    assert.doesNotMatch(output.hookSpecificOutput.additionalContext,/只做纸本/);
  }
});

test('unbound, forked, unrelated and unavailable contexts stay silent',async()=>{
  for(const sample of [{session_id:'other'},{session_id,source:'fork'},{session_id,agent_id:'child'},{session_id,hook_event_name:'Stop'}]){
    assert.deepEqual(await hookReply({hook_event_name:'SessionStart',...sample},async()=>work),{});
  }
  assert.deepEqual(await hookReply({hook_event_name:'UserPromptSubmit',session_id},async()=>null),{});
});

test('a hook read ticket is short lived and has one device, connector and thread',async()=>{
  const {WorkReadTickets}=await import('./work-read-tickets.mjs');
  let now=1000;
  const grants=new WorkReadTickets(()=>now);
  const pass=grants.issue('desk','desk.codex',session_id);
  assert.equal(grants.resolve('desk','desk.codex',session_id),null);
  assert.equal(grants.resolve('other','desk.codex',pass),null);
  assert.equal(grants.resolve('desk','other',pass),null);
  assert.equal(grants.resolve('desk','desk.codex',pass),session_id);
  now+=300001;
  assert.equal(grants.resolve('desk','desk.codex',pass),null);
});
