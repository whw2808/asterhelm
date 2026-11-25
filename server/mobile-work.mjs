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
