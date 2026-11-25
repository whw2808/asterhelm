// Only the APK serves this module. Android transfers a private port to its top-level page.
const origin = 'https://appassets.androidplatform.net';
if (location.origin !== origin || window !== window.top) throw Error('无法连接本机助手。');
const requests = new Map();
let sequence = 0, channel, openHandler, backHandler, resumeHandler, pendingOpen;
const ready = new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(Error('助手界面连接失败，请重新打开 App。')), 12000);
  function receive(event) {
    if (event.data !== 'asterhelm-android-v1' || event.ports.length !== 1) return;
    window.removeEventListener('message', receive);
    clearTimeout(timeout);
    channel = event.ports[0];
    channel.onmessage = handle;
    resolve(channel);
  }
  window.addEventListener('message', receive);
  fetch('/native-ready', { credentials: 'omit', cache: 'no-store' }).catch(reject);
});

function openMessage(id) {
  if (!openHandler) { pendingOpen = id; return; }
  pendingOpen = undefined;
  Promise.resolve(openHandler(id)).then(() => {
    channel.postMessage(JSON.stringify({ event: 'opened', target: id }));
  }).catch(() => {});
}

function handle(event) {
  const message = JSON.parse(event.data);
  switch (message.event) {
    case 'open': openMessage(message.target); return;
    case 'back':
      channel.postMessage(JSON.stringify({ event: 'back', serial: message.serial, handled: Boolean(backHandler?.()) }));
      return;
    case 'resume': resumeHandler?.(); return;
  }
  const request = requests.get(message.id);
  if (!request) return;
  requests.delete(message.id);
  if (message.error) request.reject(Object.assign(Error(message.error), { status: message.status, code: message.code }));
  else request.resolve(message.value);
}

async function call(op, body = {}, title = '') {
  const port = await ready;
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    requests.set(id, { resolve, reject });
    try { port.postMessage(JSON.stringify({ id, op, body, title })); }
    catch (error) { requests.delete(id); reject(error); }
  });
}

export default {
  call, state: () => call('state'), reminders: () => call('reminders'), settings: () => call('settings'),
  chat(request, title, fromCard = false) {
    if (fromCard) return call('chat', { text: request.text, requestId: request.requestId, cardAction: true });
    return call('chat', request, request.context ? title : '');
  },
  acknowledge: requestId => call('acknowledge', { requestId }),
  draft(text, context) {
    ready.then(port => port.postMessage(JSON.stringify({ event: 'draft', text, context }))).catch(() => {});
  },
  onOpen(fn) { openHandler = fn; if (pendingOpen !== undefined) openMessage(pendingOpen); },
  onBack(fn) { backHandler = fn; },
  onResume(fn) { resumeHandler = fn; },
};
