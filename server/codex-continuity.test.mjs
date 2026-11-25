import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {deliverCodexUpdate} from './codex-continuity.mjs';

const threadId = '11111111-1111-4111-8111-111111111111';
const deliveryId = '22222222-2222-4222-8222-222222222222';
const text = '星舵 · 工作更新\nMaple Harbour changed its opening date.\n[Asterhelm sync ' + deliveryId + ']';
const update = {threadId, deliveryId, text};
const receipt = {turnId: 'turn-maple', itemId: 'item-maple'};
const entry = {turnId: receipt.turnId, item: {id: receipt.itemId, type: 'agentMessage', phase: 'final_answer', text}};

function desktop({status = 'idle', id = threadId, stored = [], append, readBack} = {}) {
  const writes = [];
  const request = async (method, params) => {
    assert.equal(params.threadId, threadId);
    if (method === 'thread/read') return {thread: {id, status: {type: status}, historyMode: 'paginated'}};
    if (method === 'thread/searchOccurrences') {
      assert.equal(params.searchTerm, '[Asterhelm sync ' + deliveryId + ']');
      const data = stored.filter(row => row.item.text?.includes(params.searchTerm))
        .map(row => ({turnId: row.turnId, itemId: row.item.id}));
      return {data, nextCursor: null};
    }
    if (method === 'thread/items/read') {
      assert.deepEqual(params, {threadId, turnId: receipt.turnId, itemIds: [receipt.itemId]});
      return {data: readBack ?? stored.filter(row => row.turnId === params.turnId && params.itemIds.includes(row.item.id))};
    }
    throw Error('Unexpected native method ' + method);
  };
  const appendNote = async item => {
    assert.deepEqual(item, update);
    writes.push(item);
    if (append) return append(stored);
    stored.push(entry);
    return receipt;
  };
  return {request, appendNote, writes};
}

test('only a native history receipt confirms an idempotent display note', async () => {
  const native = desktop();
  assert.equal((await deliverCodexUpdate(update, native)).visible, true);
  assert.equal((await deliverCodexUpdate(update, native)).visible, true);
  assert.equal(native.writes.length, 1);
});

test('a persisted note recovers after its writer loses the response', async () => {
  const native = desktop({append(stored) { stored.push(entry); throw Error('disconnected after write'); }});
  await deliverCodexUpdate(update, native);
  assert.equal((await deliverCodexUpdate(update, native)).visible, true);
  assert.equal(native.writes.length, 1);
});

test('offline, unloaded, active and different threads cannot receive a note', async () => {
  assert.equal((await deliverCodexUpdate(update)).visible, false);
  for (const options of [{status: 'notLoaded'}, {status: 'active'}, {status: 'systemError'}, {id: deliveryId}]) {
    const native = desktop(options);
    assert.equal((await deliverCodexUpdate(update, native)).visible, false);
    assert.equal(native.writes.length, 0);
  }
});

test('a writer submission receipt alone cannot confirm delivery', async () => {
  const native = desktop({append: () => ({...receipt, visible: true})});
  assert.equal((await deliverCodexUpdate(update, native)).visible, false);
  const offline = desktop();
  offline.request = async () => { throw Error('shared app server unavailable'); };
  assert.equal((await deliverCodexUpdate(update, offline)).visible, false);
  assert.equal(offline.writes.length, 0);
});

test('unrelated, hidden, partial and non-conversation items cannot confirm a matching write', async () => {
  for (const row of [
    {...entry, turnId: 'some-other-turn'},
    {...entry, item: {...entry.item, id: 'another-item'}},
    {...entry, item: {...entry.item, text: text + ' copied'}},
    {...entry, item: {...entry.item, moderation: {moderated: true, display: {mode: 'hide'}}}},
    {...entry, item: {type: 'reasoning', id: receipt.itemId, text}},
    {...entry, item: {type: 'commandExecution', id: receipt.itemId, aggregatedOutput: text}},
  ]) {
    const native = desktop({append: () => receipt, readBack: [row]});
    assert.equal((await deliverCodexUpdate(update, native)).visible, false);
  }
});

test('misbound delivery markers do not reach a native writer', async () => {
  const native = desktop();
  for (const item of [{...update, deliveryId: threadId}, {...update, threadId: ''}, {...update, text: ''}]) {
    assert.equal((await deliverCodexUpdate(item, native)).visible, false);
  }
  assert.equal(native.writes.length, 0);
});

test('an ordinary unmoderated persisted final answer already visible needs no new write', async () => {
  const item = {...entry.item, moderation: {moderated: false, display: null}};
  const native = desktop({stored: [{...entry, item}]});
  assert.equal((await deliverCodexUpdate(update, native)).visible, true);
  assert.equal(native.writes.length, 0);
});

test('an explicit local native writer gets a single JSON request on stdin and an independent history check', async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'asterhelm-native-note-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const noteWriter = path.join(dir, 'note-writer');
  const captured = path.join(dir, 'request.json');
  writeFileSync(noteWriter, '#!/usr/bin/env node\n'
    + 'const fs = require("node:fs");\n'
    + 'fs.writeFileSync(' + JSON.stringify(captured) + ', fs.readFileSync(0));\n'
    + 'process.stdout.write(' + JSON.stringify(JSON.stringify(receipt)) + ');\n', {mode: 0o700});
  const socketPath = path.join(dir, 'native.sock');
  const altered = {...update, text: update.text + "\nReview 'Maple' & the `$(date)` example."};
  const native = desktop({readBack: [{...entry, item: {...entry.item, text: altered.text}}]});
  const result = await deliverCodexUpdate(altered, {request: native.request, noteWriter, socketPath});
  assert.equal(result.visible, true);
  assert.deepEqual(JSON.parse(readFileSync(captured)), {operation: 'putIfIdle', socketPath, ...altered});
});

test('connecting to an unavailable public socket keeps the update pending', async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'asterhelm-offline-note-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const result = await deliverCodexUpdate(update, {socketPath: path.join(dir, 'missing.sock')});
  assert.equal(result.visible, false);
});

test('retries recover a matching visible note followed by many unrelated items', async () => {
  const stored = [entry, ...Array.from({length: 35}, (_, n) => ({turnId: 'turn-' + n,
    item: {id: 'item-' + n, type: 'agentMessage', text: 'Another message'}}))];
  const native = desktop({stored});
  assert.equal((await deliverCodexUpdate(update, native)).visible, true);
  assert.equal(native.writes.length, 0);
});
