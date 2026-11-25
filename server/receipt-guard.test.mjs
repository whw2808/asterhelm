import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {receiptGuard} from './receipt-guard.mjs';

test('only locally authenticated receipt turns are denied local tool calls; an ordinary next turn proceeds',async t=>{
  const receiptDir=mkdtempSync(path.join(os.tmpdir(),'work-receipt-'));
  t.after(()=>rmSync(receiptDir,{recursive:true,force:true}));
  const session_id=randomUUID(),turn_id=randomUUID(),prompt='星舵 · 回执请求\nSigned data';
  const hooks={receiptDir,verify:async x=>x.threadId===session_id&&x.prompt===prompt};
  const fire=(event,extra={})=>receiptGuard({session_id,turn_id,hook_event_name:event,...extra},hooks);
  assert.deepEqual(await fire('UserPromptSubmit',{prompt:'星舵 · 回执请求\nFake'}),{});
  assert.deepEqual(await fire('PreToolUse'),{});
  await fire('UserPromptSubmit',{prompt});
  assert.equal((await fire('PreToolUse')).hookSpecificOutput.permissionDecision,'deny');
  assert.deepEqual(await fire('PreToolUse',{turn_id:randomUUID()}),{});
  assert.deepEqual(await fire('PreToolUse',{session_id:randomUUID()}),{});
  await fire('Stop');
  assert.deepEqual(await fire('PreToolUse'),{});
});
