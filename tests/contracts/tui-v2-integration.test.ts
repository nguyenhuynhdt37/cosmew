import {expect, test} from 'bun:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startup} from '../../apps/cli/src/bootstrap/startup';
import {FutrynTuiApp} from '../../apps/tui/src/app';
import {fixtureServer, memoryVault} from '../fixtures';

test('typing long sessions does not reread durable history; session drafts and wide diff survive navigation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'futryn-v2-regression-'));
  const server = fixtureServer();
  const ctx = startup(join(dir, 'state'), {vault: memoryVault()});
  let tui: FutrynTuiApp | undefined;
  try {
    ctx.registry.add(server.provider('chat', {id: 'v2', auth: 'none'}));
    const account = await ctx.accounts.add('v2', 'v2', {kind: 'none'});
    const client = ctx.createFutrynClient(dir);
    await client.discoverModels();
    client.selectModel('fixture-model');
    const first = ctx.conversations.create({accountId: account.id, modelId: 'fixture-model'});
    const second = ctx.conversations.create({accountId: account.id, modelId: 'fixture-model'});
    ctx.conversations.append(first, {role: 'user', content: 'saved prompt'}, 'committed');
    client.resumeSession(first);
    tui = new FutrynTuiApp({client, cols: 160, rows: 40});
    await tui.initialize();
    tui.renderAnsiFrame();
    const ports = (client as unknown as {ports: {getSession: typeof ctx.conversations.get}}).ports;
    const original = ports.getSession.bind(ports);
    let reads = 0;
    ports.getSession = (id: string) => {
      reads++;
      return original(id);
    };
    for (const ch of 'draft text') {
      await tui.handleKey(ch);
      tui.renderAnsiFrame();
    }
    expect(reads).toBe(0);
    await tui.executeSlashCommand(`/resume ${second}`);
    expect(tui.getComposerState().value).toBe('');
    await tui.handleKey('b');
    await tui.executeSlashCommand(`/resume ${first}`);
    expect(tui.getComposerState().value).toBe('draft text');
    await tui.executeSlashCommand('/diff');
    const wide = tui.computeFrameSnapshot();
    expect(
      wide.cells[1]!.slice(0, 75)
        .map(c => c.ch)
        .join(''),
    ).toContain('FUTRYN');
    expect(wide.plainText).toContain('/diff');
    tui.resize(40, 20);
    expect(tui.computeFrameSnapshot().plainText).toContain('/diff');
    await tui.handleKey('Escape');
    expect(tui.getComposerState().value).toBe('draft text');
    expect(client.activeSession()?.messages).toHaveLength(1);
  } finally {
    await tui?.shutdown();
    await ctx.shutdownCommands();
    ctx.db.close();
    server.server.stop(true);
    rmSync(dir, {recursive: true, force: true});
  }
});
