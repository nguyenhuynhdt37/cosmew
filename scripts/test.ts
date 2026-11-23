/** One test entry point: product roots by default, explicit host/live reruns. */
export const testTiers = {
  all: ['tests', 'apps', 'packages'],
  integration: ['tests/contracts/provider-adapters.test.ts', 'tests/security'],
  e2e: ['tests/end-to-end'],
  native: [
    'tests/security',
    'tests/end-to-end/native-agent.test.ts',
    'tests/end-to-end/exec-command.test.ts',
    'tests/end-to-end/headless-exec.test.ts',
    'tests/end-to-end/lsp.test.ts',
  ],
  pty: ['tests/end-to-end/tui-ink-pty.test.ts', 'apps/tui/src/ink/testing/native-pty.test.ts'],
  live: ['tests/end-to-end/subagent-live-provider.test.ts'],
} as const;

export function testEnvironment(tier: keyof typeof testTiers, inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = {...inherited};
  if (tier === 'live') {
    if (env.COSMEW_LIVE_SUBAGENTS !== '1' || !env.COSMEW_LIVE_SUBAGENTS_STATE) {
      throw new Error('Live tests may bill: explicitly set COSMEW_LIVE_SUBAGENTS=1 and COSMEW_LIVE_SUBAGENTS_STATE.');
    }
  } else {
    // An inherited opt-in must never turn a routine quality check into paid generation.
    delete env.COSMEW_LIVE_SUBAGENTS;
    delete env.COSMEW_LIVE_SUBAGENTS_STATE;
  }
  // OS credential stores are a separate manual acceptance check, never routine CI.
  delete env.HANNES_TEST_KEYRING;
  return env;
}

if (import.meta.main) {
  const tier = process.argv[2] ?? 'all';
  if (!Object.hasOwn(testTiers, tier)) throw new Error(`Unknown test tier: ${tier}`);
  const selected = tier as keyof typeof testTiers;
  console.error(`Test tier: ${selected}; OS=${process.platform}; unsupported host checks report skips.`);
  const child = Bun.spawn([process.execPath, 'test', ...testTiers[selected]], {
    env: testEnvironment(selected, process.env),
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal));
  process.exitCode = await child.exited;
}
