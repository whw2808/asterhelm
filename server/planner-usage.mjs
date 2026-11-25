const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const sum = values => values.length && !values.includes(null) ? count(values.reduce((a, b) => a + b, 0)) : null;
const hasCounts = row => Object.values(row).some(value => value !== null);
const cacheSubset = (cached, input) => input !== null && cached > input ? null : cached;

export function chatUsage(data) {
  const usage = data?.usage;
  const inputTokens = count(usage?.prompt_tokens);
  const outputTokens = count(usage?.completion_tokens);
  const cache = count(usage?.prompt_tokens_details?.cached_tokens) ?? count(usage?.prompt_cache_hit_tokens);
  const row = {
    inputTokens, outputTokens,
    totalTokens: count(usage?.total_tokens) ?? sum([inputTokens, outputTokens]),
    cachedInputTokens: cacheSubset(cache, inputTokens)
  };
  return hasCounts(row) ? { model: typeof data.model === 'string' ? data.model : null, ...row } : null;
}

function dshStepUsage(usage) {
  const outputTokens = count(usage?.outputTokens);
  const cache = count(usage?.cacheReadTokens);
  // DSH inputTokens excludes cache reads and writes. Unreported optional buckets
  // prevent a sum, but the provider's exact total also gives inclusive input.
  const buckets = sum([count(usage?.inputTokens), cache, count(usage?.cacheWriteTokens)]);
  const totalTokens = count(usage?.totalTokens) ?? sum([buckets, outputTokens]);
  const inclusive = totalTokens !== null && outputTokens !== null ? count(totalTokens - outputTokens) : null;
  const inputTokens = inclusive ?? buckets;
  return { inputTokens, outputTokens, totalTokens, cachedInputTokens: cacheSubset(cache, inputTokens) };
}

// The headless --json protocol bounds every event except the final answer.
// Keep enough space for the previous 80K answer limit plus JSON escaping.
const maxLineChars = 512_000;

export class DshRunOutput {
  line = '';
  text = '';
  steps = [];
  openStep = false;
  incomplete = false;

  write(chunk) {
    const parts = chunk.split('\n');
    for (const [index, part] of parts.entries()) {
      if (this.line !== null) {
        this.line = this.line.length + part.length <= maxLineChars ? this.line + part : null;
      }
      if (index < parts.length - 1) {
        this.readLine(this.line);
        this.line = '';
      }
    }
  }

  readLine(line) {
    if (!line) return;
    let event;
    try { event = JSON.parse(line); } catch { return; }
    if (event?.type === 'final' && typeof event.text === 'string') this.text = event.text.slice(-80_000);
    if (event?.type !== 'status') return;
    if (event.phase === 'step_start') {
      if (this.openStep) this.incomplete = true;
      this.openStep = true;
    }
    if (event.phase === 'step_end') {
      this.openStep = false;
      this.steps.push(dshStepUsage(event.usage));
    }
  }

  usage(model) {
    const reported = this.steps.filter(hasCounts);
    if (!reported.length) return null;
    const result = { model };
    const incomplete = this.incomplete || this.openStep || this.steps.some(step => step.totalTokens === null);
    for (const key of Object.keys(reported[0])) {
      const known = reported.map(step => step[key]).filter(value => value !== null);
      const completeField = known.length === reported.length;
      // When the total is exact, only return complete breakdowns. For an
      // incomplete run its flagged input/output figures are known subtotals.
      result[key] = completeField || (incomplete && key !== 'cachedInputTokens') ? sum(known) : null;
    }
    if (incomplete || result.totalTokens === null) result.incomplete = true;
    return result;
  }
}
