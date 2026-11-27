import {approveRoute} from '../server/test-support/route-review.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import https from 'node:https';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = 'scripts/asterhelm.mjs';
const pki = 'scripts/pki.mjs';
const control = 'server/control.mjs';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asterhelm-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { HOME: dir, ASTERHELM_HOME: path.join(dir, 'hub'), PATH: process.env.PATH, LANG: 'C' };
}

function command(env, file, ...args) {
  return execFileSync(process.execPath, [file, ...args], {
    cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 10000,
  }).trim();
}

function launch(env, ...args) {
  const child = spawn(process.execPath, [cli, ...args], { cwd: root, env, stdio: ['ignore', 'ignore', 'pipe'] });
  const closed = once(child, 'close');
  let errors = '';
  child.stderr.on('data', bytes => { errors = (errors + bytes).slice(-4096); });
  return {
    assertRunning() { assert.equal(child.exitCode, null, errors); },
    async stop() { child.kill('SIGTERM'); await closed; },
  };
}

async function poll(check, service) {
  const until = Date.now() + 20000;
  do {
    service.assertRunning();
    const value = await check();
    if (value) return value;
    await delay(100);
  } while (Date.now() < until);
  assert.fail('Timed out waiting for the service.');
}

async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

const phoneApi = env => (route, data = {}, cookie = '') => fetch('http://127.0.0.1:' + env.SUPER_AGENT_PHONE_PORT + '/api/' + route, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: env.ASTERHELM_PUBLIC_ORIGIN, Cookie: cookie },
  body: JSON.stringify(data),
});

async function sendChat(env, hub, message, answer) {
  const invitation = new URL(command(env, cli, 'pair'));
  const api = phoneApi(env);
  const code = new URLSearchParams(invitation.hash.slice(1)).get('t');
  const grant = await api('pair', { code });
  assert.equal(grant.status, 200);
  const cookie = grant.headers.get('set-cookie').split(';')[0];
  const posted = await api('chat', { requestId: 'synthetic-request', text: message }, cookie);
  assert.equal(posted.status, 200);
  await poll(async () => {
    const response = await api('history', {}, cookie);
    return (await response.json()).value.messages.some(row => row.role === 'assistant' && row.text.includes(answer));
  }, hub);
  return cookie;
}

function workerOnline(env, target) {
  try { return JSON.parse(command(env, control, 'workers')).find(w => w.target === target && w.online); }
  catch { return false; }
}

async function finishSample(env, service, target) {
  const registration = await poll(() => workerOnline(env, target), service);
  assert.equal(registration.hardware, null);
  const { id } = JSON.parse(command(env, control, 'submit', target, 'Hello'));
  const task = await poll(() => {
    const task = JSON.parse(command(env, control, 'get', id));
    return ['succeeded', 'failed', 'interrupted'].includes(task.state) && task;
  }, service);
  assert.equal(task.state, 'succeeded', task.result);
  assert.equal(task.result, '6');
}

test('first run: isolated hub, read-only worker, pairing, dashboard and logout', async t => {
  const env = fixture(t);
  env.SUPER_AGENT_PHONE_PORT = String(await freePort());
  env.ASTERHELM_PUBLIC_ORIGIN = 'https://phone.example.test';
  command(env, cli, 'init');
  assert.throws(() => command(env, cli, 'init'));
  const file = command(env, cli, 'configure-worker', '--adapter', 'check');
  assert.deepEqual(JSON.parse(fs.readFileSync(file)).registration.capabilities, ['read-only']);
  assert.throws(() => command(env, cli, 'configure-worker', '--adapter', 'check'));
  const codex = command(env, cli, 'configure-worker', '--adapter', 'codex');
  assert.deepEqual(JSON.parse(fs.readFileSync(codex)).registration.contextSources, []);
  const hub = launch(env, 'hub');
  const worker = launch(env, 'worker', 'hub.check');
  try {
    await finishSample(env, worker, 'hub.check');
    assert.throws(() => command(env, cli, 'hub'));
    assert.throws(() => command(env, cli, 'worker', 'hub.check'));
    const api = phoneApi(env);
    assert.equal((await api('board')).status, 401);
    const invitation = new URL(command(env, cli, 'pair'));
    assert.equal(invitation.origin, env.ASTERHELM_PUBLIC_ORIGIN);
    const code = new URLSearchParams(invitation.hash.slice(1)).get('t');
    assert.ok(code);
    const paired = await api('pair', { code });
    assert.equal(paired.status, 200);
    assert.equal((await api('pair', { code })).status, 401);
    const session = paired.headers.get('set-cookie');
    assert.ok(session.includes('Secure') && session.includes('HttpOnly'));
    const cookie = session.split(';')[0];
    const board = await api('board', {}, cookie);
    assert.equal(board.status, 200);
    assert.equal((await board.json()).value.workers[0].target, 'hub.check');
    assert.equal((await api('logout', {}, cookie)).status, 200);
    assert.equal((await api('history', {}, cookie)).status, 401);
  } finally { await worker.stop(); await hub.stop(); }
});

test('private CA signs a remote worker and enforces mTLS', async t => {
  const env = fixture(t);
  const peer = { ...env, ASTERHELM_HOME: path.join(env.HOME, 'peer') };
  env.SUPER_AGENT_PHONE_PORT = String(await freePort());
  const port = String(await freePort());
  command(env, cli, 'init');
  command(env, pki, 'init', '--host', '127.0.0.1', '--bind', '127.0.0.1', '--port', port);
  command(peer, pki, 'request', '--device', 'node-b');
  const certs = path.join(peer.ASTERHELM_HOME, 'pki');
  const request = path.join(certs, 'client.csr');
  assert.throws(() => command(env, pki, 'sign', '--device', 'wrong-device', '--csr', request));
  command(env, pki, 'sign', '--device', 'node-b', '--csr', request);
  const hubKeys = path.join(env.ASTERHELM_HOME, 'pki');
  fs.copyFileSync(path.join(hubKeys, 'issued', 'node-b.crt'), path.join(certs, 'client.crt'));
  fs.copyFileSync(path.join(hubKeys, 'ca.crt'), path.join(certs, 'ca.crt'));
  assert.equal(fs.statSync(path.join(certs, 'client.key')).mode & 0o077, 0);
  command(peer, cli, 'configure-worker', '--adapter', 'check', '--device', 'node-b', '--server', '127.0.0.1', '--port', port);
  const hub = launch(env, 'hub');
  const worker = launch(peer, 'worker', 'node-b.check');
  try {
    await finishSample(env, worker, 'node-b.check');
    await assert.rejects(new Promise((resolve, reject) => {
      https.get({ hostname: '127.0.0.1', port, ca: fs.readFileSync(path.join(certs, 'ca.crt')) }, resolve).on('error', reject);
    }));
  } finally { await worker.stop(); await hub.stop(); }
});

test('Chat Completions planner dispatches to a native executor and returns the receipt to chat', async t => {
  const env = fixture(t);
  env.SUPER_AGENT_PHONE_PORT = String(await freePort());
  env.ASTERHELM_PUBLIC_ORIGIN = 'https://phone.example.test';
  env.PERSONAL_AGENT_ENGINE = 'chat-api';
  env.PERSONAL_AGENT_MODEL = 'fixture';
  env.PERSONAL_AGENT_API_KEY = randomBytes(24).toString('base64url');
  command(env, cli, 'init');
  command(env, pki, 'init', '--host', '127.0.0.1', '--bind', '127.0.0.1', '--port', String(await freePort()));
  const keys = path.join(env.ASTERHELM_HOME, 'pki');
  env.NODE_EXTRA_CA_CERTS = path.join(keys, 'ca.crt');
  const sample = 'Verify the sample with hub.codex';
  const nativeOutput = 'sample=ok';
  const finalAnswer = 'The worker verified the sample.';
  const provider = https.createServer({
    key: fs.readFileSync(path.join(keys, 'router.key')), cert: fs.readFileSync(path.join(keys, 'router.crt')),
  }, async (req, res) => {
    // Serve exactly this fixture's planner contract on loopback.
    try {
      assert.equal(req.url, '/v1/chat/completions');
      assert.equal(req.headers.authorization, 'Bearer ' + env.PERSONAL_AGENT_API_KEY);
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const request = JSON.parse(Buffer.concat(chunks));
      assert.equal(request.model, 'fixture');
      const input = JSON.parse(request.messages[1].content);
      let output;
      if (input.phase === 'routeAuthority') output = approveRoute(input);
      else if (input.phase === 'delivery') {
        assert.equal(input.results[0].result, nativeOutput);
        output = { reply: finalAnswer, actions: [], coverage: [{
          index: 0, status: 'answered', finding: nativeOutput, sources: [input.results[0].id],
        }] };
      } else {
        assert.equal(input.currentUser, sample);
        output = { reply: '', criteria: ['Verify the sample'], actions: [{
          type: 'consult', title: 'Check sample', target: 'hub.codex', evidence: sample, prompt: sample,
        }] };
      }
      res.end(JSON.stringify({ model: 'fixture', usage: { prompt_tokens: 12, completion_tokens: 5 },
        choices: [{ message: { content: JSON.stringify(output) } }] }));
    } catch (err) { res.writeHead(400); res.end(err.message); }
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  env.PERSONAL_AGENT_API_URL = 'https://127.0.0.1:' + provider.address().port + '/v1/chat/completions';
  t.after(() => new Promise(resolve => { provider.closeAllConnections(); provider.close(resolve); }));

  const executable = path.join(env.HOME, 'fixture-codex.mjs');
  fs.writeFileSync(executable, `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
if (!args.includes('exec')) process.exit(1);
if (args[args.indexOf('-s') + 1] !== 'read-only' || args.includes('-m')) process.exit(2);
const prompt = fs.readFileSync(0, 'utf8');
if (!prompt.includes('Verify the sample')) process.exit(3);
fs.writeFileSync(args[args.indexOf('-o') + 1], 'sample=ok');
`, { mode: 0o700 });
  command(env, cli, 'configure-worker', '--adapter', 'codex', '--executable', executable);
  const hub = launch(env, 'hub');
  const worker = launch(env, 'worker', 'hub.codex');
  try {
    await poll(() => workerOnline(env, 'hub.codex'), worker);
    const cookie = await sendChat(env, hub, sample, finalAnswer);
    const board = await phoneApi(env)('board', {}, cookie);
    const phases = (await board.json()).value.usage.byPhase;
    // The chat phase includes the planner and independent authorization call.
    assert.equal(phases.find(row => row.phase === 'chat')?.totalTokens, 34);
    assert.equal(phases.find(row => row.phase === 'delivery')?.totalTokens, 17);
  } finally { await worker.stop(); await hub.stop(); }
});

test('DeepSeek configuration supplies the model profile to a headless worker and a tool-free planner', async t => {
  const env = fixture(t);
  env.SUPER_AGENT_PHONE_PORT = String(await freePort());
  env.ASTERHELM_PUBLIC_ORIGIN = 'https://phone.example.test';
  command(env, cli, 'init');
  const harness = path.join(env.HOME, 'stand-in-harness');
  const profile = path.join(harness, 'profiles', 'web');
  const yamlModule = path.join(harness, 'node_modules', 'js-yaml');
  fs.mkdirSync(profile, { recursive: true });
  fs.mkdirSync(yamlModule, { recursive: true });
  // The fixture uses the JSON subset of YAML so the suite has no package dependencies.
  fs.writeFileSync(path.join(yamlModule, 'index.js'), 'module.exports = {load: JSON.parse, dump: JSON.stringify};');
  fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), JSON.stringify([{
    id: 'agent-default-model', config: { provider: 'fixture', model: 'test-model' },
  }]));
  const patch = path.join(harness, 'headless.yml');
  const entry = path.join(harness, 'entry.mjs');
  fs.writeFileSync(patch, '[]');
  fs.writeFileSync(entry, `
import fs from 'node:fs';
import assert from 'node:assert/strict';
const args = process.argv.slice(2);
const option = key => args[args.indexOf(key) + 1];
assert.equal(option('--profile'), 'headless');
if (args.includes('--dump-config')) {
  console.log(['tool-files','session-persistence-jsonl','session-projection-cache','session-query-sqlite'].map(id => '- id: ' + id).join('\\n'));
} else if (args.includes('--help')) {
  console.log('  --json   emit newline-delimited events');
} else {
  assert.equal(option('--permission-mode'), 'read-only');
  assert.equal(option('--approval-policy'), 'never');
  const patch = JSON.parse(fs.readFileSync(option('--patch'), 'utf8'));
  assert.equal(patch.find(r => r.id === 'agent-default-model').config.model, 'test-model');
  const input = fs.readFileSync(0, 'utf8');
  if (patch.some(r => r.id === 'system-prompt')) {
    for (const id of ['tool-files','session-persistence-jsonl','session-projection-cache','session-query-sqlite']) {
      assert.equal(patch.find(r => r.id === id)?.disabled, true);
    }
    assert.ok(args.includes('--json'));
    const emit = event => console.log(JSON.stringify(event));
    emit({type: 'session', sessionId: 'fictional-greeting'});
    emit({type: 'status', phase: 'step_start', turn: 0, step: 0});
    emit({type: 'status', phase: 'step_end', turn: 0, step: 0, usage: {
      inputTokens: 16, cacheReadTokens: 4, outputTokens: 6, totalTokens: 26
    }});
    emit({type: 'final', sessionId: 'fictional-greeting', reason: {kind: 'completed'},
      text: JSON.stringify({reply: 'Synthetic hello.', actions: [], directBasis: 'conversation'})});
  } else {
    console.log(Buffer.byteLength(input));
  }
}
`);
  env.PERSONAL_AGENT_DSH_CONFIG = command(env, cli, 'configure-worker', '--adapter', 'deepseek',
    '--dsh-home', harness, '--dsh-entry', entry, '--dsh-patch', patch);
  const hub = launch(env, 'hub');
  const worker = launch(env, 'worker', 'hub.deepseek');
  try {
    await finishSample(env, worker, 'hub.deepseek');
    const cookie = await sendChat(env, hub, 'Hello', 'Synthetic hello.');
    const board = await phoneApi(env)('board', {}, cookie);
    const usage = (await board.json()).value.usage.allTime;
    assert.deepEqual([usage.calls, usage.inputTokens, usage.outputTokens, usage.totalTokens, usage.cachedInputTokens],
      [1, 20, 6, 26, 4]);
  } finally { await worker.stop(); await hub.stop(); }
});
