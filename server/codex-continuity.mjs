import {execFile} from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import {idPattern} from './context-format.mjs';

const timeoutMs = 5000;
const pending = reason => ({visible: false, reason});

// Codex's public Unix listener speaks WebSocket over an HTTP upgrade. Route
// only the upgrade through the configured socket; Node handles WebSocket frames.
function localSocket(socketPath) {
  const dispatcher = {
    dispatch(options, handler) {
      const upgrade = http.request({socketPath, method: 'GET', path: '/', agent: false,
        headers: {...options.headers, Connection: 'Upgrade', Upgrade: 'websocket'}});
      handler.onConnect(() => upgrade.destroy(), null);
      upgrade.on('error', error => handler.onError(error));
      upgrade.on('response', response => {
        response.resume();
        handler.onError(Error('Native app server refused WebSocket upgrade'));
      });
      upgrade.on('upgrade', (response, socket, head) => {
        if (head.length) socket.unshift(head);
        handler.onUpgrade(response.statusCode, response.rawHeaders.map(value => Buffer.from(value)), socket);
      });
      upgrade.setTimeout(timeoutMs, () => upgrade.destroy(Error('Connection timed out')));
      upgrade.end();
      return true;
    },
  };
  return new WebSocket('ws://localhost/', {dispatcher});
}

async function withSharedServer({socketPath}, use) {
  const socket = localSocket(socketPath);
  let serial = 0, outstanding;
  socket.onmessage = ({data}) => {
    try {
      const reply = JSON.parse(data);
      if (outstanding && reply.id === outstanding.id && !reply.method) {
        if (reply.error) outstanding.reject(Error('Native app server rejected request'));
        else outstanding.resolve(reply.result);
      }
    } catch { outstanding?.reject(Error('Invalid native response')); }
  };
  socket.onclose = socket.onerror = () => outstanding?.reject(Error('Native app server disconnected'));
  async function request(method, params) {
    const id = ++serial;
    const timer = setTimeout(() => outstanding?.reject(Error('Native request timed out')), timeoutMs);
    try {
      return await new Promise((resolve, reject) => {
        outstanding = {id, resolve, reject};
        socket.send(JSON.stringify({method, id, params}));
      });
    } finally {
      clearTimeout(timer);
      outstanding = null;
    }
  }
  try {
    const opening = setTimeout(() => outstanding?.reject(Error('Native connection timed out')), timeoutMs);
    try {
      await new Promise((resolve, reject) => {
        outstanding = {reject};
        socket.onopen = resolve;
      });
    } finally {
      clearTimeout(opening);
    }
    await request('initialize', {clientInfo: {name: 'asterhelm_continuity', version: '1'}, capabilities: {experimentalApi: true}});
    socket.send('{"method":"initialized"}');
    return await use(request);
  } finally {
    outstanding = null;
    socket.close();
  }
}

// A compatible native client supplies this executable. Its putIfIdle operation
// must atomically check the original thread is idle, append a display-only note
// once per (threadId, deliveryId), and return the same locator on retries.
function runWriter(options, update) {
  return new Promise((resolve, reject) => {
    const child = execFile(options.noteWriter, [], {timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 32768},
      (error, stdout) => {
        if (error) return reject(Error('Native note writer unavailable'));
        try { resolve(JSON.parse(stdout)); }
        catch { reject(Error('Invalid native note locator')); }
      });
    child.stdin.on('error', reject);
    child.stdin.end(JSON.stringify({operation: 'putIfIdle', socketPath: options.socketPath, ...update}) + '\n');
  });
}

function showsNote(entry, update) {
  if (!entry?.turnId || !entry.item?.id || entry.outputDeferred) return false;
  const item = entry.item;
  if (item.type === 'userMessage') {
    return Array.isArray(item.content) && item.content.length === 1 && item.content[0]?.type === 'text' && item.content[0].text === update.text;
  }
  if (item.type !== 'agentMessage' || (item.phase && item.phase !== 'final_answer')) return false;
  if (item.moderation?.moderated || (item.moderation?.display && item.moderation.display.mode !== 'show')) return false;
  return item.text === update.text;
}

async function readNote(update, request, locator) {
  if (!locator || typeof locator.turnId !== 'string' || !locator.turnId
      || typeof locator.itemId !== 'string' || !locator.itemId) return false;
  const params = {threadId: update.threadId, turnId: locator.turnId, itemIds: [locator.itemId]};
  const {data} = await request('thread/items/read', params);
  return Array.isArray(data) && data.some(row => row?.turnId === locator.turnId && row.item?.id === locator.itemId
    && showsNote(row, update));
}

async function verifyDelivery(update, options, request) {
  const {threadId} = update;
  const {thread} = await request('thread/read', {threadId});
  if (thread?.id !== threadId || thread.historyMode !== 'paginated') return pending('unsupported_thread');
  if (thread.status?.type !== 'idle') return pending('thread_unavailable_or_busy');

  const searchTerm = '[Asterhelm sync ' + update.deliveryId + ']';
  let cursor = null;
  const previous = new Set();
  do {
    const page = await request('thread/searchOccurrences', {threadId, searchTerm, cursor, limit: 16});
    if (!Array.isArray(page?.data)) return pending('unverified_history');
    for (const locator of page.data) {
      if (await readNote(update, request, locator)) return {visible: true};
    }
    cursor = page.nextCursor;
    if (cursor !== null && (typeof cursor !== 'string' || !cursor || previous.has(cursor))) {
      return pending('unverified_history');
    }
    previous.add(cursor);
  } while (cursor);

  const append = options.appendNote ?? (options.noteWriter && path.isAbsolute(options.noteWriter)
    ? item => runWriter(options, item) : null);
  if (!append) return pending('native_note_unsupported');
  const visible = await readNote(update, request, await append(update));
  return visible ? {visible: true} : pending('unverified_history');
}

export async function deliverCodexUpdate(update, options = {}) {
  if (!update || !idPattern.test(update.threadId) || !idPattern.test(update.deliveryId)
      || typeof update.text !== 'string' || !update.text.split('\n').includes('[Asterhelm sync ' + update.deliveryId + ']')) {
    return pending('invalid_update');
  }
  try {
    if (typeof options.request === 'function') return await verifyDelivery(update, options, options.request);
    if (!options.socketPath || !path.isAbsolute(options.socketPath)) return pending('shared_endpoint_unconfigured');
    return await withSharedServer(options, request => verifyDelivery(update, options, request));
  } catch {
    return pending('native_delivery_unconfirmed');
  }
}
