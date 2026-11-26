import test from 'node:test';
import assert from 'node:assert/strict';
import {followIntent,resolveGoalChoice} from './follow-chat.mjs';

test('plain goals start a local preview with meaningful search terms, user-selected signals and an optional horizon',()=>{
  const now=Date.parse('2026-01-01T00:00:00Z');
  const intent=followIntent('帮我跨设备关注春季图书展。先预览，只在有结果或遇到阻塞时提示，推送等我确认后再开。',{now});
  assert.equal(intent.kind,'register');assert.equal(intent.spec.title,'春季图书展');
  assert.ok(intent.spec.terms.includes('春季图书展'));assert.equal(intent.spec.until,null);
  assert.deepEqual(intent.spec.signals.sort(),['blocker','result']);
  assert.equal(followIntent('接下来两周，春季图书展是我的重点。',{now}).spec.until,'2026-01-15T00:00:00.000Z');
  assert.equal(followIntent('我的目标是完成春季图书展').spec.title,'完成春季图书展');
  assert.equal(followIntent('帮我跨设备跟进春季图书展这个目标，先看看它会提醒我什么').spec.title,'春季图书展');
});
test('one-shot requests, standing rules, quoted commands and speculative consent never grant goal notifications',()=>{
  for(const text of ['帮我整理春季图书展的目录','每次校对失败都提醒我','持续推进春季图书展直到完成','好','同意','继续','先看看，等我确认后开启推送','如果我说“开启目标推送”会发生什么？','不要关注图书展','转述：“我的目标是完成春季图书展”']){
    assert.equal(followIntent(text),null,text);
  }
  assert.equal(followIntent('我的目标进展如何？').kind,'query');
  assert.equal(followIntent('这个目标会提醒我什么？').kind,'query');
  assert.equal(followIntent('只关注我选的两个项目里的春季图书展').kind,'clarify');
});
test('mutations select one current goal by explicit title, card, or a unique actionable goal',()=>{
  const card=(id,title)=>({kind:'goal',id,title,status:'preview',version:2,actions:[{decision:'enable'}]});
  const cards=[card('g1','春季书展'),card('g2','夏季水展')];
  assert.ok(resolveGoalChoice(followIntent('确认开启目标推送'),cards).error);
  assert.deepEqual(resolveGoalChoice(followIntent('确认开启「春季书展」的目标推送'),cards),{id:'g1',version:2,decision:'enable'});
  assert.deepEqual(followIntent('星舵操作 g1 v2 enable', {goalIds:['g1']}),{kind:'decision',id:'g1',version:2,decision:'enable'});
  assert.equal(followIntent('星舵操作 r1 v2 pause',{goalIds:['g1']}),null);
});
test('a follow-up question can name a known goal; a later-confirmation instruction preserves preview',()=>{
  const titles=['春季书展','冬季航线'];
  assert.deepEqual(followIntent('春季书展现在进度如何？',{titles}),{kind:'query',title:'春季书展'});
  assert.equal(followIntent('先别开推送，等我确认后再开',{titles}).kind,'hold');
  assert.equal(followIntent('确认给春季书展开推送',{titles}).decision,'enable');
  assert.deepEqual(followIntent('重新核对「春季书展」的目标预览',{titles}),{kind:'query',title:'春季书展',recheck:true});
  assert.equal(followIntent('如果我说确认给春季书展开推送呢',{titles}),null);
  const now=Date.parse('2026-01-01T00:00:00Z');
  assert.equal(followIntent('春季书展是我这两周的重点',{now}).spec.until,'2026-01-15T00:00:00.000Z');
});
test('turning notifications off keeps following; pausing the goal stops its observations',()=>{
  assert.equal(followIntent('关闭这个目标的推送').decision,'preview');
  assert.equal(followIntent('暂停目标关注').decision,'pause');
});

test('a topic can precede the follow verb; references and quoted errors stay separate',()=>{
  for(const text of ['纸本目录的也跟进','纸本目录也帮我盯一下','把纸本目录也持续跟进']){
    assert.equal(followIntent(text)?.spec?.title,'纸本目录',text);
  }
  for(const text of ['这份工作也跟进','对啊我让你把这份工作也跟进，为什么回复我：无法登记提醒','也跟进刚才说的那个项目']){
    assert.equal(followIntent(text)?.kind,'reference',text);
  }
  for(const text of ['如果纸本目录也跟进会怎样','别把纸本目录也跟进','为什么纸本目录也跟进？','他说“纸本目录也跟进”','替我问问纸本目录也跟进了吗']){
    assert.equal(followIntent(text),null,text);
  }
});
test('a spoken correction retains its command when the acknowledgment is followed by a comma',()=>{
  assert.equal(followIntent('对啊，我让你把刚才那项工作也跟进，为什么没登记？')?.kind,'reference');
  assert.equal(followIntent('纸本目录的也跟进吗？'),null);
});
