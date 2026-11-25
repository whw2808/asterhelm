import http from 'node:http';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { setTimeout as wait } from 'node:timers/promises';
import { home, call, personalCall } from './control.mjs';
import { PhoneAuth } from './phone-auth.mjs';
import { phoneOrigin } from './phone-origin.mjs';

process.umask(0o077);
const auth = new PhoneAuth(path.join(home, 'phones.sqlite'));
const port = Number(process.env.SUPER_AGENT_PHONE_PORT || 42852);
const origin = phoneOrigin();
const cookieName = '__Host-sa';
const cookieOptions = '; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=';
const assets = new Map([
  ['/', ['mobile.html', 'text/html; charset=utf-8']],
  ['/app.js', ['mobile.js', 'text/javascript; charset=utf-8']],
  ['/mobile-work.mjs', ['mobile-work.mjs', 'text/javascript; charset=utf-8']],
  ['/mobile-marked.mjs', ['mobile-marked.mjs', 'text/javascript; charset=utf-8']],
  ['/app.css', ['mobile.css', 'text/css; charset=utf-8']],
  ['/agent-codex.png', ['agent-codex.png', 'image/png']],
  ['/agent-deepseek.png', ['agent-deepseek.png', 'image/png']],
  ['/assistant-mark.webp', ['assistant-mark.webp', 'image/webp']],
  ['/device-desktop.webp', ['device-desktop.webp', 'image/webp']],
  ['/device-laptop.webp', ['device-laptop.webp', 'image/webp']],
]);
const controlRoutes = new Set(['/submit', '/list', '/get', '/cancel', '/workers']);
const personalRoutes = new Set(['/chat', '/board', '/history', '/notifications']);

async function nextNotifications(input, session, signal) {
  const after = input.after ?? 0;
  const waitMs = input.waitMs ?? 0;
  if (!Number.isSafeInteger(after) || after < 0 || !Number.isFinite(waitMs) || waitMs < 0) {
    throw Error('通知游标或等待时间无效。');
  }
  const deadline = Date.now() + Math.min(waitMs, 180000);
  for (;;) {
    if (!auth.valid(session)) throw Object.assign(Error('设备授权已过期。'), { status: 401 });
    const value = await personalCall('/notifications', { after }, signal);
    const remaining = deadline - Date.now();
    if (value.items.length || remaining <= 0) return value;
    await wait(Math.min(2000, remaining), undefined, { signal });
  }
}

async function sendPackage(req, res) {
  let file;
  try { file = await fs.open(path.join(home, 'android.apk')); }
  catch (error) {
    if (error.code === 'ENOENT') { res.writeHead(404); res.end(); return; }
    throw error;
  }
  try {
    res.writeHead(200, {
      'Content-Type': 'application/vnd.android.package-archive',
      'Content-Disposition': 'attachment; filename="Asterhelm.apk"',
      'Content-Length': (await file.stat()).size,
    });
    if (req.method === 'HEAD') res.end();
    else await pipeline(file.createReadStream({ autoClose: false }), res);
  } finally { await file.close(); }
}

const server = http.createServer({ headersTimeout: 8000, requestTimeout: 12000 }, async (req, res) => {
  const controller = new AbortController();
  res.once('close', () => controller.abort());
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  function json(status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
  }
  try {
    if ((req.method === 'GET' || req.method === 'HEAD') && req.url === '/android.apk') return await sendPackage(req, res);
    if (req.method === 'GET' && assets.has(req.url)) {
      const [file, type] = assets.get(req.url);
      const bytes = await fs.readFile(new URL(file, import.meta.url));
      res.writeHead(200, { 'Content-Type': type });
      res.end(bytes);
      return;
    }
    if (req.method !== 'POST' || !req.url.startsWith('/api/')) return json(404, { error: 'Not found' });
    if (req.headers.origin && req.headers.origin !== origin) return json(403, { error: 'Origin rejected' });
    if (req.headers['content-type']?.split(';')[0] !== 'application/json') return json(415, { error: 'Expected JSON' });
    const route = req.url.slice(4);
    const session = (req.headers.cookie || '').split(';').map(part => part.trim())
      .find(part => part.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
    if (route !== '/pair' && !auth.valid(session)) return json(401, { error: '请使用 服务器生成的配对链接连接手机。' });
    if (route !== '/pair') {
      const scope = createHash('sha256').update('ui-pairing:' + session).digest('base64url');
      res.setHeader('X-Asterhelm-Pairing', scope);
      if (req.headers['x-asterhelm-pairing'] && req.headers['x-asterhelm-pairing'] !== scope)
        return json(409, { error: '配对已切换，请重新打开对话。' });
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 150000) return json(413, { error: '请求过长。' });
      chunks.push(chunk);
    }
    const data = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    if (data === null || typeof data !== 'object' || Array.isArray(data)) return json(400, { error: 'Expected JSON object' });
    if (route === '/pair') {
      const paired = auth.redeem(data.code);
      if (!paired) return json(401, { error: '配对码已使用或已过期，请在服务器上重新生成邀请。' });
      res.setHeader('Set-Cookie', cookieName + '=' + paired + cookieOptions + 7776000);
      return json(200, { paired: true });
    }
    if (route === '/logout') {
      auth.logout(session);
      res.setHeader('Set-Cookie', cookieName + '=' + cookieOptions + '0');
      return json(200, { ok: true });
    }
    if (controlRoutes.has(route)) return json(200, { value: await call(route, data) });
    if (!personalRoutes.has(route)) return json(404, { error: 'Unknown operation' });
    const value = route === '/notifications'
      ? await nextNotifications(data, session, controller.signal)
      : await personalCall(route, data, controller.signal);
    return json(200, { value });
  } catch (error) {
    if (res.destroyed || res.headersSent) return;
    if (['ENOENT', 'ECONNREFUSED', 'ECONNRESET'].includes(error.code)) {
      return json(503, { error: '服务器上的个人助手暂时离线，请稍后重试。' });
    }
    return json(error.status || 400, { error: error.message });
  }
});
server.listen(port, '127.0.0.1');
