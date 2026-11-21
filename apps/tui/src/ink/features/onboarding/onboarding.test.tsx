/** @jsxImportSource react */
import {afterEach, expect, test} from 'bun:test';
import {defaultAppearance} from '@cosmew/contracts';
import {cleanup} from 'ink-testing-library';
import {createClientFixture, renderInk, waitForFrame} from '../../testing';
import {StartupGate, useStartupGate} from '../startup-gate';
import {nextStep} from './logic';
afterEach(cleanup);

test('completed steps and an existing account determine the first missing step', () => {
  expect(nextStep([], false)).toBe('theme');
  expect(nextStep(['theme'], false)).toBe('auth');
  expect(nextStep([], true)).toBe('theme');
  expect(nextStep(['theme'], true)).toBe('security');
  expect(nextStep(['theme', 'auth', 'security'], false)).toBeUndefined();
});

for (const width of [80, 40]) {
  test(`onboarding resumes at Connect and goes through security before trust at ${width} columns`, async () => {
    const completed: string[] = [];
    const fixture = createClientFixture({
      appearanceStore: {
        read: defaultAppearance,
        write: () => {},
        onboardingState: () => ({completed, hasStoredTheme: false}),
        completeOnboardingStep: step => {
          completed.push(step);
        },
      },
    });
    function Gate() {
      const gate = useStartupGate({onReady() {}, onExit() {}});
      return <StartupGate state={gate} width={width} />;
    }
    const view = renderInk(<Gate />, {fixture});
    const step = (v: typeof view, title: string, prompt: string) =>
      waitForFrame(v, frame => frame.includes(title) && frame.includes(prompt));
    const theme = await step(view, "Let's get started.", 'To change this later, run /theme');
    view.stdin.write('\r');
    await step(view, 'Connect', 'Skip for now');
    expect(completed).toEqual(['theme']);
    view.unmount();

    const resumed = renderInk(<Gate />, {fixture});
    const auth = await step(resumed, 'Connect', '❯ Skip for now');
    resumed.stdin.write('\r');
    const security = await step(resumed, 'Security notes:', 'Enter to continue');
    expect(completed).toEqual(['theme', 'auth']);
    expect(resumed.lastFrame()).toContain('Cosmew can make mistakes.');
    expect(resumed.lastFrame()).toContain('prompt injection');
    resumed.stdin.write('\r');
    const trust = await step(resumed, 'Accessing workspace:', 'Enter to confirm');
    expect([theme, auth, security, trust].join('\n\n')).toMatchSnapshot();
    expect(completed).toEqual(['theme', 'auth', 'security']);
  });
}

test('an existing account and stored theme see the security notes once', async () => {
  const completed = new Set<string>();
  const fixture = createClientFixture({
    listAccounts: () => [
      {
        id: 'existing',
        alias: 'Existing',
        providerId: 'fixture',
        credential: {kind: 'none'},
        status: 'valid',
        validatedAt: null,
      },
    ],
    appearanceStore: {
      read: defaultAppearance,
      write() {},
      onboardingState: () => ({completed: [...completed], hasStoredTheme: true}),
      completeOnboardingStep: id => {
        completed.add(id);
      },
    },
  });
  function Gate() {
    const state = useStartupGate({onReady() {}, onExit() {}});
    return <StartupGate state={state} width={80} />;
  }
  const view = renderInk(<Gate />, {fixture});
  await waitForFrame(view, frame => frame.includes('Security notes:') && frame.includes('Enter to continue'));
  expect(view.frames.join('\n')).not.toMatch(/Let's get started|Skip for now/);
  view.stdin.write('\r');
  await waitForFrame(view, frame => frame.includes('Accessing workspace:'));
  expect([...completed]).toEqual(['theme', 'auth', 'security']);
  view.unmount();
  const restarted = renderInk(<Gate />, {fixture});
  await waitForFrame(restarted, frame => frame.includes('Accessing workspace:'));
  expect(restarted.frames.join('\n')).not.toContain('Security notes:');
});
