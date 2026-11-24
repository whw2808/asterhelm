import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isIP } from 'node:net';

export const home = path.resolve(process.env.ASTERHELM_HOME || process.env.SUPER_AGENT_HOME || path.join(os.homedir(), '.asterhelm'));
export const brokerFile = path.join(home, 'broker.json');
export const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));

export function privateDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077)) {
    throw Error('Use a directory owned by your account with mode 0700: ' + dir);
  }
}

export function writeNewJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}

export function deviceId(value) {
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(value ?? '')) {
    throw Error('Choose a device ID of up to 63 lowercase letters, numbers, underscores or hyphens, starting with a letter or digit.');
  }
  return value;
}

export function hostName(value) {
  if (typeof value !== 'string' || value.length > 253 || !(isIP(value) === 4 || value.split('.').every(
    label => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label)))) {
    throw Error('Use a DNS hostname or an IPv4 address for the broker host.');
  }
  return value;
}

export function portNumber(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Choose a port from 1 to 65535.');
  return port;
}
