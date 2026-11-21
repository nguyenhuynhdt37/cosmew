import {expect, test} from 'bun:test';
import {mkdtempSync, mkdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startup} from '../../apps/cli/src/bootstrap/startup';
import {memoryVault} from '../fixtures';

test('SDK writeMemory uses mediated memory: consent, schema, plan, read-only, deny and durable write', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fyn-sdk-memory-'));
  const home = join(root, 'home');
  const project = join(root, 'project');
  mkdirSync(home);
  mkdirSync(project);
  const app = startup(join(home, '.futryn'), {
    vault: memoryVault(),
    memoriesHome: home,
  });
  const client = app.createFutrynClient(project);
  const entry = {
    name: 'quick-note',
    description: 'Explicit user preference',
    type: 'feedback' as const,
    content: 'Use concise explanations.',
  };
  try {
    await expect(client.writeMemory(entry)).rejects.toMatchObject({code: 'UNSUPPORTED'});
    client.setToolsEnabled(true);
    await expect(client.writeMemory({...entry, name: '../escape'})).rejects.toMatchObject({code: 'INVALID_INPUT'});
    client.setMode('plan');
    await expect(client.writeMemory(entry)).rejects.toMatchObject({code: 'POLICY'});
    client.setMode('chat');
    client.setPermissionMode('plan');
    expect((await client.writeMemory(entry)).status).toBe('denied');
    expect(client.memories()).toEqual([]);
    client.setPermissionMode('acceptEdits');
    expect((await client.writeMemory(entry)).status).toBe('ok');
    expect((await client.readMemory(entry.name)).content).toContain(entry.content);
    client.addPermissionRule('deny', 'Tool(memory)');
    expect((await client.writeMemory({...entry, name: 'blocked-note'})).status).toBe('denied');
    expect(client.memories().map(m => m.name)).toEqual(['quick-note']);
  } finally {
    await app.shutdownCommands();
    app.db.close();
    rmSync(root, {recursive: true, force: true});
  }
});
