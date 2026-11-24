import { Queue } from '../queue.mjs';

// Synthetic identities shared by the queue, attachment, and context tests.
export function configuredQueue(file) {
  const queue = new Queue(file, 'desk');
  for (const deviceId of ['desk', 'bench']) {
    queue.registry.register(deviceId === 'desk' ? 'local' : 'cert:bench', {
      deviceId, deviceName: deviceId, platform: 'Linux', target: deviceId + '.code',
      agentName: 'Example agent', kind: 'codex',
      capabilities: ['read-only', 'workspace-write', 'contexts', 'handoff'],
      contextSources: ['Codex CLI', 'Codex Desktop']
    });
  }
  return queue;
}
