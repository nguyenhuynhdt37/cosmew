import {expect, test} from 'bun:test';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startup} from '../../apps/cli/src/bootstrap/startup';
import {memoryVault} from '../fixtures';
import {providerSchema} from '@cosmew/contracts';
import {validateImageAttachment} from '@cosmew/tools';
import {toModelMessages} from '../../packages/models/src/adapter';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV0sAAAAASUVORK5CYII=';

test('image validation shares read media format, size and registered-secret boundary', () => {
  expect(validateImageAttachment('image/png', png, s => s).mime).toBe('image/png');
  for (const [mime, data] of [
    ['image/jpeg', png],
    ['image/png', 'aGVsbG8='],
    ['application/pdf', png],
    ['image/png', png + '!'],
  ])
    expect(() => validateImageAttachment(mime!, data!, s => s)).toThrow('INVALID_IMAGE');
  expect(() => validateImageAttachment('image/png', 'A'.repeat(28 * 1024 * 1024), s => s)).toThrow('INVALID_IMAGE');
  const secret = Buffer.concat([Buffer.from(png, 'base64'), Buffer.from('registered-secret')]).toString('base64');
  expect(() =>
    validateImageAttachment('image/png', secret, s => s.replaceAll('registered-secret', '[redacted]')),
  ).toThrow('SECRET_IN_MEDIA');
});

test('user image conversion is inline for all protocols and text-only for unsupported vision', () => {
  const message = {
    role: 'user' as const,
    content: 'inspect [Image #1]',
    attachments: [validateImageAttachment('image/png', png, s => s)],
  };
  for (const protocol of ['chat', 'responses', 'anthropic'] as const) {
    const wire = toModelMessages([message], {protocol, vision: 'supported'});
    expect(JSON.stringify(wire)).toContain(png);
    expect(wire[0]?.role).toBe('user');
    const blocked = JSON.stringify(toModelMessages([message], {protocol, vision: 'unsupported'}));
    expect(blocked).not.toContain(png);
    expect(blocked).toContain('cannot view');
  }
});

test('SDK images use explicit mediated paths, consume once, and journal only visible chips', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fyn-images-'));
  const requests: unknown[] = [];
  const fixtureFetch = (async (_url: unknown, init?: RequestInit) => {
    if (!init?.body) return Response.json({data: [{id: 'fixture-model'}]});
    requests.push(JSON.parse(String(init.body)));
    return new Response(
      'data: ' +
        JSON.stringify({
          id: 'fixture',
          model: 'fixture-model',
          choices: [{index: 0, delta: {content: 'Viewed'}, finish_reason: null}],
        }) +
        '\n\ndata: ' +
        JSON.stringify({
          id: 'fixture',
          model: 'fixture-model',
          choices: [{index: 0, delta: {}, finish_reason: 'stop'}],
          usage: {prompt_tokens: 10, completion_tokens: 1, total_tokens: 11},
        }) +
        '\n\ndata: [DONE]\n\n',
      {headers: {'content-type': 'text/event-stream'}},
    );
  }) as typeof fetch;
  const app = startup(join(root, 'state'), {
    vault: memoryVault(),
    skillsHome: root,
    memoriesHome: root,
    fetch: fixtureFetch,
  });
  const client = app.createFutrynClient(root);
  try {
    writeFileSync(join(root, 'picture.png'), Buffer.from(png, 'base64'));
    writeFileSync(join(root, 'plain.txt'), 'not an image');
    await expect(client.attachImage({mediaType: 'image/png', path: 'picture.png'})).rejects.toMatchObject({
      code: 'POLICY',
    });
    client.setToolsEnabled(true);
    client.addPermissionRule('deny', 'Read(picture.png)');
    await expect(client.attachImage({mediaType: 'image/png', path: 'picture.png'})).rejects.toMatchObject({
      code: 'POLICY',
    });
    await expect(client.attachImage({mediaType: 'image/png', path: '../outside.png'})).rejects.toMatchObject({
      code: 'POLICY',
    });
    await expect(client.attachImage({mediaType: 'image/png', path: 'plain.txt'})).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    app.registry.add(
      providerSchema.parse({
        id: 'images',
        name: 'Images fixture',
        protocol: 'chat',
        baseURL: 'https://images.example/v1',
        auth: 'none',
        catalog: 'openai',
        metadataVersion: 1,
      }),
    );
    await app.accounts.add('images', 'main', {kind: 'none'});
    await client.discoverModels();
    client.selectModel('fixture-model');
    const first = await client.attachImage({mediaType: 'image/png', data: png});
    expect(first.label).toBe('[Image #1]');
    expect(client.removeImageAttachment(first.id)).toBe(true);
    const second = await client.attachImage({mediaType: 'image/png', data: png});
    expect(second.label).toBe('[Image #2]');
    for await (const _event of client.sendMessage('Inspect it')) {
      /* consume */
    }
    expect(client.imageAttachments()).toEqual([]);
    const request = requests.find(r => JSON.stringify(r).includes(png));
    expect(request).toBeDefined();
    const session = client.activeSession();
    expect(JSON.stringify(app.conversations.get(session!.id))).not.toContain(png);
    expect(JSON.stringify(app.db.query('SELECT data FROM conversation_events').all())).not.toContain(png);
    expect(JSON.stringify(app.conversations.get(session!.id))).toContain('[Image #2]');
  } finally {
    await app.shutdownCommands();
    app.db.close();
    rmSync(root, {recursive: true, force: true});
  }
});
