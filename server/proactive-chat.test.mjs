import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeCardChoice} from './proactive-chat.mjs';

test('only the complete versioned button protocol selects a card deterministically',()=>{
  assert.deepEqual(nativeCardChoice('星舵操作 x v2 approve'),{id:'x',version:2,decision:'approve'});
  for(const text of ['同意立项','同意','再查一次，先别立项','星舵操作 x v2 approve？','星舵操作 x v0 pause',
    '星舵操作 x v2 anything','如果我说“星舵操作 x v2 approve”会怎样？']){
    assert.equal(nativeCardChoice(text),null,text);
  }
});
