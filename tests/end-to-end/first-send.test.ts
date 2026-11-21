import {expect, spyOn, test} from 'bun:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CONTRACT_VERSION, providerSchema} from '@cosmew/contracts';
import {startup} from '../../apps/cli/src/bootstrap/startup';
import {runExec} from '../../apps/cli/src/exec';
import {memoryVault} from '../fixtures';

test('headless exec verifies the chosen model before starting a turn', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fyn-first-send-'));
  const prompts: string[] = [];
  const app = startup(join(root, 'state'), {
    offline: true,
    skillsHome: root,
    memoriesHome: root,
    vault: memoryVault(),
    fetch: (async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      prompts.push(body.messages.filter((message: {role: string}) => message.role === 'user').at(-1).content);
      if (!body.stream)
        return Response.json({
          id: 'probe',
          model: 'fixture-model',
          choices: [{index: 0, message: {role: 'assistant', content: 'OK'}, finish_reason: 'stop'}],
          usage: {prompt_tokens: 4, completion_tokens: 1, total_tokens: 5},
        });
      return new Response(
        'data: {"choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        {headers: {'content-type': 'text/event-stream'}},
      );
    }) as typeof fetch,
  });
  try {
    app.registry.add(
      providerSchema.parse({
        id: 'fixture',
        name: 'Fixture',
        protocol: 'chat',
        baseURL: 'http://127.0.0.1:12345/v1',
        auth: 'none',
        catalog: 'manual',
        metadataVersion: 1,
      }),
    );
    const account = await app.accounts.add('fixture', 'Fixture', {kind: 'none'});
    app.router.select(account, app.catalog(account).manual('fixture-model'));
    expect(prompts).toEqual([]);
    expect(await runExec(app, {workspace: root, prompt: 'actual prompt', json: false})).toBe(0);
    expect(prompts).toEqual(['Reply with OK.', 'actual prompt']);
  } finally {
    await app.shutdownCommands();
    app.db.close();
    rmSync(root, {recursive: true, force: true});
  }
});

async function withBillingFixture(run: (app: ReturnType<typeof startup>, workspace: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'fyn-billing-'));
  const requests: unknown[] = [];
  const app = startup(join(root, 'state'), {
    offline: true,
    skillsHome: root,
    memoriesHome: root,
    vault: memoryVault(),
    fetch: (async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return Response.json({error: 'Out of credits. Add credits at https://grok.com/?_s=usage'}, {status: 402});
    }) as typeof fetch,
  });
  try {
    app.registry.add(
      providerSchema.parse({
        id: 'fixture',
        name: 'Fixture',
        protocol: 'chat',
        baseURL: 'http://127.0.0.1:12345/v1',
        auth: 'none',
        catalog: 'manual',
        metadataVersion: 1,
      }),
    );
    const account = await app.accounts.add('fixture', 'Fixture', {kind: 'none'});
    app.router.select(account, app.catalog(account).manual('grok-4.7'));
    await run(app, root);
    expect(requests).toEqual([expect.objectContaining({model: 'grok-4.7', max_tokens: 16})]);
  } finally {
    await app.shutdownCommands();
    app.db.close();
    rmSync(root, {recursive: true, force: true});
  }
}

test('SDK account verification exposes the billing reason and safe provider hint', async () => {
  await withBillingFixture(async (app, workspace) => {
    const client = app.createFutrynClient(workspace);
    expect(await client.verifyAccount()).toEqual({
      ok: false,
      reason: 'billing',
      providerHint: 'Out of credits. Add credits at https://grok.com/',
    });
  });
});

test('headless exec reports billing and exits before starting the turn', async () => {
  await withBillingFixture(async (app, workspace) => {
    const lines: string[] = [];
    const write = spyOn(process.stdout, 'write').mockImplementation(value => {
      lines.push(String(value));
      return true;
    });
    let status: number;
    try {
      status = await runExec(app, {workspace, prompt: 'actual prompt', json: true});
    } finally {
      write.mockRestore();
    }
    expect(status).toBe(3);
    expect(lines.map(line => JSON.parse(line))).toEqual([
      {
        contractVersion: CONTRACT_VERSION,
        seq: 1,
        type: 'turn.failed',
        error: {
          code: 'PROVIDER_BILLING',
          message: expect.stringContaining('Provider says: Out of credits. Add credits at https://grok.com/'),
        },
      },
    ]);
    expect(lines.join('')).not.toContain('_s=usage');
  });
});
