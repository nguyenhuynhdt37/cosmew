import {expect, test} from 'bun:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';

test('line CLI recognizes /tasks and /bashes without treating them as model prompts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cosmew-task-cli-'));
  try {
    const child = Bun.spawn(
      [process.execPath, '--config=/dev/null', '--no-env-file', resolve('apps/cli/src/index.ts'), 'chat'],
      {
        cwd: root,
        env: {...process.env, COSMEW_HOME: join(root, 'state')},
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    let out = '';
    const reading = (async () => {
      for await (const chunk of child.stdout) out += Buffer.from(chunk).toString();
    })();
    const errors = new Response(child.stderr).text();
    const end = Date.now() + 2000;
    while (!out.includes('Ctrl-C cancels and exits.') && child.exitCode === null && Date.now() < end)
      await Bun.sleep(10);
    child.stdin.write('/tasks\n/bashes\n/exit\n');
    child.stdin.end();
    const [error, code] = await Promise.all([errors, child.exited, reading]);
    expect(code).toBe(0);
    expect(out).toContain('/tasks is an interactive panel');
    expect(out.match(/\/tasks is an interactive panel/g)).toHaveLength(2);
    expect(error).not.toContain('INVALID_INPUT');
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});
