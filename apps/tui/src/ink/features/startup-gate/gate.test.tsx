/** @jsxImportSource react */
import {afterEach, expect, test} from 'bun:test';
import {cleanup} from 'ink-testing-library';
import {FutrynError, ProviderBillingError} from '@cosmew/contracts';
import {InkApp} from '../../app';
import {createClientFixture, render, waitForFrame} from '../../testing';
import {account, dialogFixture, selection} from '../picker/test-fixture';
afterEach(cleanup);

const ready = (view: {lastFrame(): string | undefined}) =>
  waitForFrame(view, frame => frame.includes('manual mode on'));

test('a signed-out user reaches the composer and a send keeps the draft without touching the provider', async () => {
  let probes = 0;
  const {client} = createClientFixture({
    validateAccount: async () => {
      probes++;
      throw new Error('Unexpected request');
    },
  });
  client.trustWorkspace();
  const view = render(<InkApp client={client} width={90} />);
  await ready(view);
  view.stdin.write('keep this draft');
  await waitForFrame(view, frame => frame.includes('keep this draft'));
  view.stdin.write('\r');
  await waitForFrame(view, frame => frame.includes('Sign in to send') && frame.includes('Connect · provider'));
  view.stdin.write('\x1b');
  await waitForFrame(view, frame => frame.includes('keep this draft') && !frame.includes('Connect · provider'));
  expect(probes).toBe(0);
});

test('trusted launch makes no probe and the first submitted prompt verifies before sending', async () => {
  const calls: string[] = [];
  const {client} = dialogFixture({
    validateAccount: async (_account, _signal, generate) => {
      calls.push(generate ? 'verify' : 'catalog');
      return {models: 1, validation: 'fixture'};
    },
    startSession: () => ({id: 'fixture-session', selection, messages: []}),
    async *sendTurn(_id, content) {
      calls.push(content);
      yield {type: 'textDelta', text: 'Fixture reply'};
    },
  });
  client.trustWorkspace();
  const view = render(<InkApp client={client} width={90} />);
  await ready(view);
  expect(calls).toEqual([]);
  for (const prompt of ['first prompt', 'second prompt']) {
    view.stdin.write(prompt);
    await waitForFrame(view, frame => frame.includes(prompt));
    view.stdin.write('\r');
    await waitForFrame(view, frame => calls.includes(prompt) && frame.includes('Fixture reply'));
  }
  expect(calls).toEqual(['verify', 'first prompt', 'second prompt']);
});

test('rejected credentials show a safe reason and the account picker while retaining the draft', async () => {
  let probes = 0;
  const {client} = dialogFixture({
    validateAccount: async () => {
      probes++;
      throw new FutrynError('AUTH');
    },
  });
  client.trustWorkspace();
  const view = render(<InkApp client={client} width={90} />);
  await ready(view);
  view.stdin.write('save this draft');
  await waitForFrame(view, frame => frame.includes('save this draft'));
  view.stdin.write('\r');
  await waitForFrame(
    view,
    frame => frame.includes('Account access was rejected') && frame.includes('Connect · accounts'),
  );
  view.stdin.write('\x1b');
  await waitForFrame(view, frame => frame.includes('save this draft') && !frame.includes('Connect · accounts'));
  expect(await client.verifyAccount()).toEqual({ok: false, reason: 'auth'});
  expect(probes).toBe(1);
});

test('verification shares in-flight work and scopes results by model and credential generation', async () => {
  let selected = selection;
  const checked: Array<[string | undefined, number | undefined]> = [];
  const fixture = dialogFixture({
    resolveSelection: () => selected,
    validateAccount: async target => {
      checked.push([target.defaultModel, target.authGeneration]);
      return {models: 1, validation: 'fixture'};
    },
  });
  const {client} = fixture;
  expect(await Promise.all([client.verifyAccount(), client.verifyAccount()])).toEqual([{ok: true}, {ok: true}]);
  selected = {...selected, modelId: 'other-model'};
  expect(await client.verifyAccount()).toEqual({ok: true});
  fixture.settings.accounts = [{...account, authGeneration: 2}];
  expect(await client.verifyAccount()).toEqual({ok: true});
  selected = selection;
  expect(await client.verifyAccount()).toEqual({ok: true});
  expect(checked).toEqual([
    [selection.modelId, undefined],
    ['other-model', undefined],
    ['other-model', 2],
    [selection.modelId, 2],
  ]);
});

test('first-send billing failure shows the provider hint and account actions while keeping the draft', async () => {
  const {client} = dialogFixture({
    validateAccount: async () => {
      throw new ProviderBillingError('Add credits at https://grok.com/');
    },
  });
  client.trustWorkspace();
  const view = render(<InkApp client={client} width={110} />);
  await ready(view);
  view.stdin.write('billing draft');
  await waitForFrame(view, frame => frame.includes('billing draft'));
  view.stdin.write('\r');
  const frame = await waitForFrame(view, frame => frame.includes('Connect · accounts'));
  expect(frame.replace(/\s+/g, ' ')).toContain('Personal is out of credits or needs a subscription.');
  expect(frame.replace(/\s+/g, ' ')).toContain('Provider says: Add credits at https://grok.com/');
  expect(frame.replace(/\s+/g, ' ')).toContain('Your draft is still here.');
  view.stdin.write('\x1b');
  await waitForFrame(view, frame => frame.includes('billing draft') && !frame.includes('Connect · accounts'));
});
