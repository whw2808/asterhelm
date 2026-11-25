import { Lexer } from './mobile-marked.mjs';
import { ChatBinding, liveWork, mergeWorkHistory, refreshOlderWork } from './mobile-work.mjs';

const native = location.origin === 'https://appassets.androidplatform.net'
  ? (await import('/android-host.js')).default : null;
const $ = id => document.getElementById(id);
const targetNames = new Map();
const names = { queued: '排队中', running: '进行中', succeeded: '已完成', failed: '失败', interrupted: '已中断', cancelled: '已取消',
  observed: '会话中待核实', working: '工作中', idle: '空闲', waiting_for_model_network: '等待模型网络', pending: '待跟进', open: '待跟进', done: '已完成',
  ready: '就绪', completed: '已完成', fired: '已提醒', waiting: '等待中', online: '在线', offline: '离线', never: '尚未同步' };
function notice(text, retry = false) {
  $('notice').textContent = text;
  $('feedback').hidden = !text;
  $('retry').hidden = !retry;
}
const target = id => targetNames.get(id) || id || '';
const state = name => names[name] || name || '';
const detailsOpen = new Set();
let latestBoard, selectedAgent = null, boardScroll = 0, sessionLimit = 6;
const activeTaskStates = new Set(['queued', 'running', 'waiting']);
const dateFormat = new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
function stamp(value) {
  if (!value) return '';
  const dt = new Date(value);
  return Number.isFinite(dt.getTime()) ? dateFormat.format(dt) : '';
}
function node(tag, text, className) {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  if (className) n.className = className;
  return n;
}
let pairing = '';
function stored(key, durable = false) {
  if (!pairing) return null;
  try { return JSON.parse((durable ? localStorage : sessionStorage).getItem(pairing + '/' + key)); } catch { return null; }
}
function store(key, value, durable = false) {
  if (!pairing) return;
  try {
    const storage = durable ? localStorage : sessionStorage;
    const slot = pairing + '/' + key;
    if (value == null) storage.removeItem(slot); else storage.setItem(slot, JSON.stringify(value));
  } catch {}
}
let view = 'loading', timer, clockTimer, refreshVersion = 0, viewVersion = 0, sending = false, pending = false;
let historySignature = '', boardSignature = '', draft = null;
let transcript = [], historyStart = false, loadingEarlier = false, following = true;
let focusedId = '', needsFocus = false, authenticated = false, composing = false;
const historyPageSize = 80;
let binding = new ChatBinding(), changingBinding = false;
function showBinding() {
  const context = binding.current;
  $('attached').hidden = !context;
  $('context-title').textContent = context ? ['接续中', context.title || context.id].join(' · ') : '';
  $('context-title').title = context ? target(context.machine) + ' · ' + context.title : '';
  $('message').placeholder = context ? '继续这项工作…' : '发消息…';
}
function persistBinding(receipt = false) {
  if (native) return native.call('binding', { binding: binding.current, receipt });
  if (!receipt || stored('personal-chat-context', true)?.bindingId === binding.current?.bindingId) {
    store('personal-chat-context', binding.current, true);
  }
}
async function selectSession(session, joinCurrent = false) {
  if (changingBinding) return false;
  const previous = binding;
  const discard = draft && previous.matches(draft) ? draft.text : null;
  binding = new ChatBinding(previous.current);
  binding.select(session, joinCurrent);
  changingBinding = true; updateSend();
  try {
    await persistBinding();
    if (!authenticated) return false;
    if ($('message').value.trim() === discard) $('message').value = '';
    const recovered = binding.recoverLegacy(draft);
    if (recovered && !$('message').value) { draft = recovered; $('message').value = recovered.text; }
    boardSignature = '';
    showBinding(); rememberInput();
    return true;
  } catch (error) {
    binding = previous; fail(error);
    return false;
  } finally {
    changingBinding = false; updateSend();
  }
}
$('detach').onclick = async () => { if (await selectSession(null)) $('message').focus(); };
const codeFormat = /^[A-Za-z0-9_-]{43}$/;
function parseCode(text) {
  const raw = text.trim();
  if (codeFormat.test(raw)) return raw;
  try {
    const link = new URL(raw);
    if (link.origin !== location.origin || link.pathname !== '/') return '';
    const code = new URLSearchParams(link.hash.slice(1)).get('t');
    return codeFormat.test(code || '') ? code : '';
  } catch { return ''; }
}
const invite = !native && parseCode(location.href);
const initialMessage = new URLSearchParams(location.hash.slice(1)).get('message');
if (location.hash) history.replaceState(null, '', location.pathname);
let pairCode = invite;
let packageChecked = false;
function closePanels() {
  $('menu').hidden = $('history-panel').hidden = true;
  $('more').setAttribute('aria-expanded', 'false');
  $('history').setAttribute('aria-expanded', 'false');
}
function changeView(to) {
  ++refreshVersion;
  ++viewVersion;
  clearTimeout(timer);
  clearInterval(clockTimer);
  closePanels();
  view = to;
  notice('');
  $('pairing').hidden = to !== 'pair';
  $('chat').hidden = to !== 'chat';
  $('board').hidden = to !== 'board';
  $('actions').hidden = $('tabs').hidden = !['chat','board'].includes(to);
  $('history').hidden = to !== 'chat';
  for (const tab of ['chat','board']) {
    if (to === tab) $('tab-' + tab).setAttribute('aria-current','page');
    else $('tab-' + tab).removeAttribute('aria-current');
  }
}
async function api(path, body = {}) {
  if (native) return native.call(path, body, path === 'chat' ? binding.current?.title || '' : '');
  let response;
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (pairing && path !== 'pair') headers['X-Asterhelm-Pairing'] = pairing;
    response = await fetch('/api/' + path, {
      method: 'POST', headers,
      credentials: 'same-origin', body: JSON.stringify(body),
    });
  } catch { throw Error('暂时连不上服务器，请检查网络后重试。'); }
  const scope = response.headers.get('X-Asterhelm-Pairing');
  if (scope && pairing && scope !== pairing) {
    location.reload();
    throw Error('配对已切换，正在重新打开对话。');
  }
  if (scope) pairing = scope;
  let data;
  try { data = await response.json(); } catch { throw Error('连接中断，请稍后重试。'); }
  if (!response.ok) throw Object.assign(Error(data.error || '请求未完成，请重试。'), { status: response.status });
  return data.value;
}
function pairOptions() {
  const code = pairCode || parseCode($('pair-input').value);
  $('native').hidden = !code;
  if (code) {
    $('native').href = 'intent://pair?t=' + encodeURIComponent(code) + '#Intent;scheme=asterhelm;package=dev.asterhelm.android;end';
  } else { $('native').removeAttribute('href'); }
  $('pair-web').disabled = !code;
  $('pair-input').hidden = Boolean(pairCode);
  document.querySelector('label[for="pair-input"]').hidden = Boolean(pairCode);
  $('pair-help').textContent = pairCode ? '这份配对邀请限用一次。选择你想使用的入口。' : '在服务器上生成配对邀请，然后将链接或配对码粘贴到这里。';
}
function showPair() {
  authenticated = false;
  changeView(native ? 'loading' : 'pair');
  if ($('source-dialog').open) $('source-dialog').close();
  $('source-path').value = ''; $('record-list').replaceChildren();
  binding = new ChatBinding(); showBinding(); draft = null;
  store('personal-chat-context', null, true); store('personal-chat-pending', null); store('personal-chat-input', null);
  pairing = '';
  $('message').value = ''; updateSend(); resetHistory();
  boardSignature = '';
  detailsOpen.clear(); targetNames.clear(); latestBoard = null; selectedAgent = null; boardScroll = 0;
  focusedId = ''; needsFocus = false; $('latest').hidden = true;
  $('board-content').replaceChildren();
  pairOptions();
  if (!native && !packageChecked) {
    packageChecked = true;
    fetch('/android.apk', { method: 'HEAD' })
      .then(response => { $('android-install').hidden = !response.ok; })
      .catch(() => {});
  }
}
function fail(error) {
  if (error.status === 401) showPair();
  notice(error.message, error.status !== 401 && ['chat','board'].includes(view));
}
$('pair-input').addEventListener('input', pairOptions);
$('pair-form').onsubmit = async event => {
  event.preventDefault();
  const code = pairCode || parseCode($('pair-input').value);
  if (!code) { notice('请粘贴 服务器上生成的完整配对链接或配对码。'); return; }
  $('pair-web').disabled = true;
  try {
    await api('pair', { code });
    pairCode = ''; $('pair-input').value = ''; $('native').removeAttribute('href');
    changeView('chat'); await refresh();
  } catch (error) {
    if (error.status === 401) { pairCode = ''; $('pair-input').value = ''; }
    pairOptions(); notice(error.message);
  }
};
function updateSend() {
  $('send').disabled = !authenticated || sending || changingBinding || !$('message').value.trim();
  const field = $('message');
  field.style.height = 'auto';
  field.style.height = field.scrollHeight + 'px';
}
const entityDecoder = document.createElement('textarea');
function decodeEntities(value) {
  // Only a single character reference ever reaches the detached decoder.
  return value.replace(/&(?:#[0-9]+|#x[\da-f]+|[a-z][a-z\d]*);/gi, entity => {
    entityDecoder.innerHTML = entity;
    return entityDecoder.value;
  });
}
function webLink(href) {
  try {
    const url = new URL(href);
    if ((url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password) return url.href;
  } catch {}
  return null;
}
function sourcePath(href) {
  return /^(?:\/(?![\/\\])|~\/|[a-z]:[\\/])/i.test(href);
}
function openSource(path) {
  $('source-path').value = path; $('copy-status').textContent = '';
  $('source-dialog').showModal();
  $('close-source').focus({ preventScroll: true });
}
$('close-source').onclick = () => $('source-dialog').close();
$('copy-source').onclick = async () => {
  const field = $('source-path');
  try { await navigator.clipboard.writeText(field.value); }
  catch {
    field.focus(); field.select();
    let copied = false;
    try { copied = document.execCommand('copy'); } catch {}
    if (!copied) { $('copy-status').textContent = '已选中路径，可长按复制。'; return; }
  }
  $('copy-status').textContent = '已复制路径。';
};
function markdownTable(token) {
  const wrap = node('div', undefined, 'markdown-table');
  const table = node('table');
  function row(cells, heading) {
    const tr = node('tr');
    for (const cell of cells) {
      const td = node(heading ? 'th' : 'td');
      if (heading) td.scope = 'col';
      if (cell.align === 'right' || cell.align === 'center') td.className = 'align-' + cell.align;
      td.append(markdownTokens(cell.tokens));
      tr.append(td);
    }
    return tr;
  }
  table.createTHead().append(row(token.header, true));
  const body = table.createTBody();
  for (const cells of token.rows) body.append(row(cells, false));
  wrap.append(table);
  return wrap;
}
const markdownTags = { paragraph: 'p', strong: 'strong', em: 'em', del: 'del', blockquote: 'blockquote', list_item: 'li' };
function markdownTokens(tokens) {
  const fragment = document.createDocumentFragment();
  for (const token of tokens) {
    let element;
    switch (token.type) {
      case 'space': case 'def': continue;
      case 'text':
        fragment.append(token.tokens ? markdownTokens(token.tokens) : decodeEntities(token.text));
        continue;
      case 'codespan': fragment.append(node('code', token.text)); continue;
      case 'code':
        element = node('pre');
        element.append(node('code', token.text));
        fragment.append(element);
        continue;
      case 'table': fragment.append(markdownTable(token)); continue;
      case 'br': case 'hr': fragment.append(node(token.type)); continue;
      case 'checkbox': fragment.append(token.checked ? '☑ ' : '☐ '); continue;
      case 'heading': element = node('h' + token.depth); break;
      case 'list':
        element = node(token.ordered ? 'ol' : 'ul');
        if (token.ordered && token.start !== 1) element.start = token.start;
        element.append(markdownTokens(token.items));
        fragment.append(element);
        continue;
      case 'link': {
        const dest = decodeEntities(token.href || '');
        if (/[\u0000-\u001f\u007f]/.test(dest)) { fragment.append(markdownTokens(token.tokens)); continue; }
        if (sourcePath(dest)) {
          element = node('button', undefined, 'source-link');
          element.type = 'button';
          element.append(markdownTokens(token.tokens));
          const line = /:(\d+)(?::\d+)?$/.exec(dest);
          if (line && !element.textContent.endsWith(':' + line[1])) element.append(' · ' + line[1] + ' 行');
          element.onclick = () => openSource(dest);
          fragment.append(element); continue;
        }
        const href = webLink(dest);
        if (!href) { fragment.append(markdownTokens(token.tokens)); continue; }
        element = node('a');
        element.href = href;
        element.target = '_blank';
        element.rel = 'noopener noreferrer';
        break;
      }
      default:
        if (Object.hasOwn(markdownTags, token.type)) element = node(markdownTags[token.type]);
        else { fragment.append(token.text ?? token.raw ?? ''); continue; }
    }
    element.append(markdownTokens(token.tokens || []));
    fragment.append(element);
  }
  return fragment;
}
function markdown(text) {
  const body = node('div', undefined, 'markdown');
  try { body.append(markdownTokens(Lexer.lex(text, { gfm: true, breaks: true }))); }
  catch { body.append(node('p', text)); }
  return body;
}

const workStates = { working: '处理中', synthesizing: '正在汇总', paused: '已暂停', completed: '已完成', partial: '部分完成', cancelled: '已取消' };
function elapsed(ms, precise) {
  ms = Math.max(0, ms);
  if (precise && ms < 1000) return ms + ' 毫秒';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return seconds + ' 秒';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + ' 分 ' + seconds % 60 + ' 秒';
  return Math.floor(minutes / 60) + ' 小时 ' + minutes % 60 + ' 分';
}
function taskElapsed(task) {
  const started = Date.parse(task.startedAt);
  const queued = Date.parse(task.queuedAt);
  const finished = Date.parse(task.finishedAt);
  const executing = Number.isFinite(started);
  const since = executing ? started : queued;
  if (!Number.isFinite(since)) return null;
  let label = executing ? '用时 ' : '排队 ';
  let end = finished;
  const live = !Number.isFinite(end) && (task.state === 'running' || task.state === 'queued');
  if (live) end = Date.now();
  else if (!Number.isFinite(end) && task.state === 'offline') {
    end = Date.parse(task.lastHeartbeatAt);
    label = '截至最后心跳 ';
  }
  if (!Number.isFinite(end)) return null;
  const item = node('span', label + elapsed(end - since, !live), 'work-elapsed');
  if (live) {
    item.dataset.since = since;
    item.dataset.label = label;
  }
  return item;
}
function refreshClocks() {
  clearInterval(clockTimer);
  if (view !== 'chat' || document.hidden) return;
  const clocks = $('messages').querySelectorAll('.work-elapsed[data-since]');
  if (!clocks.length) return;
  function tick() {
    const now = Date.now();
    for (const clock of clocks) {
      const text = clock.dataset.label + elapsed(now - Number(clock.dataset.since), false);
      if (clock.textContent !== text) clock.textContent = text;
    }
  }
  tick();
  clockTimer = setInterval(tick, 1000);
}
const terminalWorkStates = new Set(['succeeded', 'failed', 'interrupted', 'cancelled']);
const detailLoads = new WeakMap();
async function loadWorkDetail(disclosure) {
  if (!disclosure.open || disclosure.dataset.final) return;
  const rowState = disclosure.parentElement.dataset.state;
  if (detailLoads.get(disclosure)?.state === rowState) return;
  const request = { state: rowState };
  detailLoads.set(disclosure, request);
  const status = disclosure.querySelector('.work-detail-status');
  const result = disclosure.querySelector('.work-detail-result');
  status.textContent = '正在读取任务详情…';
  try {
    const detail = await api('get', { id: disclosure.dataset.taskId });
    if (!disclosure.isConnected || detailLoads.get(disclosure) !== request) return;
    const currentState = rowState === 'offline' && detail.state === 'running' ? rowState : detail.state;
    const terminal = terminalWorkStates.has(currentState);
    if (currentState === 'cancelled') {
      status.textContent = detail.workerState ? '执行端回执 · ' + state(detail.workerState) : '队列状态 · 已取消';
    } else status.textContent = '任务状态 · ' + state(currentState);
    if (detail.result) result.replaceChildren(markdown(detail.result));
    else result.replaceChildren(node('p', terminal ? '执行端未返回正文。' : '等待执行端返回结果。', 'work-detail-empty'));
    if (terminal) disclosure.dataset.final = 'true';
  } catch (error) {
    if (!disclosure.isConnected || detailLoads.get(disclosure) !== request) return;
    if (error.status === 401) { fail(error); return; }
    status.textContent = error.message;
    const retry = node('button', '重试', 'quiet');
    retry.type = 'button';
    retry.onclick = () => loadWorkDetail(disclosure);
    result.replaceChildren(retry);
  } finally {
    if (detailLoads.get(disclosure) === request) detailLoads.delete(disclosure);
  }
}
function workDisclosure(task) {
  const disclosure = node('details', undefined, 'work-disclosure');
  disclosure.dataset.taskId = task.taskId;
  const summary = node('summary');
  summary.setAttribute('aria-label', '查看任务详情 · ' + task.title);
  const status = node('p', '', 'work-detail-status');
  status.setAttribute('role', 'status');
  disclosure.append(summary, status, node('div', undefined, 'work-detail-result'));
  disclosure.ontoggle = () => loadWorkDetail(disclosure);
  return disclosure;
}
function workSummary(task) {
  const body = node('div', undefined, 'work-summary');
  const main = node('div', undefined, 'work-main');
  const symbol = node('span', undefined, 'work-symbol');
  symbol.append(icon(task.kind === 'consult' ? 'lookup' : 'work'));
  const info = node('div');
  const identity = node('div', undefined, 'work-identity');
  let stage = state(task.state);
  if (task.state === 'queued' && !task.queuedAt) stage = '待提交';
  if (task.state === 'cancelled' && task.taskId) stage = '队列已取消';
  identity.append(node('strong', task.kind === 'consult' ? '只读查证' : '执行任务'), node('span', stage, 'work-stage'));
  const meta = node('div', undefined, 'work-meta');
  meta.append(node('span', [task.deviceName, task.agentName].filter(Boolean).join(' · ')));
  meta.append(taskElapsed(task) || node('span', task.state === 'queued' && !task.queuedAt ? '尚未开始' : '用时未记录', 'work-elapsed'));
  info.append(identity, meta);
  main.append(symbol, info);
  const title = node('div', undefined, 'work-title');
  title.append(node('span', task.scope === 'paused' ? '范围已暂停' : '当前范围', 'work-scope'), document.createTextNode(' ' + (task.title || '')));
  body.append(main, title);
  if (task.progress && task.progress !== stage) body.append(node('div', task.progress, 'work-progress'));
  return body;
}
const iconPaths = {
  lookup: 'M14 20H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2v6M7 8h9M7 11h5 M20.5 16.5a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM19.6 19.6l3 3',
  work: 'M3 8h18v12H3zM8 8V5h8v3M3 13q9 5 18 0M10 13h4',
  device: 'M3 5.5h18v13H3zM9 21h6M12 18.5V21M6 9h12',
};
function icon(kind) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(svg.namespaceURI, 'path');
  for (const [key, value] of Object.entries({ d: iconPaths[kind], fill: 'none', stroke: 'currentColor', 'stroke-width': 1.55, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) path.setAttribute(key, value);
  svg.append(path);
  return svg;
}
function avatar() {
  const mark = node('span', undefined, 'assistant-avatar');
  mark.setAttribute('aria-hidden','true');
  return mark;
}
function workSentence(work) {
  const tasks = work.tasks || [];
  const devices = [...new Set(tasks.map(task => task.deviceName).filter(Boolean))].join('、');
  if (work.state === 'synthesizing') return '正在汇总执行结果。';
  if (work.state === 'partial') return '部分工作已完成。';
  if (work.state === 'cancelled') return '这项工作已取消。';
  if (work.state === 'completed') return '这项工作已完成。';
  if (!devices || !tasks.some(t => t.taskId)) return '正在安排这项工作。';
  if (tasks.every(task => task.kind === 'consult')) return '我请 ' + devices + ' 查一下相关记录。';
  return '我把这项工作交给了 ' + devices + '。';
}
function workPanel(work, panel) {
  if (!panel) {
    panel = node('section', undefined, 'work-panel');
    panel.dataset.work = work.id;
    panel.setAttribute('aria-label', '任务进度');
    const heading = node('div', undefined, 'work-heading');
    const summary = node('div', undefined, 'work-overview');
    summary.append(node('span', '', 'work-revision'), node('strong'), node('span', '', 'work-state'));
    heading.append(avatar(), summary);
    panel.append(heading, node('ul', undefined, 'work-list'));
  }
  const revised = work.revision > 0;
  const revision = panel.querySelector('.work-revision');
  revision.hidden = !revised;
  revision.textContent = revised ? '当前目标 · 第 ' + work.revision + ' 次调整' : '';
  panel.querySelector('.work-heading strong').textContent = revised && work.goal ? work.goal : workSentence(work);
  const status = panel.querySelector('.work-state');
  status.textContent = workStates[work.state] || state(work.state);
  status.classList.toggle('sr', !revised);
  const tasks = panel.querySelector('.work-list');
  const remaining = new Map(Array.from(tasks.children, card => [card.dataset.step, card]));
  for (const [index, task] of (work.tasks || []).entries()) {
    const card = remaining.get(task.id) || node('li', undefined, 'work-card');
    remaining.delete(task.id);
    const previousState = card.dataset.state;
    card.dataset.step = task.id;
    card.dataset.state = task.state;
    card.dataset.scope = task.scope || 'active';
    let disclosure = card.querySelector('details');
    if (disclosure && disclosure.dataset.taskId !== task.taskId) { disclosure.remove(); disclosure = null; }
    if (task.taskId && !disclosure) { disclosure = workDisclosure(task); card.replaceChildren(disclosure); }
    else if (disclosure?.open && previousState !== task.state) loadWorkDetail(disclosure);
    const content = disclosure ? disclosure.querySelector('summary') : card;
    content.replaceChildren(workSummary(task));
    const at = tasks.children[index] || null;
    if (card !== at) tasks.insertBefore(card, at);
  }
  for (const card of remaining.values()) card.remove();
  return panel;
}
function historyMessage(item) {
  const isUser = item.role === 'user';
  const message = node('article', undefined, 'message' + (isUser ? ' user' : ''));
  message.dataset.id = item.id;
  const speaker = isUser ? '你' : item.provenance ? '桌面 · ' + target(item.provenance.machine) : '个人助手';
  message.setAttribute('aria-label', [speaker, stamp(item.createdAt)].filter(Boolean).join(' · '));
  if (isUser) {
    message.append(node('p', item.text, 'user-bubble'));
    if (item.continuity?.delivery === 'pending' || item.continuity?.delivery === 'delivered') {
      message.append(node('p', item.continuity.delivery === 'pending' ? '桌面待送达' : '已送达桌面', 'work-receipt'));
    }
  } else {
    const row = node('div', undefined, 'reply-row');
    const bubble = markdown(item.text);
    bubble.classList.add('reply-bubble');
    row.append(avatar(), bubble);
    message.append(row);
  }
  return message;
}
const shortTime = new Intl.DateTimeFormat('zh-CN',{hour: '2-digit', minute:'2-digit', hour12: false});
function updateDate(message, item, previousItem) {
  let separator = message.querySelector(':scope > .date-separator');
  const then = new Date(item.createdAt), last = new Date(previousItem?.createdAt);
  if (!Number.isFinite(then.getTime()) || (then.toDateString() === last.toDateString() && then - last < 20 * 60000)) {
    separator?.remove(); return;
  }
  if (!separator) { separator = node('time', undefined, 'date-separator'); message.prepend(separator); }
  separator.dateTime = item.createdAt;
  separator.textContent = then.toDateString() === new Date().toDateString() ? '今天 ' + shortTime.format(then) : stamp(item.createdAt);
}
function readingAnchor(scroller) {
  const bounds = scroller.getBoundingClientRect();
  const element = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
  if (!element?.closest('#messages .message')) return null;
  return { element, top: element.getBoundingClientRect().top };
}
function renderHistory(value, prepend = false) {
  const scroll = $('conversation');
  const nearBottom = !focusedId && (!historySignature || scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight <= 40);
  const anchor = !prepend && !nearBottom ? readingAnchor(scroll) : null;
  const page = value.messages || [];
  if (!transcript.length || prepend) historyStart = page.length < historyPageSize;
  const previous = new Map(transcript.map(message => [message.id, message]));
  transcript = mergeWorkHistory(transcript, page);
  const list = transcript;
  $('earlier').hidden = historyStart || !list[0]?.seq;
  const signature = JSON.stringify(list);
  const wasPending = pending;
  pending = Boolean(value.pending);
  const changed = signature !== historySignature;
  if (changed) {
    const container = $('messages');
    const existing = new Map(Array.from(container.children, item => [item.dataset.id, item]));
    const panels = new Map(Array.from(container.querySelectorAll('.work-panel'), panel => [panel.dataset.work, panel]));
    list.forEach((item, index) => {
      let message = existing.get(String(item.id));
      const old = previous.get(item.id);
      if (!message || JSON.stringify(old) !== JSON.stringify(item)) {
        if (!message || old?.text !== item.text || old.role !== item.role || old.createdAt !== item.createdAt ||
            old.provenance?.machine !== item.provenance?.machine || old.continuity?.delivery !== item.continuity?.delivery) {
          const next = historyMessage(item);
          message?.replaceWith(next);
          message = next;
        }
        if (item.work) {
          const panel = workPanel(item.work, panels.get(item.work.id));
          if (panel.parentElement !== message) message.append(panel);
        } else message.querySelector('.work-panel')?.remove();
      }
      const position = container.children[index] || null;
      if (position !== message) container.insertBefore(message, position);
      updateDate(message, item, list[index - 1]);
    });
    historySignature = signature;
  }
  const accepted = draft && list.find(item => item.requestId === draft.requestId);
  if (accepted) {
    acceptDraft(draft, accepted.continuity?.workId);
  }
  $('welcome').hidden = list.length > 0 || pending;
  $('thinking').hidden = Number(value.pending || 0) <= list.filter(item => liveWork(item.work)).length;
  refreshClocks();
  if (!prepend && nearBottom && (changed || wasPending !== pending)) scroll.scrollTop = scroll.scrollHeight;
  else if (anchor?.element.isConnected) scroll.scrollTop += anchor.element.getBoundingClientRect().top - anchor.top;
}
async function loadEarlier() {
  if (loadingEarlier || !transcript[0]?.seq) return;
  loadingEarlier = true; $('earlier').disabled = true;
  const currentView = viewVersion;
  try {
    const data = await api('history', { before: transcript[0].seq, limit: historyPageSize });
    if (view !== 'chat' || viewVersion !== currentView) return;
    const scroll = $('conversation');
    const beforeHeight = scroll.scrollHeight;
    const beforeTop = scroll.scrollTop;
    renderHistory(data, true);
    scroll.scrollTop = beforeTop + scroll.scrollHeight - beforeHeight;
  } catch (error) { if (viewVersion === currentView) fail(error); }
  finally { loadingEarlier = false; $('earlier').disabled = false; }
}
$('earlier').onclick = loadEarlier;
function line(text, meta) {
  const li = node('li');
  li.append(node('span', text, 'row-text'));
  if (meta) li.append(node('span', meta, 'row-meta'));
  return li;
}
function group(label, data, formatter, { empty, collapsible = false, total = data.length } = {}) {
  const section = node(collapsible ? 'details' : 'section', undefined, 'group');
  section.append(node(collapsible ? 'summary' : 'h3', label + (total ? ' · ' + total : '')));
  if (collapsible) {
    const key = JSON.stringify([selectedAgent, label]);
    section.open = detailsOpen.has(key);
    section.ontoggle = () => { if (section.isConnected) section.open ? detailsOpen.add(key) : detailsOpen.delete(key); };
  }
  if (!data.length) { section.append(node('p', empty || '暂无记录', 'empty')); return section; }
  const ul = node('ul', undefined, 'group-list');
  ul.append(...data.map(formatter)); section.append(ul);
  return section;
}
function taskLine(task) {
  const li = node('li');
  const button = node('button', task.title || '查看任务', 'task-link');
  button.type = 'button';
  li.append(button, node('span', [state(task.state), target(task.target)].filter(Boolean).join(' · '), 'row-meta'));
  let panel;
  button.onclick = async () => {
    if (panel) { panel.remove(); panel = null; button.setAttribute('aria-expanded', 'false'); return; }
    button.disabled = true;
    try {
      const detail = await api('get', { id: task.id });
      panel = node('div', undefined, 'task-result');
      panel.append(node('p', detail.prompt || task.title), node('p', detail.result || state(detail.state)));
      if (['queued', 'running'].includes(detail.state) && !detail.cancelRequested) {
        const stop = node('button', '停止任务');
        stop.onclick = async () => {
          stop.disabled = true;
          try { await api('cancel', { id: task.id }); await refresh(); }
          catch (error) { fail(error); stop.disabled = false; }
        };
        panel.append(stop);
      }
      li.append(panel); button.setAttribute('aria-expanded', 'true');
    } catch (error) { fail(error); } finally { button.disabled = false; }
  };
  button.setAttribute('aria-expanded', 'false');
  return li;
}
function sessionLine(session) {
  const li = node('li');
  const detail = node('details', undefined, 'session');
  const id = session.machine + '/' + session.id;
  detail.open = detailsOpen.has(id);
  detail.ontoggle = () => { if (detail.isConnected) detail.open ? detailsOpen.add(id) : detailsOpen.delete(id); };
  detail.append(node('summary', session.title || '未命名会话'));
  detail.append(node('span', [target(session.machine), session.source, stamp(session.updatedAt), session.visibility === 'metadata-only' ? '仅会话信息' : ''].filter(Boolean).join(' · '), 'row-meta'));
  if (session.summary) detail.append(node('p', session.summary, 'row-text'));
  function action(label, joinCurrent) {
    const button = node('button', label, 'resume-session');
    button.type = 'button';
    button.onclick = async () => {
      if (!await selectSession(session, joinCurrent)) return;
      openLatest();
      $('message').focus({ preventScroll: true });
    };
    detail.append(button);
  }
  action('接着聊', false);
  if (binding.current?.workId && (binding.current.machine !== session.machine || binding.current.id !== session.id)) {
    action('加入当前工作', true);
  }
  li.append(detail);
  return li;
}
const logoPaths = { codex: '/agent-codex.png', deepseek: '/agent-deepseek.png' };
function agentLogo(agent) {
  const mark = node('span', undefined, 'agent-mark');
  mark.setAttribute('aria-hidden', 'true');
  if (Object.hasOwn(logoPaths, agent.kind)) {
    const image = node('img');
    image.alt = '';
    image.src = logoPaths[agent.kind];
    image.onerror = () => mark.replaceChildren((agent.name || '?').slice(0, 1));
    mark.append(image);
  } else { mark.textContent = (agent.name || '?').slice(0, 1); }
  return mark;
}
function availability(worker) {
  if (!worker) return ['未接入', 'muted'];
  if (!worker.online) return ['离线', 'muted'];
  if (worker.needsCredentials) return ['等待登录', 'waiting'];
  if (worker.status === 'waiting_for_model_network') return ['等待网络', 'waiting'];
  if (worker.status === 'working') return ['工作中', 'busy'];
  return [state(worker.status) || '在线', 'available'];
}
function statusBadge(label, tone) {
  return node('span', label, 'status-badge ' + tone);
}
function agentCard(agent, machine) {
  const card = node('button', undefined, 'agent-card');
  card.type = 'button';
  card.dataset.agent = agent.id;
  const [status, tone] = availability(agent.worker);
  const tasks = agent.tasks || [], sessions = agent.sessions || [];
  const indexed = agent.sessionsIndexed !== false;
  const description = node('span', undefined, 'agent-description');
  description.append(node('strong', agent.name, 'agent-name'), statusBadge(status, tone));
  const arrow = node('span', '›', 'card-arrow');
  arrow.setAttribute('aria-hidden', 'true');
  card.append(agentLogo(agent), description, arrow);
  card.setAttribute('aria-label', [machine.name, agent.name, status, tasks.length + ' 个任务', indexed ? sessions.length + ' 个会话' : '会话未接入'].join('，'));
  card.onclick = () => {
    boardScroll = $('board').scrollTop; sessionLimit = 6;
    selectedAgent = { machine: machine.id, agent: agent.id };
    renderBoard(latestBoard);
    $('board').scrollTop = 0;
    $('board-title').focus({ preventScroll: true });
  };
  return card;
}
function machineColumn(machine) {
  const column = node('section', undefined, 'machine-column');
  column.dataset.machine = machine.id;
  const heading = node('div', undefined, 'machine-heading');
  const subtitle = node('div', undefined, 'machine-subtitle');
  subtitle.append(node('span', machine.platform || '', 'platform'), statusBadge(machine.online ? '在线' : '离线', machine.online ? 'available' : 'muted'));
  heading.append(node('h3', machine.name), subtitle);
  const art = node('div', undefined, 'machine-art');
  art.setAttribute('aria-hidden', 'true');
  const neutral = () => {
    const glyph = icon('device');
    glyph.classList.add('device-generic');
    art.replaceChildren(glyph);
  };
  if (['desktop','laptop'].includes(machine.formFactor)) {
    const image = node('img');
    image.alt = '';
    image.className = 'device-' + machine.formFactor;
    image.onerror = neutral;
    image.src = '/device-' + machine.formFactor + '.webp';
    art.append(image);
  } else neutral();
  column.append(art, heading);
  const agents = machine.agents || [];
  if (!agents.length) column.append(node('p', '暂无 Agent', 'empty'));
  else column.append(...agents.map(agent => agentCard(agent, machine)));
  return column;
}
function agentDetails(machine, agent) {
  const summary = node('div', undefined, 'agent-detail-heading');
  const tasks = agent.tasks || [];
  const active = tasks.filter(t => activeTaskStates.has(t.state));
  const finished = tasks.filter(t => !activeTaskStates.has(t.state));
  const sessions = agent.sessions || [];
  summary.append(agentLogo(agent), node('span', [machine.name, machine.platform].filter(Boolean).join(' · ')), statusBadge(...availability(agent.worker)),
    node('span', tasks.length + ' 个任务 · ' + (agent.sessionsIndexed === false ? '会话未接入' : sessions.length + ' 个会话'), 'agent-metrics'));
  const sessionGroup = group('最近工作会话', sessions.slice(0, sessionLimit), sessionLine, {
    total: sessions.length, empty: agent.sessionsIndexed === false ? '这个 Agent 的会话尚未接入。' : '暂无会话。',
  });
  if (sessions.length > sessionLimit) {
    const more = node('button', '更多会话', 'more-sessions');
    more.type = 'button';
    more.onclick = () => {
      const offset = sessionLimit;
      sessionLimit += 12;
      renderBoard(latestBoard);
      document.querySelectorAll('.session summary')[offset]?.focus();
    };
    sessionGroup.append(more);
  }
  const content = [
    summary,
    group('进行中的任务', active, taskLine, { empty: '目前没有进行中的任务。' }),
    sessionGroup,
  ];
  if (finished.length) content.push(group('已结束的任务', finished, taskLine, { collapsible: true }));
  return content;
}
function boardOverview(value) {
  const grid = node('div', undefined, 'machine-grid');
  grid.append(...(value.machines || []).map(machineColumn));
  if (!grid.children.length) grid.append(node('p', '暂无已接入的机器。', 'empty'));
  const sections = [grid];
  const more = { collapsible: true };
  if (value.unassignedTasks?.length) sections.push(group('未归属 Agent 的任务', value.unassignedTasks, taskLine, more));
  if (value.unassignedSessions?.length) sections.push(group('未归属 Agent 的会话', value.unassignedSessions, sessionLine, more));
  sections.push(group('待跟进', value.commitments || [], x => line(x.text, [state(x.status), target(x.machine), stamp(x.dueAt)].filter(Boolean).join(' · ')), { ...more, empty: '目前没有待跟进的承诺。' }));
  if (value.watches?.length) sections.push(group('关注中的变化', value.watches, x => line(x.text, target(x.machine)), more));
  if (value.preferences?.length) sections.push(group('记住的偏好', value.preferences, x => line(x.text, x.scope), more));
  if (value.coverage?.length) sections.push(group('同步情况', value.coverage, x => line(
    [target(x.machine), x.source].filter(Boolean).join(' · '),
    [state(x.status), x.lastSyncAt ? '最近同步 ' + stamp(x.lastSyncAt) : '', '可见 ' + (x.count ?? 0) + ' 个会话',
      x.metadataOnly ? x.metadataOnly + ' 个仅有会话信息' : ''].filter(Boolean).join(' · ')
  ), more));
  return sections;
}
function renderBoard(value) {
  targetNames.clear();
  for (const machine of value.machines || []) {
    targetNames.set(machine.id, machine.name);
    for (const agent of machine.agents) targetNames.set(agent.id, machine.name + ' · ' + agent.name);
  }
  latestBoard = value;
  const machine = selectedAgent && value.machines?.find(m => m.id === selectedAgent.machine);
  const agent = machine?.agents.find(a => a.id === selectedAgent.agent);
  if (!agent) selectedAgent = null;
  const signature = JSON.stringify(agent ? [selectedAgent, sessionLimit, machine.name, machine.platform, agent] : value);
  if (boardSignature === signature) return;
  boardSignature = signature;
  $('back-board').hidden = !agent;
  $('board-title').textContent = agent?.name || '看板';
  $('board-content').replaceChildren(...(agent ? agentDetails(machine, agent) : boardOverview(value)));
}
$('back-board').onclick = () => {
  const previous = selectedAgent;
  selectedAgent = null;
  renderBoard(latestBoard);
  $('board').scrollTop = boardScroll;
  const card = Array.from(document.querySelectorAll('.agent-card')).find(c =>
    c.dataset.agent === previous?.agent && c.closest('.machine-column').dataset.machine === previous.machine);
  card?.focus({ preventScroll: true });
};
async function chatHistory(version) {
  const page = await api('history', focusedId ? { around: focusedId, limit: historyPageSize } : {});
  await refreshOlderWork(page, transcript, id => api('history', { around: id, limit: 9 }), () => version === refreshVersion);
  return page;
}
function resetHistory() {
  historySignature = ''; transcript = []; historyStart = false; pending = false;
  $('messages').replaceChildren();
  $('earlier').hidden = $('thinking').hidden = $('welcome').hidden = true;
  following = true;
}
function rememberInput() {
  if (!authenticated) return;
  if (native) native.draft($('message').value, binding.current);
  else store('personal-chat-input', { text: $('message').value, bindingId: binding.current?.bindingId });
}
async function restoreInput() {
  if (authenticated) return;
  const snapshot = native ? await native.state() : null;
  if (authenticated || !['chat','board'].includes(view)) return;
  if (native && !snapshot?.paired) throw Object.assign(Error('请重新连接设备。'), { status: 401 });
  draft = native ? snapshot.pending : stored('personal-chat-pending');
  binding = new ChatBinding(native ? snapshot.binding : stored('personal-chat-context', true));
  const typed = native
    ? { text: snapshot.typedDraft, bindingId: snapshot.typedContext?.bindingId, context: snapshot.typedContext }
    : stored('personal-chat-input');
  draft = binding.recoverLegacy(draft) || draft;
  $('message').value = binding.restoreText(typed, draft);
  showBinding();
  authenticated = true;
  rememberInput();
  updateSend();
}
function showHighlighted(id) {
  const item = [...$('messages').children].find(row => row.dataset.id === id);
  if (!item) return false;
  $('messages').querySelector('.highlight')?.classList.remove('highlight');
  item.classList.add('highlight');
  const scroller = $('conversation');
  scroller.scrollTop += item.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 9;
  following = false;
  return true;
}
function openLatest() {
  const leavingWindow = Boolean(focusedId);
  focusedId = ''; needsFocus = false;
  if (leavingWindow) resetHistory();
  changeView('chat'); $('latest').hidden = true;
  following = true;
  $('conversation').scrollTop = $('conversation').scrollHeight;
  return refresh();
}
function openMessage(id) {
  if (typeof id !== 'string' || !id || id.length > 512) return openLatest();
  changeView('chat');
  resetHistory(); focusedId = id; needsFocus = true;
  $('latest').hidden = false;
  return refresh();
}
async function refresh() {
  if (!['chat','board'].includes(view) || document.hidden) return;
  const version = ++refreshVersion;
  clearTimeout(timer);
  let retrySoon = false;
  const initialLoad = view === 'chat' ? !historySignature : !boardSignature;
  if (initialLoad) notice(view === 'chat' ? '正在读取对话…' : '正在读取看板…');
  try {
    if (native && !authenticated) await restoreInput();
    if (version !== refreshVersion) return;
    const data = view === 'chat' ? await chatHistory(version) : await api('board', { layout: 'machines' });
    if (version !== refreshVersion) return;
    await restoreInput();
    if (version !== refreshVersion) return;
    if (initialLoad || !$('retry').hidden) notice('');
    if (view === 'chat') {
      renderHistory(data);
      if (needsFocus) {
        needsFocus = false;
        if (!showHighlighted(focusedId)) {
          focusedId = ''; $('latest').hidden = true;
          following = true; $('conversation').scrollTop = $('conversation').scrollHeight;
          notice('未找到这条消息，已打开最新对话。');
        }
      }
      if (!$('history-panel').hidden) drawRecords();
    } else renderBoard(data);
  } catch (error) {
    retrySoon = true;
    if (version === refreshVersion) fail(error);
  } finally {
    if (version === refreshVersion && !document.hidden) {
      timer = setTimeout(refresh, retrySoon ? 12000 : view === 'chat' ? (pending ? 2200 : 15000) : 30000);
    }
  }
}
function drawRecords() {
  const records = transcript.filter(item => item.role === 'user').reverse();
  const rows = records.map(item => {
    const entry = node('button');
    entry.type = 'button';
    entry.append(node('span', item.text, 'record-title'), node('time', stamp(item.createdAt)));
    entry.onclick = () => {
      closePanels();
      showHighlighted(item.id);
      $('history').focus({ preventScroll: true });
    };
    return entry;
  });
  $('record-list').replaceChildren(...(rows.length ? rows : [node('p', '暂无对话记录', 'empty')]));
  $('record-earlier').hidden = $('earlier').hidden;
}
$('history').onclick = () => {
  const opening = $('history-panel').hidden;
  closePanels(); if (!opening) return;
  drawRecords();
  $('history-panel').hidden = false; $('history').setAttribute('aria-expanded','true');
};
$('record-earlier').onclick = async () => {
  $('record-earlier').disabled = true;
  await loadEarlier(); drawRecords();
  $('record-earlier').disabled = false;
};
async function reminderState() {
  if (!native || !authenticated) return;
  try {
    const info = await native.state();
    $('reminders').textContent = info.reminders && info.permitted ? '关闭后台提醒' : '开启后台提醒';
  } catch (error) { fail(error); }
}
$('more').onclick = () => {
  const opening = $('menu').hidden;
  closePanels(); if (!opening) return;
  $('menu').hidden = false; $('more').setAttribute('aria-expanded','true');
  if (native) reminderState();
};
document.addEventListener('click', event => {
  if (!event.target.closest('#menu,#history-panel,#more,#history')) closePanels();
});
function back() {
  if ($('source-dialog').open) { $('source-dialog').close(); return true; }
  if (!$('menu').hidden || !$('history-panel').hidden) { closePanels(); return true; }
  if (view === 'board' && selectedAgent) { $('back-board').click(); return true; }
  if (view === 'board') { changeView('chat'); refresh(); return true; }
  if (view === 'chat' && focusedId) { openLatest(); return true; }
  return false;
}
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !composing && back()) event.preventDefault();
});
$('tab-board').onclick = () => {
  if (view === 'board') { if (selectedAgent) $('back-board').click(); return; }
  $('message').blur(); changeView('board'); refresh();
};
$('tab-chat').onclick = () => {
  if (view === 'chat') return openLatest();
  changeView('chat'); refresh();
};
$('latest').onclick = openLatest;
$('refresh').onclick = $('retry').onclick = () => { closePanels(); notice(''); refresh(); };
$('message').oninput = () => { rememberInput(); updateSend(); };
$('message').addEventListener('compositionstart', () => { composing = true; });
$('message').addEventListener('compositionend', () => { composing = false; rememberInput(); updateSend(); });
$('message').onkeydown = event => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing && !composing && event.keyCode !== 229) {
    event.preventDefault(); if (!$('send').disabled) $('composer').requestSubmit();
  }
};
$('conversation').addEventListener('scroll', () => {
  if (view !== 'chat') return;
  const scroll = $('conversation');
  following = scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop <= 40;
}, { passive: true });
const viewport = window.visualViewport;
function resizeLayout() {
  // WebViews resize their layout viewport. Safari also reports a smaller visual viewport for the IME.
  const editing = document.activeElement === $('message');
  const needsInset = editing && viewport && Math.abs(viewport.scale - 1) < .01 && viewport.height + 2 < document.documentElement.clientHeight;
  document.querySelector('.shell').style.height = needsInset ? Math.round(viewport.height) + 'px' : '';
  if (editing && following && !focusedId) $('conversation').scrollTop = $('conversation').scrollHeight;
}
viewport?.addEventListener('resize', resizeLayout);
window.addEventListener('resize', resizeLayout);
resizeLayout();
$('suggestions').onclick = event => {
  if (event.target.tagName !== 'BUTTON' || !authenticated) return;
  $('message').value = event.target.textContent; updateSend(); $('composer').requestSubmit();
};
function acceptDraft(request, workId) {
  if (draft !== request) return;
  if (binding.matches(request) && $('message').value.trim() === request.text) $('message').value = '';
  let saved;
  if (binding.accept(request, workId)) {
    saved = persistBinding(true);
    boardSignature = '';
    if (view === 'board' && latestBoard) renderBoard(latestBoard);
  }
  if (native) Promise.resolve(saved).then(() => native.acknowledge(request.requestId)).catch(fail);
  store('personal-chat-pending', null); draft = null; rememberInput(); updateSend();
}
$('composer').onsubmit = async event => {
  event.preventDefault();
  const text = $('message').value.trim();
  if (!authenticated || !text || sending || changingBinding || composing) return;
  const request = binding.request(text, draft);
  draft = request;
  if (!native) store('personal-chat-pending', request);
  sending = true; updateSend(); notice('');
  try {
    const { bindingId, ...payload } = request;
    const result = await api('chat', native ? request : payload);
    acceptDraft(request, result?.workId);
    if (view === 'chat' && focusedId) await openLatest();
    else {
      if (view === 'chat') { following = true; $('conversation').scrollTop = $('conversation').scrollHeight; }
      await refresh();
    }
  } catch (error) { fail(error); } finally { sending = false; updateSend(); }
};
$('logout').onclick = async () => {
  closePanels();
  try { await api('logout'); showPair(); }
  catch (error) { if (error.code !== 'cancelled') fail(error); }
};
if (native) {
  $('reminders').hidden = $('system-settings').hidden = false;
  $('logout').textContent = '解除手机配对';
  $('reminders').onclick = async () => {
    closePanels();
    try { await native.reminders(); await reminderState(); }
    catch (error) { if (error.code !== 'cancelled') fail(error); }
  };
  $('system-settings').onclick = async () => {
    closePanels();
    try { await native.settings(); } catch (error) { fail(error); }
  };
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { clearTimeout(timer); clearInterval(clockTimer); }
  else { refreshClocks(); refresh(); }
});
window.addEventListener('online', refresh);
window.addEventListener('offline', () => { if (authenticated) notice('网络已断开，重新连接后会刷新。', true); });
window.addEventListener('hashchange', () => {
  const id = new URLSearchParams(location.hash.slice(1)).get('message');
  if (id && ['chat','board'].includes(view)) { history.replaceState(null, '', location.pathname); openMessage(id); }
});
if (invite) showPair();
else if (initialMessage) openMessage(initialMessage);
else { changeView('chat'); refresh(); }
if (native) {
  native.onOpen(id => openMessage(id));
  native.onBack(back);
  native.onResume(() => { refreshClocks(); refresh(); if (!$('menu').hidden) reminderState(); });
}
