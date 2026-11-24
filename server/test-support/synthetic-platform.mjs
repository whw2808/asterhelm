// Loaded only in integration-test workers. This platform has no external GPU probe.
import os from 'node:os';
os.platform = () => 'freebsd';
os.machine = () => 'test-cpu';
