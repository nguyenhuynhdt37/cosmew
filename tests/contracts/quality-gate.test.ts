import {expect, test} from 'bun:test';
import {testEnvironment} from '../../scripts/test';

test('routine tiers cannot inherit paid generation or native keyring opt-ins', () => {
  const inherited = {COSMEW_LIVE_SUBAGENTS: '1', COSMEW_LIVE_SUBAGENTS_STATE: '/tmp/fixture', HANNES_TEST_KEYRING: '1'};
  for (const tier of ['all', 'native', 'pty', 'integration', 'e2e'] as const) {
    const env = testEnvironment(tier, inherited);
    expect(env.COSMEW_LIVE_SUBAGENTS).toBeUndefined();
    expect(env.COSMEW_LIVE_SUBAGENTS_STATE).toBeUndefined();
    expect(env.HANNES_TEST_KEYRING).toBeUndefined();
  }
  expect(inherited.COSMEW_LIVE_SUBAGENTS).toBe('1');
});

test('live tier requires both an explicit opt-in and disposable fixture state', () => {
  expect(() => testEnvironment('live', {})).toThrow('may bill');
  expect(() => testEnvironment('live', {COSMEW_LIVE_SUBAGENTS: '1'})).toThrow('may bill');
  expect(testEnvironment('live', {COSMEW_LIVE_SUBAGENTS: '1', COSMEW_LIVE_SUBAGENTS_STATE: '/tmp/fixture'})).toEqual({
    COSMEW_LIVE_SUBAGENTS: '1',
    COSMEW_LIVE_SUBAGENTS_STATE: '/tmp/fixture',
  });
});
