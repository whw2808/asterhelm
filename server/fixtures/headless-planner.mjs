import fs from 'node:fs';
import assert from 'node:assert/strict';

const args = process.argv.slice(2);
if (args.includes('--dump-config')) {
  console.log('- id: tool-fictional\n- id: session-persistence-files');
  process.exit(0);
}
if (args.includes('--help')) {
  console.log(process.env.CATALOG_LEGACY === '1' ? '--permission-mode PRESET' : '--json    write newline-delimited run events');
  process.exit(0);
}

const input = JSON.parse(fs.readFileSync(0, 'utf8').split('\n').at(-1));
const entries = JSON.parse(fs.readFileSync(args[args.indexOf('--patch') + 1], 'utf8'));
const model = entries.findLast(row => row.id === 'agent-default-model').config.model;
assert.equal(args[args.indexOf('--permission-mode') + 1], 'read-only');
assert.equal(args[args.indexOf('--approval-policy') + 1], 'never');
assert.equal(entries.findLast(row => row.id === 'tool-fictional').disabled, true);
assert.equal(entries.findLast(row => row.id === 'session-persistence-files').disabled, true);
const answer = JSON.stringify({ reply: model, actions: [], usage: { totalTokens: 888 } });
if (!args.includes('--json')) {
  console.log(answer);
  process.exit(0);
}
assert.notEqual(process.env.CATALOG_LEGACY, '1', 'legacy runner does not support --json');
assert.ok(args.indexOf('--patch') < args.indexOf('--json'), 'launcher options precede headless arguments');

const emit = event => console.log(JSON.stringify(event));
const status = (phase, step, usage) => emit({ type: 'status', phase, turn: 0, step, usage });
emit({ type: 'session', sessionId: 'books' });
status('turn_start');
status('step_start', 0);
emit({ type: 'text', text: '{"type":"status","phase":"step_end","usage":{"totalTokens":999}}' });
if (input.scenario === 'complete' || input.scenario === 'interrupted') {
  status('step_end', 0, { inputTokens: 16, cacheReadTokens: 6, cacheWriteTokens: 2, outputTokens: 3, reasoningTokens: 2, totalTokens: 27 });
  status('step_start', 1);
  if (input.scenario === 'interrupted') process.exitCode = 1;
  else status('step_end', 1, { inputTokens: 16, cacheReadTokens: 7, cacheWriteTokens: 0, outputTokens: 5 });
} else if (input.scenario === 'exact-totals') {
  status('step_end', 0, { totalTokens: 22, outputTokens: 2, inputTokens: 20 });
  status('step_start', 1);
  status('step_end', 1, { totalTokens: 5 });
} else if (input.scenario === 'partial') {
  status('step_end', 0, { inputTokens: 10, outputTokens: 4 });
} else {
  status('step_end', 0);
}
if (!process.exitCode) {
  status('turn_end');
  emit({ type: 'final', sessionId: 'books', reason: { kind: 'completed' }, text: answer });
}
