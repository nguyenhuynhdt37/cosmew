import {expect, test} from 'bun:test';
import {CodexUsageTracker} from '../../apps/cli/src/subscriptions/codex-usage';

const snapshot = (total: object, last: object = {totalTokens:120}) => ({total,last,modelContextWindow:32000});
const first = {totalTokens:120,inputTokens:100,outputTokens:20,cachedInputTokens:30,cacheWriteInputTokens:10,reasoningOutputTokens:8};

test('Codex cumulative selection rejects duplicate, stale, conflicting and regressive snapshots atomically', () => {
  const tracker = new CodexUsageTracker();
  expect(tracker.observe(snapshot(first))?.usage).toEqual({inputTokens:100,outputTokens:20,costUSD:null,cacheReadTokens:30,cacheWriteTokens:10,reasoningTokens:8});
  expect(tracker.observe(snapshot(first))).toBeNull();
  expect(tracker.observe(snapshot({...first,inputTokens:110}))).toBeNull();
  expect(tracker.observe(snapshot({...first,totalTokens:110}))).toBeNull();
  expect(tracker.observe(snapshot({...first,totalTokens:220,inputTokens:200,cachedInputTokens:20}))).toBeNull();
  expect(tracker.observe(snapshot({...first,totalTokens:220,inputTokens:200,cachedInputTokens:50}))?.usage.inputTokens).toBe(200);
});

test('Codex partial newer snapshots do not carry old component precision or synthesize subsets', () => {
  const tracker = new CodexUsageTracker(); tracker.observe(snapshot(first));
  expect(tracker.observe(snapshot({totalTokens:300,inputTokens:250},{}))).toEqual({usage:{inputTokens:250,outputTokens:null,costUSD:null,cacheReadTokens:null,cacheWriteTokens:null,reasoningTokens:null},usedTokens:null,limitTokens:32000});
  // Missing intermediate components do not erase the regression guard.
  expect(tracker.observe(snapshot({...first,totalTokens:400,inputTokens:300,cachedInputTokens:20}))).toBeNull();
});

test('Codex unsafe, fractional and absent measurements stay unknown; explicit zero remains measured', () => {
  for (const totalTokens of [undefined,null,-1,0.5,Infinity,NaN,Number.MAX_SAFE_INTEGER+1,'120']) {
    expect(new CodexUsageTracker().observe(snapshot({...first,totalTokens}))).toBeNull();
  }
  expect(new CodexUsageTracker().observe(snapshot({totalTokens:120,inputTokens:'100',outputTokens:0.5,cachedInputTokens:-1,reasoningOutputTokens:Infinity}))?.usage).toEqual({inputTokens:null,outputTokens:null,costUSD:null,cacheReadTokens:null,cacheWriteTokens:null,reasoningTokens:null});
  expect(new CodexUsageTracker().observe(snapshot({totalTokens:0,inputTokens:0,outputTokens:0}))?.usage).toMatchObject({inputTokens:0,outputTokens:0,cacheReadTokens:null});
  expect(new CodexUsageTracker().observe(snapshot({...first,cachedInputTokens:101,cacheWriteInputTokens:101,reasoningOutputTokens:21}))?.usage).toMatchObject({inputTokens:100,outputTokens:20,cacheReadTokens:null,cacheWriteTokens:null,reasoningTokens:null});
  const recovering = new CodexUsageTracker();
  recovering.observe(snapshot({...first,cachedInputTokens:101}));
  expect(recovering.observe(snapshot({...first,totalTokens:220,inputTokens:200,cachedInputTokens:50}))?.usage.cacheReadTokens).toBe(50);
});
