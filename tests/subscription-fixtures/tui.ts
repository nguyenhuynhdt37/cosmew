/** Actual TUI launcher with deterministic provider runtime/vault fixtures for CI. */
import { resolve } from 'node:path';
import { startup } from '../../apps/cli/src/bootstrap/startup';
import { runInteractiveTui } from '@futryn/tui';
import { memoryVault } from '../fixtures';
const app = startup(process.env.FUTRYN_TEST_HOME!, { vault: memoryVault(), subscriptions: {
  nativeRuntimeTools: process.env.FUTRYN_TEST_NATIVE === '1',
  openURL: async () => {},
  resolveCommand: runtime => ({ command: process.execPath, prefix: [resolve('tests/subscription-fixtures/runtime.ts'), runtime, process.env.FUTRYN_TEST_SCENARIO ?? 'normal'] }),
} });
try { await runInteractiveTui({ client: app.createFutrynClient(process.env.FUTRYN_TEST_WORKSPACE ?? process.env.FUTRYN_TEST_HOME!) }); }
finally { await app.subscriptions.shutdown(); app.db.close(); }
