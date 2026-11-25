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

// A work order can appear on both its original turn and a later amendment.
// Keep its freshest snapshot on the newest reference in the loaded conversation.
export function mergeWorkHistory(previous, page) {
  const messages = new Map();
  const snapshots = new Map();
  for (const message of [...previous, ...page]) {
    messages.set(message.id, message);
    const work = message.work;
    if (!work) continue;
    const old = snapshots.get(work.id);
    const revision = work.revision ?? 0;
    if (!old || revision > (old.revision ?? 0) ||
        (revision === (old.revision ?? 0) && (work.updatedAt || '') >= (old.updatedAt || ''))) {
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
const unsettledSteps = new Set(['queued', 'running', 'offline']);

export async function refreshOlderWork(page, transcript, fetchAround, current = () => true) {
  const polled = new Set(page.messages.map(message => message.work?.id));
  const older = new Set();
  for (const { id, work } of transcript) {
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
