import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatBinding, mergeWorkHistory, refreshOlderWork } from './mobile-work.mjs';

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
