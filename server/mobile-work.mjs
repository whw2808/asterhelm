// A binding belongs to an explicit selection. Its identity also guards late send receipts.
export class ChatBinding {
  constructor(saved = null) {
    this.current = saved?.machine && saved.id && saved.bindingId ? saved : null;
  }

  select(session, joinCurrent = false) {
    const workId = joinCurrent ? this.current?.workId : undefined;
    this.current = session ? {
      machine: session.machine, id: session.id, title: session.title || session.id,
      bindingId: crypto.randomUUID(), ...(workId ? { workId } : {}),
    } : null;
  }

  matches(request) {
    if (!this.current) return !request?.context && !request?.bindingId;
    return request?.bindingId === this.current.bindingId &&
      request.context?.machine === this.current.machine && request.context?.id === this.current.id;
  }

  restoreText(typed, pending) {
    if (typeof typed?.text === 'string' && typed.bindingId === this.current?.bindingId &&
        !(typed.context && !typed.bindingId)) return typed.text;
    return this.matches(pending) ? pending?.text || '' : '';
  }

  recoverLegacy(pending) {
    if (!this.current || this.current.workId || !pending?.requestId || pending.bindingId || pending.workId ||
        pending.context?.machine !== this.current.machine || pending.context?.id !== this.current.id) return null;
    return { ...pending, bindingId: this.current.bindingId };
  }

  request(text, pending) {
    if (pending?.text === text && this.matches(pending)) return pending;
    const request = { text, requestId: crypto.randomUUID() };
    if (this.current) {
      const { machine, id, workId, bindingId } = this.current;
      Object.assign(request, { context: { machine, id }, bindingId });
      if (workId) request.workId = workId;
    }
    return request;
  }

  accept(request, workId) {
    if (!this.current || !this.matches(request) || !workId || this.current.workId === workId) return false;
    this.current = { ...this.current, workId };
    return true;
  }
}

const decisionLabels = { approve: '同意立项', ignore: '忽略此项', recheck: '再查一次，暂不立项',
  pause: '暂停', resume: '恢复', cancel: '取消' };
const cardId = /^[A-Za-z0-9:_-]{1,160}$/;
const controlText = /^星舵操作 ([A-Za-z0-9:_-]{1,160}) v([1-9]\d{0,8}) (approve|ignore|recheck|pause|resume|cancel)$/;

export function cardCommand(card, decision) {
  if (typeof card.id !== 'string' || !cardId.test(card.id) || !Number.isSafeInteger(card.version) || card.version < 1 || card.version > 999999999 ||
      !Object.hasOwn(decisionLabels, decision) || !card.actions?.some(action => action.decision === decision)) return '';
  return '星舵操作 ' + card.id + ' v' + card.version + ' ' + decision;
}

export async function cardRequest(card, decision) {
  const text = cardCommand(card, decision);
  if (!text) return null;
  // A retry after a lost response or from another phone is the same user decision.
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  const key = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
  return { text, requestId: 'card-' + key };
}

export function chatDisplayText(text, cards) {
  const match = controlText.exec(text);
  if (!match) return text;
  return [decisionLabels[match[3]], cards?.get(match[1])?.title].filter(Boolean).join(' · ');
}

function anchoredCards(message, prior, prepend) {
  if (!message.proactive) return message;
  const previous = new Map((prior?.proactive || []).map(card => [card.id, card]));
  const cards = new Map();
  for (const card of message.proactive) {
    if (card.messageId !== message.id) continue;
    const old = cards.get(card.id) || previous.get(card.id);
    cards.set(card.id, old && (old.version > card.version || (prepend && old.version === card.version)) ? old : card);
  }
  return { ...message, proactive: [...cards.values()] };
}

// A work order can appear on both its original turn and a later amendment.
// Keep its freshest snapshot on the newest reference in the loaded conversation.
export function mergeWorkHistory(previous, page, prepend = false) {
  const messages = new Map();
  const snapshots = new Map();
  for (const message of [...previous, ...page]) {
    messages.set(message.id, anchoredCards(message, messages.get(message.id), prepend));
    const work = message.work;
    if (!work) continue;
    const old = snapshots.get(work.id);
    const revision = work.revision ?? 0;
    const change = (work.updatedAt || '').localeCompare(old?.updatedAt || '');
    if (!old || revision > (old.revision ?? 0) ||
        (revision === (old.revision ?? 0) && (change > 0 || (!prepend && change === 0)))) {
      snapshots.set(work.id, work);
    }
  }
  const ordered = [...messages.values()].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  for (let i = ordered.length - 1; i >= 0; --i) {
    const { work, ...message } = ordered[i];
    if (!work) continue;
    const latest = snapshots.get(work.id);
    ordered[i] = latest ? { ...message, work: latest } : message;
    snapshots.delete(work.id);
  }
  return ordered;
}

export const liveWork = work => work?.state === 'working' || work?.state === 'synthesizing';
const settledCards = new Set(['cancelled', 'completed', 'ignored', 'approved']);
const unsettledSteps = new Set(['queued', 'running', 'offline']);

export async function refreshOlderWork(page, transcript, fetchAround, current = () => true) {
  const polled = new Set(page.messages.map(message => message.work?.id));
  const pageIds = new Set(page.messages.map(message => message.id));
  const older = new Set();
  for (const { id, work, proactive } of transcript) {
    if (!pageIds.has(id) && proactive?.some(card => !settledCards.has(card.status) || (card.startedAt && !card.finishedAt))) older.add(id);
    if (!work || polled.has(work.id)) continue;
    if (liveWork(work) || work.tasks?.some(step => unsettledSteps.has(step.state))) older.add(id);
  }
  for (const id of older) {
    if (!current()) break;
    const window = await fetchAround(id);
    for (const message of window.messages) {
      if (older.delete(message.id)) page.messages.push(message);
    }
  }
}
