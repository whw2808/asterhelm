#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { isIP } from 'node:net';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { home, brokerFile, deviceId, hostName, portNumber, privateDirectory, readJson, writeNewJson } from './settings.mjs';

process.umask(0o077);
const pki = path.join(home, 'pki');
const usage = `Usage: node scripts/pki.mjs <command>
  init --host HOST --bind IP [--port PORT]    Hub: create a private CA and enable the broker listener
  request --device ID                        Worker: generate a local private key and certificate request
  sign --device ID --csr FILE                Hub: check the requested identity and issue a client certificate
See docs/self-hosting.md for certificate transfer and trust boundaries.`;

function options(args, names) {
  return parseArgs({ args, options: Object.fromEntries(names.map(name => [name, { type: 'string' }])) }).values;
}

function openssl(...args) {
  return execFileSync('openssl', args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 120000 });
}

function inStaging(parent, action) {
  const temp = fs.mkdtempSync(path.join(parent, '.provision-'));
  try { return action(temp); }
  finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

function generateRequest(dir, name, commonName) {
  const key = path.join(dir, name + '.key');
  const csr = path.join(dir, name + '.csr');
  openssl('genrsa', '-out', key, '3072');
  openssl('req', '-new', '-sha256', '-key', key, '-subj', '/CN=' + commonName, '-out', csr);
  return csr;
}

function issue(caDir, temp, request, output, extensions) {
  const ext = path.join(temp, 'extensions.cnf');
  fs.writeFileSync(ext, extensions.join('\n') + '\n');
  openssl('x509', '-req', '-in', request, '-CA', path.join(caDir, 'ca.crt'), '-CAkey', path.join(caDir, 'ca.key'),
    '-set_serial', '0x' + randomBytes(16).toString('hex'), '-days', '365', '-sha256', '-extfile', ext, '-out', output);
}

function initialize(opts) {
  const cfg = readJson(brokerFile);
  const host = hostName(opts.host);
  if (!isIP(opts.bind || '')) throw Error('Set --bind to the IP address for the broker listener.');
  const port = portNumber(opts.port || 42851);
  if (fs.existsSync(pki) || cfg.bind || cfg.port) throw Error('The broker has existing TLS files or listener settings. Keep the original CA and check broker.json.');
  inStaging(home, temp => {
    const keys = path.join(temp, 'pki');
    privateDirectory(keys);
    const caConfig = path.join(temp, 'ca.cnf');
    fs.writeFileSync(caConfig, '[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ca\n[dn]\nCN=Asterhelm private worker CA\n[ca]\nbasicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\n');
    const caKey = path.join(keys, 'ca.key');
    openssl('genrsa', '-out', caKey, '3072');
    openssl('req', '-new', '-x509', '-sha256', '-days', '3650', '-key', caKey, '-config', caConfig, '-out', path.join(keys, 'ca.crt'));
    const request = generateRequest(temp, 'router', 'Asterhelm worker broker');
    issue(keys, temp, request, path.join(keys, 'router.crt'), [
      'basicConstraints=critical,CA:FALSE', 'keyUsage=critical,digitalSignature,keyEncipherment',
      'extendedKeyUsage=serverAuth', 'subjectAltName=' + (isIP(host) ? 'IP:' : 'DNS:') + host,
    ]);
    fs.renameSync(path.join(temp, 'router.key'), path.join(keys, 'router.key'));
    const pending = path.join(temp, 'broker.json');
    writeNewJson(pending, { ...cfg, bind: opts.bind, port });
    fs.renameSync(keys, pki);
    fs.renameSync(pending, brokerFile);
  });
  console.log('Created broker certificate for ' + host + '. Restart the hub to listen on ' + opts.bind + ':' + port + '.');
}

function request(opts) {
  const id = deviceId(opts.device);
  privateDirectory(pki);
  const key = path.join(pki, 'client.key');
  const csr = path.join(pki, 'client.csr');
  if (fs.existsSync(key) || fs.existsSync(csr)) throw Error('A client key or request already exists in ' + pki);
  inStaging(pki, temp => {
    generateRequest(temp, 'client', id);
    fs.linkSync(path.join(temp, 'client.key'), key);
    fs.linkSync(path.join(temp, 'client.csr'), csr);
  });
  console.log('Send this certificate request to the hub owner: ' + csr);
}

function sign(opts) {
  const id = deviceId(opts.device);
  if (!opts.csr) throw Error('Signing requires --csr FILE.');
  const csr = fs.realpathSync(opts.csr);
  privateDirectory(pki);
  const issued = path.join(pki, 'issued');
  privateDirectory(issued);
  inStaging(issued, temp => {
    const checked = path.join(temp, 'client.csr');
    fs.copyFileSync(csr, checked);
    const subject = openssl('req', '-in', checked, '-noout', '-verify', '-subject', '-nameopt', 'RFC2253').trim();
    if (subject.replace(/^subject=\s*/, '') !== 'CN=' + id) throw Error('The request subject must contain only the selected device ID as its common name.');
    const certificate = path.join(temp, 'client.crt');
    issue(pki, temp, checked, certificate, [
      'basicConstraints=critical,CA:FALSE', 'keyUsage=critical,digitalSignature', 'extendedKeyUsage=clientAuth',
    ]);
    const file = path.join(issued, id + '.crt');
    fs.linkSync(certificate, file);
    console.log('Issued ' + file + '. Send this certificate and ca.crt to that worker.');
  });
}

try {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === '--help') console.log(usage);
  else {
    privateDirectory(home);
    if (command === 'init') initialize(options(args, ['host', 'bind', 'port']));
    else if (command === 'request') request(options(args, ['device']));
    else if (command === 'sign') sign(options(args, ['device', 'csr']));
    else throw Error(usage);
  }
} catch (error) {
  console.error(error.stderr?.trim() || error.message);
  process.exitCode = 1;
}
