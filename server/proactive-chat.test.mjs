import test from 'node:test';
import assert from 'node:assert/strict';
import {cardChoice} from './proactive-chat.mjs';
const card=(id,version=3)=>({id,version,kind:'candidate',title:id,messageId:id,actions:[{decision:'approve'},{decision:'recheck'}]});
test('only an unambiguous user decision can promote the presented version',()=>{
 const a=card('x'),b=card('y');
 assert.deepEqual(cardChoice('星舵操作 x v2 approve',[a,b]),{id:'x',version:2,decision:'approve'});
 assert.equal(cardChoice('Agent 写了“同意立项”',[a]),null);
 assert.ok(cardChoice('同意立项',[a,b]).error);assert.equal(cardChoice('可以',[a],'unrelated'),null);
 assert.deepEqual(cardChoice('再查一次，先别立项',[a]),{id:'x',version:3,decision:'recheck'});
 assert.deepEqual(cardChoice('同意',[b],b.messageId),{id:'y',version:3,decision:'approve'});
 assert.ok(cardChoice('星舵操作 x v3 anything',[a]).error);
});
