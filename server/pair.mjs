import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { home } from './control.mjs';
import { PhoneAuth } from './phone-auth.mjs';
import { phoneOrigin } from './phone-origin.mjs';

process.umask(0o077);
const link = new URL(phoneOrigin());
const auth = new PhoneAuth(path.join(home, 'phones.sqlite'));
try {
  link.hash = new URLSearchParams({ t: auth.invite() }).toString();
} finally { auth.db.close(); }
if (process.argv.includes('--qr')) {
  const result = spawnSync('qrencode', ['-t', 'ANSIUTF8', '-o', '-'], {
    input: link.href, stdio: ['pipe', 'inherit', 'inherit']
  });
  if (result.status !== 0) console.error('Install qrencode for a terminal QR code, or use the link below.');
}
console.log(link.href);
