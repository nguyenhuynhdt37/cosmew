import {afterEach, expect, spyOn, test} from 'bun:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {providerSchema} from '@cosmew/contracts';
import {startup} from '../../apps/cli/src/bootstrap/startup';
import {runExec} from '../../apps/cli/src/exec';
import {needsEffortMetadata, sharedModelMetadata} from '../../apps/cli/src/bootstrap/model-metadata';
import {normalizeModel} from '@cosmew/models';
import {memoryVault} from '../fixtures';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const metadata = {
  xai: {models: {'grok-4.7': {reasoning_options: [{type: 'effort', values: ['low', 'medium', 'high', 'xhigh']}]}}},
};
async function fixture(options: {offline?: boolean; fail?: boolean; inject?: boolean; metadataAge?: number} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'metadata-refresh-'));
  let calls = 0;
  let finish!: () => void;
  const app = startup(join(root, 'state'), {
    vault: memoryVault(),
    offline: options.offline,
    ...(options.inject === false
      ? {}
      : {
          modelsDevFetch: (async () => {
            calls++;
            await new Promise<void>(resolve => {
              finish = resolve;
            });
            if (options.fail) throw new Error('fixture failure');
            return Response.json(metadata);
          }) as unknown as typeof fetch,
        }),
  });
  cleanups.push(async () => {
    await app.shutdownCommands();
    app.db.close();
    rmSync(root, {recursive: true, force: true});
  });
  app.registry.add(
    providerSchema.parse({
      id: 'xai',
      name: 'xAI',
      baseURL: 'https://api.x.ai/v1',
      protocol: 'chat',
      auth: 'none',
      catalog: 'manual',
      metadataVersion: 1,
    }),
  );
  const account = await app.accounts.add('xai', 'xai', {kind: 'none'});
  const model = app.catalog(account).manual('grok-4.7');
  app.router.select(account, model);
  if (options.metadataAge !== undefined)
    app.settings.update(s => {
      for (const catalog of s.catalogs)
        for (const model of catalog.models) {
          model.metadataSource = 'https://models.dev/api.json';
          model.metadataFetchedAt = new Date(Date.now() - options.metadataAge!).toISOString();
        }
    });
  const client = app.createFutrynClient(root);
  return {app, account, client, root, calls: () => calls, finish: () => finish()};
}
test('cached startup refresh shares one request, persists levels and next offline launch reads them synchronously', async () => {
  const x = await fixture();
  const pending = x.client.refreshModelMetadata();
  expect(pending).toBeDefined();
  expect(x.calls()).toBe(1);
  const second = x.app.createFutrynClient('/tmp');
  const other = second.refreshModelMetadata();
  x.finish();
  await Promise.all([pending, other]);
  expect(x.client.status().activeModel?.reasoningEfforts).toEqual(['low', 'medium', 'high', 'xhigh']);
  expect(x.app.catalog(x.account).cached()[0]?.metadataSource).toBe('https://models.dev/api.json');
  expect(second.refreshModelMetadata()).toBeUndefined();
  expect(x.app.createFutrynClient('/tmp').status().activeModel?.reasoningEfforts).toContain('xhigh');
  expect(x.calls()).toBe(1);
});
test('failure is silent and attempted once', async () => {
  const x = await fixture({fail: true});
  const pending = x.client.refreshModelMetadata();
  x.finish();
  await pending;
  expect(x.client.status().activeModel?.reasoningEfforts).toBeUndefined();
  expect(x.client.refreshModelMetadata()).toBeUndefined();
  expect(x.calls()).toBe(1);
});
for (const options of [{offline: true}, {inject: false}]) {
  test(`automatic refresh disabled ${JSON.stringify(options)}`, async () => {
    const x = await fixture(options);
    expect(x.client.refreshModelMetadata()).toBeUndefined();
    expect(x.calls()).toBe(0);
  });
}
test('headless waits only for a missing requested/stored effort', async () => {
  const x = await fixture();
  expect(x.client.refreshModelMetadata({effortOnly: true})).toBeUndefined();
  x.app.settings.update(s => {
    s.reasoningPreferences = {[x.account.id + ':grok-4.7']: 'low'};
  });
  const pending = x.client.refreshModelMetadata({effortOnly: true});
  expect(pending).toBeDefined();
  x.finish();
  await pending;
  expect(x.client.status().reasoningEffort).toBe('low');
  expect(x.client.refreshModelMetadata({effortOnly: true})).toBeUndefined();
});
test('fresh vs stale metadata, unsupported reasoning and known efforts', () => {
  const model = normalizeModel('fixture', 'fixture');
  const now = Date.now();
  expect(needsEffortMetadata(model, now)).toBe(true);
  model.metadataSource = 'https://models.dev/api.json';
  model.metadataFetchedAt = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  expect(needsEffortMetadata(model, now)).toBe(false);
  expect(needsEffortMetadata(model, now + 1)).toBe(true);
  model.capabilities.reasoning = 'unsupported';
  expect(needsEffortMetadata(model, now + 1)).toBe(false);
  model.capabilities.reasoning = 'supported';
  model.reasoningEfforts = ['high'];
  expect(needsEffortMetadata(model, now + 1)).toBe(false);
});
test('shared request is abortable even when an injected fetch ignores the signal', async () => {
  const abort = new AbortController();
  const load = sharedModelMetadata(() => new Promise(() => {}), abort.signal);
  const pending = load();
  expect(load()).toBe(pending);
  abort.abort();
  await expect(pending).rejects.toBeDefined();
});

test('a second offline application reads persisted enrichment immediately', async () => {
  const x = await fixture();
  const pending = x.client.refreshModelMetadata();
  x.finish();
  await pending;
  const offline = startup(join(x.root, 'state'), {vault: memoryVault(), offline: true});
  cleanups.push(async () => {
    await offline.shutdownCommands();
    offline.db.close();
  });
  const client = offline.createFutrynClient(x.root);
  expect(client.status().activeModel?.reasoningEfforts).toContain('xhigh');
  expect(client.refreshModelMetadata()).toBeUndefined();
});
for (const metadataAge of [0, 25 * 60 * 60 * 1000]) {
  test(`startup freshness gate age=${metadataAge}`, async () => {
    const x = await fixture({metadataAge});
    const pending = x.client.refreshModelMetadata();
    expect(x.calls()).toBe(metadataAge ? 1 : 0);
    if (metadataAge) {
      x.finish();
      await pending;
    } else expect(pending).toBeUndefined();
  });
}
for (const stored of [false, true]) {
  test(`runExec waits for metadata only with a stored effort (${stored})`, async () => {
    const x = await fixture();
    if (stored)
      x.app.settings.update(s => {
        s.reasoningPreferences = {[x.account.id + ':grok-4.7']: 'low'};
      });
    let sent = false;
    const send = spyOn(x.client, 'sendMessage').mockImplementation(async function* () {
      sent = true;
      expect(x.client.status().reasoningEffort).toBe(stored ? 'low' : null);
    });
    const verification = spyOn(x.client, 'verifyAccount').mockResolvedValue({ok: true});
    const output = spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const result = runExec(
        {
          ...x.app,
          createFutrynClient: () => x.client,
          connectMcp: async () => ({configPath: '/fixture/mcp.json', servers: [], problems: []}),
        },
        {prompt: 'hello', workspace: x.root, json: false},
      );
      if (stored) {
        await Promise.resolve();
        expect(sent).toBe(false);
        x.finish();
      }
      expect(verification).toHaveBeenCalledTimes(1);
      expect(await result).toBe(0);
      expect(sent).toBe(true);
    } finally {
      verification.mockRestore();
      send.mockRestore();
      output.mockRestore();
    }
  });
}
