import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {guardConfigured} from './codex-guard-readiness.mjs';

test('a new thread can use reviewed hooks without a previous tool call and revoked trust holds the next receipt', async t => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'asterhelm-hook-inventory-'));
  t.after(() => rmSync(cwd, {recursive: true, force: true}));
  const codexExecutable = path.join(cwd, 'fixture-codex');
  writeFileSync(codexExecutable, `#!/usr/bin/env node
    const fs = require('node:fs');
    const path = require('node:path');
    const lines = require('node:readline').createInterface({input: process.stdin});
    lines.on('line', text => {
      const {id, method, params} = JSON.parse(text);
      if (method === 'initialize') console.log(JSON.stringify({id, result: {}}));
      if (method === 'hooks/list') {
        const cwd = params.cwds[0];
        const data = JSON.parse(fs.readFileSync(path.join(cwd, 'inventory.json'), 'utf8'));
        console.log(JSON.stringify({id, result: {data}}));
      }
    });`, {mode: 0o700});
  const guardCommand = '/usr/bin/node /opt/example/receipt-guard.mjs';
  const options = {codexHome: cwd, cwd, codexExecutable, guardCommand};
  const hooks = ['userPromptSubmit', 'preToolUse', 'stop'].map(eventName => ({
    eventName, handlerType: 'command', command: guardCommand, enabled: true,
    async: false, matcher: null, trustStatus: 'trusted',
  }));
  function inventory(entries) {
    writeFileSync(path.join(cwd, 'inventory.json'), JSON.stringify(entries));
  }
  inventory([{cwd, hooks, errors: []}]);
  assert.equal(await guardConfigured(options), true);
  for (const override of [{trustStatus: 'untrusted'}, {command: '/bin/true'}, {matcher: 'Bash'}, {async: true}]) {
    inventory([{cwd, hooks: [hooks[0], {...hooks[1], ...override}, hooks[2]], errors: []}]);
    assert.equal(await guardConfigured(options), false);
  }
  inventory([{cwd: '/different', hooks, errors: []}]);
  assert.equal(await guardConfigured(options), false);
});
