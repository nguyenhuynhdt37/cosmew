import {expect, test} from 'bun:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {startup} from '../../apps/cli/src/bootstrap/startup';
import {fixtureServer, memoryVault} from '../fixtures';

test.skipIf(process.platform === 'win32')(
  'native PTY: 5000-message resume, responsive input, idle silence, resize and cleanup',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'futryn-v2-pty-'));
    const server = fixtureServer(),
      ctx = startup(join(dir, 'state'), {vault: memoryVault()});
    let terminal: Bun.Terminal | undefined, child: ReturnType<typeof Bun.spawn> | undefined;
    try {
      ctx.registry.add(server.provider('chat', {id: 'pty-v2', auth: 'none'}));
      const account = await ctx.accounts.add('pty-v2', 'pty-v2', {kind: 'none'});
      const client = ctx.createFutrynClient(dir);
      await client.discoverModels();
      client.selectModel('fixture-model');
      client.updateAppearance({animations: {...client.getAppearance().animations, enabled: false}});
      const id = ctx.conversations.create({accountId: account.id, modelId: 'fixture-model'});
      ctx.db.transaction(() => {
        for (let i = 0; i < 5000; i++)
          ctx.conversations.append(
            id,
            {role: i % 2 ? 'assistant' : 'user', content: `Stored message ${i}\n` + 'readable history '.repeat(20)},
            'committed',
          );
      })();
      let output = '';
      terminal = new Bun.Terminal({
        cols: 120,
        rows: 40,
        data(_t, bytes) {
          output += Buffer.from(bytes).toString('utf8');
        },
      });
      child = Bun.spawn([process.execPath, resolve('apps/cli/src/index.ts'), 'resume', id], {
        cwd: dir,
        terminal,
        env: {...process.env, HANNES_HOME: join(dir, 'state'), NO_COLOR: '1'},
      });
      const wait = async (text: string, from = 0) => {
        const deadline = Date.now() + 6000;
        while (!output.slice(from).includes(text) && Date.now() < deadline) await Bun.sleep(2);
        expect(output.slice(from)).toContain(text);
      };
      await wait('Trust this folder?');
      terminal.write('\x1b[A\r');
      await wait('Stored message 4999');
      const latencies: number[] = [];
      for (const ch of 'abcdefghij') {
        const from = output.length,
          start = performance.now();
        terminal.write(ch);
        await wait('abcdefghij'.slice(0, latencies.length + 1), from);
        latencies.push(performance.now() - start);
      }
      expect(latencies.sort((a, b) => a - b)[9]!).toBeLessThan(50);
      await Bun.sleep(100);
      const idle = output.length;
      await Bun.sleep(250);
      expect(output.length).toBe(idle);
      terminal.write('\x1b[200~\n日本語 👩🏽‍💻\x1b[201~');
      await wait('日本語');
      terminal.resize(80, 24);
      await Bun.sleep(80);
      terminal.write('\x03');
      await Bun.sleep(30);
      terminal.write('\x03');
      expect(await child.exited).toBe(0);
      expect(output).toContain('\x1b[?2004l');
      expect(output).toContain('\x1b[?1049l');
      console.log('TUI V2 native PTY input-to-output ms', JSON.stringify(latencies));
    } finally {
      child?.kill('SIGKILL');
      if (child) await child.exited;
      terminal?.close();
      await ctx.shutdownCommands();
      ctx.db.close();
      server.server.stop(true);
      rmSync(dir, {recursive: true, force: true});
    }
  },
  20_000,
);
