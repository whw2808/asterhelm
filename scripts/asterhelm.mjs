#!/usr/bin/env node
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { home, brokerFile, deviceId, hostName, portNumber, privateDirectory, readJson, writeNewJson } from './settings.mjs';

process.umask(0o077);
const server = fileURLToPath(new URL('../server/', import.meta.url));
const workerDir = path.join(home, 'workers');
const usage = `Usage: node scripts/asterhelm.mjs <command>

  init [--device hub]                    Initialize a hub in ASTERHELM_HOME (default ~/.asterhelm)
  hub                                    Run the broker, personal service and phone gateway
  configure-worker --adapter ADAPTER     Create a worker config and print its path
      [--device ID] [--write] [--model MODEL] [--executable FILE]
      [--server HOST --port PORT]        Connect to a remote broker with mutual TLS
      [--dsh-entry FILE --dsh-home DIR --dsh-patch FILE]    Required for deepseek
  worker TARGET                          Run the configured worker in the foreground
  pair [--qr]                            Print a single-use phone invitation

Adapters: check (counts input bytes offline), codex, deepseek.
See docs/self-hosting.md for HTTPS, model credentials and certificate provisioning.`;

function options(args, strings, flags = []) {
  return parseArgs({ args, options: Object.fromEntries([
    ...strings.map(k => [k, { type: 'string' }]),
    ...flags.map(k => [k, { type: 'boolean' }]),
  ]) }).values;
}

function fileOption(opts, key, directory = false) {
  if (!opts[key]) throw Error('DeepSeek Harness requires --' + key);
  const file = fs.realpathSync(opts[key]);
  const stat = fs.statSync(file);
  if (directory ? !stat.isDirectory() : !stat.isFile()) throw Error('Invalid --' + key);
  return file;
}

function configureWorker(args) {
  const opts = options(args, ['adapter', 'device', 'model', 'executable', 'server', 'port', 'dsh-entry', 'dsh-home', 'dsh-patch'], ['write']);
  const adapter = opts.adapter;
  if (!['check', 'codex', 'deepseek'].includes(adapter)) throw Error('Choose --adapter check, codex or deepseek.');
  if (opts.server && !opts.device) throw Error('A remote worker requires --device matching its certificate.');
  if (!opts.server && opts.port) throw Error('--port requires --server.');
  const id = opts.server ? deviceId(opts.device) : deviceId(readJson(brokerFile).localDeviceId);
  if (opts.device && opts.device !== id) throw Error('A local worker must use the hub device ID.');
  if (adapter === 'check' && (opts.write || opts.executable)) throw Error('The check adapter only counts bytes with /usr/bin/wc.');
  if (adapter !== 'codex' && opts.model) throw Error('--model applies to Codex. DeepSeek reads the model selected in its profile.');
  if (adapter !== 'deepseek' && Object.keys(opts).some(key => key.startsWith('dsh-'))) throw Error('DSH paths require --adapter deepseek.');
  const target = id + '.' + adapter;
  const dir = path.join(workerDir, target);
  const capabilities = ['read-only'];
  if (adapter !== 'check') capabilities.push('handoff');
  if (opts.write) capabilities.push('workspace-write');
  const names = { check: 'Input byte counter', codex: 'Codex', deepseek: 'DeepSeek Harness' };
  const cfg = {
    target, adapter: adapter === 'check' ? 'command' : adapter,
    registration: {
      deviceId: id, deviceName: id, platform: process.platform, target,
      agentName: names[adapter], kind: adapter === 'check' ? 'command' : adapter,
      capabilities, contextSources: [],
    },
    workspace: path.join(dir, 'workspaces'), state: path.join(dir, 'state'), reportHardware: false,
  };
  if (adapter === 'check') {
    cfg.executable = '/usr/bin/wc';
    cfg.argsByMode = { 'read-only': ['-c'] };
  } else if (adapter === 'codex') {
    cfg.executable = opts.executable || 'codex';
    cfg.disableNestedBroker = true;
    if (opts.model) cfg.model = opts.model;
  } else {
    cfg.executable = opts.executable || process.execPath;
    cfg.dshEntry = fileOption(opts, 'dsh-entry');
    cfg.dshPatch = fileOption(opts, 'dsh-patch');
    cfg.env = { DSH_HOME: fileOption(opts, 'dsh-home', true) };
  }
  if (opts.server) {
    const pki = path.join(home, 'pki');
    Object.assign(cfg, { server: hostName(opts.server), port: portNumber(opts.port || 42851),
      ca: path.join(pki, 'ca.crt'), cert: path.join(pki, 'client.crt'), key: path.join(pki, 'client.key') });
    for (const file of [cfg.ca, cfg.cert, cfg.key]) fs.accessSync(file, fs.constants.R_OK);
  }
  privateDirectory(dir);
  const file = path.join(dir, 'worker.json');
  writeNewJson(file, cfg);
  console.log(file);
}

function holdLock(file) {
  // SQLite releases the transaction when the supervising process exits, including after a crash.
  const db = new DatabaseSync(file);
  try { db.exec('BEGIN EXCLUSIVE'); }
  catch (error) {
    db.close();
    if (error.errcode === 5) throw Error('Another process already owns ' + file);
    throw error;
  }
  return db;
}

function socketInUse(socketPath) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', error => {
      if (['ENOENT', 'ECONNREFUSED'].includes(error.code)) resolve(false);
      else reject(error);
    });
  });
}

async function run(entries, env) {
  const children = new Set();
  let stopping = false;
  let exitCode = 0;
  function stop(code = 0) {
    if (stopping) return;
    stopping = true;
    exitCode = code;
    for (const child of children) child.kill('SIGTERM');
  }
  const onSignal = () => stop();
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    await Promise.all(entries.map(args => new Promise(resolve => {
      const child = spawn(process.execPath, [path.join(server, args[0] + '.mjs'), ...args.slice(1)], { env, stdio: 'inherit' });
      children.add(child);
      child.once('error', error => { console.error(error.message); stop(1); });
      child.once('close', (code, signal) => {
        children.delete(child);
        stop(code ?? (signal === 'SIGTERM' || signal === 'SIGINT' ? 0 : 1));
        resolve();
      });
    })));
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
  return exitCode;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === '--help' || command === 'help') { console.log(usage); return; }
  privateDirectory(home);
  const env = { ...process.env, ASTERHELM_HOME: home, SUPER_AGENT_HOME: home };
  env.ASTERHELM_PUBLIC_ORIGIN ||= env.SUPER_AGENT_PHONE_ORIGIN || 'https://localhost';
  switch (command) {
    case 'init': {
      const opts = options(args, ['device']);
      writeNewJson(brokerFile, { localDeviceId: deviceId(opts.device || 'hub') });
      console.log('Initialized ' + brokerFile);
      return;
    }
    case 'configure-worker': return configureWorker(args);
    case 'pair': {
      const opts = options(args, [], ['qr']);
      fs.accessSync(brokerFile);
      process.exitCode = await run([opts.qr ? ['pair', '--qr'] : ['pair']], env);
      return;
    }
    case 'hub': {
      options(args, []);
      fs.accessSync(brokerFile);
      const lock = holdLock(path.join(home, 'hub.lock.sqlite'));
      try {
        for (const name of ['control.sock', 'personal.sock']) {
          if (await socketInUse(path.join(home, name))) throw Error('A service is already running on ' + name);
        }
        if (!env.PERSONAL_AGENT_ENGINE) {
          if (env.PERSONAL_AGENT_DSH_CONFIG) env.PERSONAL_AGENT_ENGINE = 'dsh';
          else if (env.PERSONAL_AGENT_API_URL || env.PERSONAL_AGENT_API_KEY || env.PERSONAL_AGENT_MODEL) env.PERSONAL_AGENT_ENGINE = 'chat-api';
          else env.PERSONAL_AGENT_ENGINE = 'offline';
        }
        console.log('Phone origin ' + env.ASTERHELM_PUBLIC_ORIGIN + ' | planner ' + env.PERSONAL_AGENT_ENGINE);
        process.exitCode = await run([['broker'], ['personal-service'], ['phone']], env);
      } finally { lock.close(); }
      return;
    }
    case 'worker': {
      if (args.length !== 1 || !/^[a-z0-9][a-z0-9_-]{0,62}\.(check|codex|deepseek)$/.test(args[0])) throw Error('Supply the target created by configure-worker, e.g. hub.codex.');
      const dir = path.join(workerDir, args[0]);
      const file = path.join(dir, 'worker.json');
      fs.accessSync(file);
      const lock = holdLock(path.join(dir, 'worker.lock.sqlite'));
      try { process.exitCode = await run([['worker', file]], env); }
      finally { lock.close(); }
      return;
    }
    default: throw Error(usage);
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
