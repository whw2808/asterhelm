import test from 'node:test';
import assert from 'node:assert/strict';
import {offlineQuery} from './follow-chat.mjs';

test('offline shortcuts retrieve local goal, activity and usage information',()=>{
  const titles=['春季书展'];
  assert.deepEqual(offlineQuery('重新核对「春季书展」的目标预览',titles),{query:'goals',title:'春季书展'});
  assert.deepEqual(offlineQuery('春季书展现在进度如何？',titles),{query:'goals',title:'春季书展'});
  assert.deepEqual(offlineQuery('我的目标进展如何？',titles),{query:'goals'});
  assert.deepEqual(offlineQuery('查看各个 Agent 的进展',titles),{query:'activity'});
  assert.deepEqual(offlineQuery('查看 Token 用量',titles),{query:'usage'});
  for(const text of ['我的目标是春季书展','确认给春季书展开推送','如果我说“开启目标推送”会发生什么？','暂停目标关注'])
    assert.equal(offlineQuery(text,titles),null,text);
});
