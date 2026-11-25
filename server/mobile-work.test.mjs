import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatBinding } from './mobile-work.mjs';

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
