import {expect, test} from 'bun:test';
import {FrameScheduler} from '../../apps/tui/src/render/frame-scheduler';

test('provider bursts coalesce; input preempts; idle has no pending frames', async () => {
  const frames: string[][] = [];
  const scheduler = new FrameScheduler(regions => {
    frames.push([...regions]);
  });
  for (let i = 0; i < 1000; i++) scheduler.request('transcript');
  scheduler.request('composer', true);
  await Bun.sleep(8);
  expect(frames).toHaveLength(1);
  expect(frames[0]).toContain('composer');
  expect(frames[0]).toContain('transcript');
  await Bun.sleep(40);
  expect(frames).toHaveLength(1);
  scheduler.request('status');
  scheduler.dispose();
  await Bun.sleep(20);
  expect(frames).toHaveLength(1);
});

test('output backpressure retains one dirty frame and resumes with the latest state', async () => {
  let frames = 0;
  const scheduler = new FrameScheduler(() => {
    frames++;
  });
  scheduler.setBlocked(true);
  for (let i = 0; i < 1000; i++) scheduler.request('transcript');
  await Bun.sleep(30);
  expect(frames).toBe(0);
  scheduler.setBlocked(false);
  await Bun.sleep(30);
  expect(frames).toBe(1);
  scheduler.dispose();
});
