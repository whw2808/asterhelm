import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../assets/android-host.js', import.meta.url), 'utf8');
const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');

test('native port carries requests, drafts, notification targets and Android back events', async t => {
  const listeners = new Map();
  const window = {
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: name => listeners.delete(name),
  };
  window.top = window;
  globalThis.window = window;
  globalThis.location = {origin: 'https://appassets.androidplatform.net'};
  t.after(() => { delete globalThis.window; delete globalThis.location; });
  const readyRequest = t.mock.method(globalThis, 'fetch', async () => ({}));
  const host = (await import(moduleUrl)).default;
  assert.equal(readyRequest.mock.calls[0].arguments[0], '/native-ready');

  const sent = [];
  const port = {postMessage: message => sent.push(JSON.parse(message))};
  listeners.get('message')({data: 'asterhelm-android-v1', ports: [port]});
  const fromNative = message => port.onmessage({data: JSON.stringify(message)});

  const state = host.state();
  await Promise.resolve();
  const request = sent.pop();
  assert.equal(request.op, 'state');
  fromNative({id: request.id, value: {paired: true}});
  assert.deepEqual(await state, {paired: true});

  const failed = host.call('board');
  await Promise.resolve();
  fromNative({id: sent.pop().id, error: 'unavailable', status: 503});
  await assert.rejects(failed, {message: 'unavailable', status: 503});

  fromNative({event: 'open', target: 'fixture-item'});
  let opened;
  host.onOpen(id => { opened = id; });
  await Promise.resolve();
  assert.equal(opened, 'fixture-item');
  assert.deepEqual(sent.pop(), {event: 'opened', target: 'fixture-item'});

  host.onBack(() => true);
  fromNative({event: 'back', serial: 4});
  assert.deepEqual(sent.pop(), {event: 'back', serial: 4, handled: true});

  const context = {id: 'fixture-item', machine: 'worker'};
  const bound = { text: '整理目录', requestId: 'normal-retry', context, bindingId: 'fixture-binding' };
  const send = host.chat(bound, '展品目录');
  await Promise.resolve();
  const regular = sent.pop();
  assert.deepEqual(regular.body, bound);
  assert.equal(regular.title, '展品目录');
  fromNative({id: regular.id, value: {id: 'user-message'}});
  await send;

  const action = { ...bound, requestId: 'card-fixture', text: '星舵操作 iris v2 ignore' };
  const sendCard = host.chat(action, '展品目录', true);
  await Promise.resolve();
  const control = sent.pop();
  assert.equal(control.op, 'chat');
  assert.equal(control.title, '');
  assert.deepEqual(control.body, { text: '星舵操作 iris v2 ignore', requestId: 'card-fixture', cardAction: true });
  fromNative({id: control.id, value: {id: 'control-message'}});
  await sendCard;

  host.draft('', context);
  await Promise.resolve();
  assert.deepEqual(sent.pop(), {event: 'draft', text: '', context});
});
