import path from 'node:path';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';

// Query the effective hooks for the original workspace. The discovery process
// never opens or resumes the conversation and never starts a model turn.
export function guardConfigured({codexExecutable, codexHome, cwd, guardCommand}) {
  if (!path.isAbsolute(cwd || '') || !guardCommand) return Promise.resolve(false);
  return new Promise(resolve => {
    const child = spawn(codexExecutable || 'codex', ['app-server', '--stdio'], {
      env: {...process.env, CODEX_HOME: codexHome},
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const lines = createInterface({input: child.stdout});
    const timer = setTimeout(() => finish(false), 4000);
    function finish(ready) {
      clearTimeout(timer);
      lines.close();
      child.kill();
      resolve(ready);
    }
    const send = payload => child.stdin.write(JSON.stringify(payload) + '\n');
    child.on('error', () => finish(false));
    child.on('exit', () => finish(false));
    child.stdin.on('error', () => finish(false));
    lines.on('line', line => {
      try {
        const response = JSON.parse(line);
        if (response.id === 1) {
          if (response.error) return finish(false);
          send({method: 'initialized'});
          send({id: 2, method: 'hooks/list', params: {cwds: [cwd]}});
        } else if (response.id === 2) {
          const entry = response.result?.data?.find(group => group.cwd === cwd);
          const ready = entry && !entry.errors?.length && ['userPromptSubmit', 'preToolUse', 'stop'].every(
            event => entry.hooks.some(hook => hook.eventName === event && hook.handlerType === 'command'
              && hook.command === guardCommand && hook.enabled === true && hook.async === false
              && !hook.matcher && hook.trustStatus === 'trusted'),
          );
          finish(Boolean(ready));
        }
      } catch {
        finish(false);
      }
    });
    send({id: 1, method: 'initialize', params: {
      clientInfo: {name: 'asterhelm_hook_discovery', version: '1'}, capabilities: {experimentalApi: true},
    }});
  });
}
