import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatBinding, cardRequest, chatDisplayText, mergeWorkHistory, refreshOlderWork } from './mobile-work.mjs';

const alpha = { machine: 'studio', id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', title: 'Atlas' };
const beta = { machine: 'lab', id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', title: 'Birch' };

test('accepted work survives the next send and a restart, and only explicit joins carry it to another session', () => {
  const binding = new ChatBinding();
  binding.select(alpha);
  const first = binding.request('First scope');
  assert.deepEqual(first.context, { machine: 'studio', id: alpha.id });
  binding.accept(first, 'work-atlas');
  const restart = new ChatBinding(JSON.parse(JSON.stringify(binding.current)));
  assert.equal(restart.request('Second scope').workId, 'work-atlas');
  restart.select(beta, true);
  assert.equal(restart.request('Shared scope').workId, 'work-atlas');
  restart.select(alpha);
  assert.equal(restart.request('Separate scope').workId, undefined);
  restart.select(null);
  assert.equal(restart.request('General question').context, undefined);
});

test('a late receipt cannot reattach work after switching, exiting or reselecting the original session', () => {
  const binding = new ChatBinding();
  binding.select(alpha);
  const pending = binding.request('Scope update');
  for (const selection of [beta, null, alpha]) {
    binding.select(selection);
    const saved = binding.current;
    binding.accept(pending, 'work-atlas');
    assert.equal(binding.current, saved);
    assert.equal(binding.matches(pending), false);
  }
});

test('retry uses the pending request only when text and binding still match, including after a restart', () => {
  const binding = new ChatBinding();
  binding.select(alpha);
  const pending = binding.request('Scope update');
  const reload = new ChatBinding(JSON.parse(JSON.stringify(binding.current)));
  assert.equal(reload.request('Scope update', pending).requestId, pending.requestId);
  assert.notEqual(reload.request('Another update', pending).requestId, pending.requestId);
  reload.select(null);
  assert.notEqual(reload.request('Scope update', pending).requestId, pending.requestId);
  assert.equal(reload.matches({ text: 'Legacy context', context: alpha }), false);
  assert.equal(reload.matches({ text: 'Unbound legacy request' }), true);
});

test('explicit selection recovers a matching unsent legacy native message with its original request ID', () => {
  const binding = new ChatBinding();
  const old = { text: 'Unsynced edit', context: { machine: alpha.machine, id: alpha.id }, requestId: 'legacy-send' };
  assert.equal(binding.restoreText(null, old), '');
  assert.equal(binding.restoreText({ text: old.text, context: alpha }, old), '');
  binding.select(beta);
  assert.equal(binding.recoverLegacy(old), null);
  binding.select(alpha);
  const recovered = binding.recoverLegacy(old);
  assert.equal(binding.restoreText(null, recovered), 'Unsynced edit');
  assert.equal(binding.request('Unsynced edit', recovered).requestId, 'legacy-send');
  binding.select(null);
  assert.equal(binding.restoreText(null, recovered), '');
  assert.equal(binding.restoreText({ text: 'New topic' }, recovered), 'New topic');
});

test('the latest amendment owns one current work card even when older history arrives afterward', () => {
  const work = { id: 'work-iris', revision: 1, goal: 'Review the introduction', state: 'working',
    updatedAt: '2026-01-01T00:01:00Z', tasks: [] };
  const reply = { id: 'amended', seq: 90, role: 'assistant', text: 'Updated', work };
  const previousPage = [{ id: 'work-iris', seq: 1, role: 'user', text: 'Review the draft',
    work: { ...work, revision: 0, goal: 'Review the draft' } }];
  const merged = mergeWorkHistory([reply], previousPage);
  assert.deepEqual(merged.map(message => [message.id, message.work?.goal]), [
    ['work-iris', undefined], ['amended', 'Review the introduction'],
  ]);
  const settled = { ...work, state: 'completed', updatedAt: '2026-01-01T00:02:00Z' };
  const refreshed = mergeWorkHistory(merged, [{ ...previousPage[0], work: settled }]);
  assert.equal(refreshed[1].work.state, 'completed');
  assert.equal(mergeWorkHistory(refreshed, [reply])[1].work.state, 'completed');
});

test('polling an older card continues until a paused step has its execution receipt', async () => {
  const paused = id => ({ id, state: 'paused', tasks: [{ state: 'running', scope: 'paused' }] });
  const older = [
    { id: 'draft', work: paused('draft') },
    { id: 'revision', work: paused('atlas') },
    { id: 'resolved', work: { ...paused('resolved'), tasks: [{ state: 'cancelled', scope: 'paused' }] } },
  ];
  const page = { messages: [{ id: 'amended-draft', work: paused('draft') }], pending: 0 };
  const requests = [];
  await refreshOlderWork(page, older, async id => {
    requests.push(id);
    return { messages: [{ id, work: { ...paused('atlas'), tasks: [{ state: 'cancelled', scope: 'paused' }] } }] };
  });
  assert.deepEqual(requests, ['revision']);
  assert.deepEqual(page.messages.map(message => message.id), ['amended-draft', 'revision']);
  requests.length = 0;
  const updated = mergeWorkHistory(older, page.messages);
  await refreshOlderWork({ messages: [page.messages[0]] }, updated, id => requests.push(id));
  assert.deepEqual(requests, []);
});

const openCard = { id: 'candidate:iris-2', messageId: 'discovery', kind: 'candidate', version: 2,
  title: '核对展品目录', status: 'waiting', detail: '已找到两份目录。', actions: [
    { decision: 'approve', label: '同意立项' }, { decision: 'ignore', label: '忽略' }] };

test('a card decision has one unbound request identity on retry and its chat text names the decision', async () => {
  const send = await cardRequest(openCard, 'approve');
  assert.equal(send.text, '星舵操作 candidate:iris-2 v2 approve');
  assert.deepEqual(Object.keys(send).sort(), ['requestId', 'text']);
  assert.ok(send.requestId.length <= 150);
  assert.deepEqual(await cardRequest(structuredClone(openCard), 'approve'), send);
  assert.notEqual((await cardRequest({ ...openCard, version: 3 }, 'approve')).requestId, send.requestId);
  assert.notEqual((await cardRequest(openCard, 'ignore')).requestId, send.requestId);
  const cards = new Map([[openCard.id, openCard]]);
  const displayed = chatDisplayText(send.text, cards);
  assert.match(displayed, /同意立项/);
  assert.match(displayed, /核对展品目录/);
  assert.doesNotMatch(displayed, /candidate:iris|v2/);
  assert.doesNotMatch(chatDisplayText(send.text), /candidate:iris/);
  const quotation = '请解释「' + send.text + '」。';
  assert.equal(chatDisplayText(quotation, cards), quotation);
});

test('actions can only submit an offered decision for a single identified version', async () => {
  for (const [card, decision] of [
    [openCard, 'pause'], [openCard, 'write'], [{ ...openCard, id: 'two ids' }, 'approve'],
    [{ ...openCard, id: 'a'.repeat(161) }, 'approve'], [{ ...openCard, version: 0 }, 'approve'],
    [{ ...openCard, version: 1.2 }, 'approve'], [{ ...openCard, version: 1000000000 }, 'approve'],
  ]) assert.equal(await cardRequest(card, decision), null);
});

test('older history cannot re-enable an obsolete decision or copy its card onto a later turn', () => {
  const discovery = { id: 'discovery', seq: 3, proactive: [openCard] };
  const approved = { ...openCard, status: 'approved', version: 3, actions: [] };
  const other = { id: 'later', seq: 8, proactive: [openCard] };
  const fresh = mergeWorkHistory([discovery], [{ ...discovery, proactive: [approved] }, other]);
  assert.deepEqual(fresh.flatMap(row => (row.proactive || []).map(card => [row.id, card.status])), [['discovery', 'approved']]);
  const merged = mergeWorkHistory(fresh, [discovery]);
  assert.deepEqual(merged[0].proactive, [approved]);
  assert.equal(mergeWorkHistory(merged, [{ id: 'discovery', seq: 3 }])[0].proactive, undefined);
});

test('a rule can change its last occurrence without changing the user grant version', () => {
  const card = { ...openCard, kind: 'rule', status: 'active', detail: '已登记' };
  const row = { id: 'discovery', seq: 3, proactive: [card] };
  const updated = { ...card, detail: '已核对第一份目录' };
  const fresh = mergeWorkHistory([row], [{ ...row, proactive: [updated] }]);
  assert.deepEqual(fresh[0].proactive, [updated]);
  assert.deepEqual(mergeWorkHistory(fresh, [row], true)[0].proactive, [updated]);
});

test('old window polling updates active proposals and rules on their original rows, skipping settled cards', async () => {
  const row = (id, kind, status) => ({ id, proactive: [{ ...openCard, id: 'card-' + id, messageId: id, kind, status }] });
  const rows = [row('a', 'candidate', 'waiting'), row('b', 'rule', 'paused'), row('c', 'rule', 'cancelled'),
    row('d', 'candidate', 'ignored'), row('e', 'rule', 'active')];
  const page = { messages: [rows[4]] };
  const seen = [];
  await refreshOlderWork(page, rows, async id => { seen.push(id); return { messages: rows.slice(0, 2) }; });
  assert.deepEqual(seen, ['a']);
  assert.deepEqual(page.messages.map(row => row.id), ['e', 'a', 'b']);
});

test('a stopped card with an in-flight check continues polling for its final receipt', async () => {
  const stopped = { ...openCard, status: 'ignored', actions: [], startedAt: '2026-01-01T12:00:00Z' };
  const original = { id: stopped.messageId, seq: 3, proactive: [stopped] };
  const final = { ...original, proactive: [{ ...stopped, finishedAt: '2026-01-01T12:00:04Z' }] };
  const page = { messages: [] };
  await refreshOlderWork(page, [original], async () => ({ messages: [final] }));
  assert.deepEqual(page.messages, [final]);
  await refreshOlderWork({ messages: [] }, page.messages, () => assert.fail('settled card polled'));
});

test('reading earlier history cannot replace a fresher next wake on the same unchanged work revision', () => {
  const work = { id: 'work-books', revision: 1, state: 'working', updatedAt: '2026-01-01T12:00:00Z',
    nextWakeAt: '2026-01-01T13:00:00Z', wakeReason: '等待纸本回执' };
  const older = { id: 'books', seq: 4, work };
  const refreshed = { ...older, work: { ...work, nextWakeAt: '2026-01-01T14:00:00Z', wakeReason: '设备离线，稍后检查' } };
  const current = mergeWorkHistory([older], [refreshed]);
  assert.deepEqual(current[0].work, refreshed.work);
  assert.deepEqual(mergeWorkHistory(current, [older], true)[0].work, refreshed.work);
});
