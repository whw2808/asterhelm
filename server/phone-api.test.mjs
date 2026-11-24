import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { setTimeout as wait } from 'node:timers/promises';
import { PhoneAuth } from './phone-auth.mjs';
const phoneOrigin = 'https://phone.example.test';

test('phone routes keep existing sessions and expose only paired personal data', async t => {
  const testHome = await fs.mkdtemp(path.join(os.tmpdir(), 'phone-api-'));
  t.after(() => fs.rm(testHome, { recursive: true, force: true }));
  await fs.writeFile(path.join(testHome, 'android.apk'), Buffer.from('PK-test-install'));
  const auth = new PhoneAuth(path.join(testHome, 'phones.sqlite'));
  t.after(() => auth.db.close());
  const existing = auth.redeem(auth.invite());
  let items = [];
  const personale = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const data = JSON.parse(Buffer.concat(chunks));
    const content = req.url === '/notifications' ? { items: items.filter(n => n.seq > data.after), cursor: items.at(-1)?.seq ?? data.after } : { route: req.url, data };
    res.end(JSON.stringify({ value: content }));
  });
  const control = http.createServer((req, res) => res.end(JSON.stringify({ value: req.url })));
  for (const [server, socket] of [[control, 'control.sock'], [personale, 'personal.sock']]) {
    server.listen(path.join(testHome, socket));
    await once(server, 'listening');
    t.after(() => server.close());
  }
  const port = http.createServer().listen(0, '127.0.0.1');
  await once(port, 'listening');
  const address = port.address().port;
  await new Promise(resolve => port.close(resolve));
  const base = 'http://127.0.0.1:' + address;
  const proc = spawn(process.execPath, [fileURLToPath(new URL('./phone.mjs', import.meta.url))], {
    env: { ...process.env, ASTERHELM_HOME: testHome, ASTERHELM_PUBLIC_ORIGIN: phoneOrigin, SUPER_AGENT_PHONE_PORT: String(address) }, stdio: 'ignore',
  });
  t.after(async () => { if (proc.exitCode === null && !proc.signalCode) { const exited = once(proc, 'exit'); proc.kill(); await exited; } });
  for (let i = 0; i < 30; i++) {
    try { await fetch(base); break; } catch { await wait(50); }
  }
  const post = (route, data, session = existing, origin = phoneOrigin) => fetch(base + '/api/' + route, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: '__Host-sa=' + session, Origin: origin }, body: JSON.stringify(data),
  });
  assert.match(await (await fetch(base)).text(), /<title>Asterhelm<\/title>/);
  assert.equal(await (await fetch(base + '/android.apk')).text(), 'PK-test-install');
  for (const [route, data] of Object.entries({ history: { around: 'old-item' }, chat: { text: 'hello', requestId: 'stable' }, board: {} })) {
    assert.equal((await post(route, data, '')).status, 401);
    assert.equal((await post(route, data, existing, 'https://invalid.example')).status, 403);
    assert.deepEqual((await (await post(route, data)).json()).value, { route: '/' + route, data });
  }
  assert.equal((await (await post('workers', {})).json()).value, '/workers');
  const interval = setTimeout(() => { items = [{ id: 'message1', seq: 1, text: 'ready' }]; }, 80);
  t.after(() => clearTimeout(interval));
  const result = (await (await post('notifications', { after: 0, waitMs: 3000 })).json()).value;
  assert.deepEqual(result.items, items);
  assert.equal(result.cursor, 1);
  assert.deepEqual((await (await post('notifications', { after: 1 })).json()).value, { items: [], cursor: 1 });
  const code = auth.invite();
  const paired = await post('pair', { code }, '');
  assert.equal(paired.status, 200); assert.match(paired.headers.get('Set-Cookie'), /HttpOnly/);
  assert.equal((await post('pair', { code }, '')).status, 401);
  assert.equal((await post('logout', {})).status, 200);
  assert.equal((await post('history', {})).status, 401);
});
