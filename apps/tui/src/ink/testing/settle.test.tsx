/** @jsxImportSource react */
import {afterEach, expect, test} from 'bun:test';
import {cleanup} from 'ink-testing-library';
import {Text} from 'ink';
import {useEffect, useState} from 'react';
import {renderInk, settle} from './index';

afterEach(cleanup);

test('settle drains effects and timer/promise work across multiple paints', async () => {
  function Delayed() {
    const [step, setStep] = useState(0);
    useEffect(() => {
      if (step === 3) return;
      const timer = setTimeout(() => void Promise.resolve().then(() => setStep(step + 1)), 20);
      return () => clearTimeout(timer);
    }, [step]);
    return <Text>step {step}</Text>;
  }
  const view = renderInk(<Delayed />);
  await settle(0, 2000, {quietMs: 45});
  expect(view.lastFrame()).toContain('step 3');
});

test('settle observes identical-text repaints', async () => {
  const {trackFrames} = await import('./wait');
  const frames = ['unchanged'];
  const view = trackFrames({frames, lastFrame: () => frames.at(-1)});
  const timer = setInterval(() => {
    frames.push('unchanged');
    if (frames.length === 4) clearInterval(timer);
  }, 20);
  try {
    await settle(0, 2000, {quietMs: 45});
    expect(view.frames).toHaveLength(4);
  } finally {
    clearInterval(timer);
  }
});

test('settle preserves a caller-specified minimum wait', async () => {
  const started = performance.now();
  await settle(60);
  expect(performance.now() - started).toBeGreaterThanOrEqual(60);
});

test('settle times out on continuous paints instead of returning a stale frame', async () => {
  const {trackFrames} = await import('./wait');
  const frames = ['painting'];
  const view = trackFrames({frames, lastFrame: () => frames.at(-1)});
  const timer = setInterval(() => frames.push('painting'), 5);
  try {
    await expect(settle(0, 90, {quietMs: 45})).rejects.toThrow('Ink did not settle within 90ms');
    expect(view.frames.length).toBeGreaterThan(1);
  } finally {
    clearInterval(timer);
  }
});

test('waitForFrame waits beyond a quiet frame and reports the last frame on timeout', async () => {
  const {waitForFrame} = await import('./wait');
  const view = renderInk(<Text>before</Text>);
  const timer = setTimeout(() => view.rerender(<Text>after</Text>), 100);
  try {
    expect(await waitForFrame(view, frame => frame.includes('after'))).toContain('after');
    await expect(waitForFrame(view, frame => frame.includes('missing'), 30)).rejects.toThrow('last frame:\nafter');
  } finally {
    clearTimeout(timer);
  }
});
