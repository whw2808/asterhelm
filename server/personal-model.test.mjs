import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ChatApiPlanner, DshPlanner } from './personal-model.mjs';

const reply = { reply: 'Two books', actions: [] };

function api(response) {
  return new ChatApiPlanner({
    endpoint: 'https://catalog.example.test/chat', model: 'catalog-alias', key: 'fixture-key',
    request: async () => response
  });
}

test('chat planner reports the response model and inclusive prompt usage before validating the reply', async () => {
  const reports = [];
  const response = Response.json({
    model: 'catalog-v2', choices: [{ message: { content: 'unusable' } }],
    usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25, prompt_tokens_details: { cached_tokens: 13 } }
  });
  await assert.rejects(api(response).plan({}, { onUsage: row => reports.push(row) }));
  assert.deepEqual(reports, [{ model: 'catalog-v2', inputTokens: 20, outputTokens: 5, totalTokens: 25, cachedInputTokens: 13 }]);
});

test('chat planner sums reported components, preserves zero and supports DeepSeek cache hits', async () => {
  const reports = [];
  const response = Response.json({
    choices: [{ message: { content: JSON.stringify(reply) } }],
    usage: { prompt_tokens: 18, completion_tokens: 0, prompt_cache_hit_tokens: 8 }
  });
  assert.equal((await api(response).plan({}, { onUsage: row => reports.push(row) })).reply, reply.reply);
  assert.deepEqual(reports, [{ model: null, inputTokens: 18, outputTokens: 0, totalTokens: 18, cachedInputTokens: 8 }]);
});

test('chat planner retains valid partial usage on a rejected request and ignores text posing as usage', async () => {
  const reports = [];
  const options = { onUsage: row => reports.push(row) };
  const response = Response.json({
    usage: { prompt_tokens: 12, completion_tokens: -1, total_tokens: 'unknown', prompt_cache_hit_tokens: 30 }
  }, { status: 400 });
  await assert.rejects(api(response).plan({}, options), /HTTP 400/);
  assert.deepEqual(reports, [{ model: null, inputTokens: 12, outputTokens: null, totalTokens: null, cachedInputTokens: null }]);
  const content = JSON.stringify({ ...reply, usage: { total_tokens: 5000 } });
  await api(Response.json({ choices: [{ message: { content } }] })).plan({}, options);
  assert.equal(reports.length, 1);
  await assert.rejects(api(new Response('gateway unavailable', { status: 502 })).plan({}, options), /HTTP 502/);
});

function harness(t, legacy = false) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-planner-'));
  t.after(() => fs.rmSync(home, { force: true, recursive: true }));
  const entry = path.join(home, 'dsh.mjs');
  fs.copyFileSync(new URL('./fixtures/headless-planner.mjs', import.meta.url), entry);
  // JSON is a YAML subset. This standalone fixture needs no installed DSH packages.
  const yamlDir = path.join(home, 'node_modules/js-yaml');
  fs.mkdirSync(yamlDir, { recursive: true });
  fs.writeFileSync(path.join(yamlDir, 'index.js'), 'exports.load = JSON.parse; exports.dump = JSON.stringify;');
  const profile = path.join(home, 'profiles/web/cordis.patch.yml');
  fs.mkdirSync(path.dirname(profile), { recursive: true });
  const select = model => fs.writeFileSync(profile, JSON.stringify([{ id: 'agent-default-model', config: { model, provider: 'catalog' } }]));
  select('fiction-v1');
  const patch = path.join(home, 'base.yml');
  fs.writeFileSync(patch, '[]');
  fs.writeFileSync(path.join(home, 'personal-engine.json'), JSON.stringify({
    executable: process.execPath, dshEntry: entry, env: { DSH_HOME: home, CATALOG_LEGACY: legacy ? '1' : '0' }, dshPatch: patch
  }));
  return { planner: new DshPlanner(home), select };
}

test('DSH attributes concurrent invocations to their own route and sums structured step usage', async t => {
  const { planner, select } = harness(t);
  const reports = [[], []];
  const first = planner.plan({ scenario: 'complete' }, { onUsage: row => reports[0].push(row) });
  select('fiction-v2');
  const second = planner.plan({ scenario: 'complete' }, { onUsage: row => reports[1].push(row) });
  const results = await Promise.all([first, second]);
  for (let i = 0; i < 2; i++) {
    const model = ['fiction-v1', 'fiction-v2'][i];
    assert.equal(results[i].reply, model);
    assert.deepEqual(reports[i], [{ model, inputTokens: 47, outputTokens: 8, totalTokens: 55, cachedInputTokens: 13 }]);
  }
  assert.deepEqual(fs.readdirSync(planner.dir), []);
});

test('DSH retains observations before a failed run and flags a step without reported usage', async t => {
  const { planner } = harness(t);
  const reports = [];
  await assert.rejects(planner.plan({ scenario: 'interrupted' }, { onUsage: row => reports.push(row) }));
  assert.deepEqual(reports, [{
    model: 'fiction-v1', inputTokens: 24, outputTokens: 3, totalTokens: 27, cachedInputTokens: 6, incomplete: true
  }]);
  assert.deepEqual(fs.readdirSync(planner.dir), []);
});

test('DSH keeps missing cache buckets unknown and ignores model-written or absent accounting', async t => {
  const { planner } = harness(t);
  const reports = [];
  const options = { onUsage: row => reports.push(row) };
  await planner.plan({ scenario: 'partial' }, options);
  assert.deepEqual(reports, [{
    model: 'fiction-v1', inputTokens: null, outputTokens: 4, totalTokens: null, cachedInputTokens: null, incomplete: true
  }]);
  await planner.plan({ scenario: 'no-usage' }, options);
  assert.equal(reports.length, 1);
});

test('DSH sums exact step totals when one step omits the breakdown', async t => {
  const { planner } = harness(t);
  const reports = [];
  await planner.plan({ scenario: 'exact-totals' }, { onUsage: row => reports.push(row) });
  assert.deepEqual(reports, [{ model: 'fiction-v1', inputTokens: null, outputTokens: null, totalTokens: 27, cachedInputTokens: null }]);
});

test('legacy headless without machine-readable output keeps its private plaintext planner', async t => {
  const { planner } = harness(t, true);
  const reports = [];
  const result = await planner.plan({}, { onUsage: row => reports.push(row) });
  assert.equal(result.reply, 'fiction-v1');
  assert.deepEqual(reports, []);
});
