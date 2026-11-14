import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startup } from '../../apps/cli/src/bootstrap/startup';
import { FutrynTuiApp } from '@hannes/tui';
import { fixtureServer } from '../fixtures';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.splice(0)) f();
});

function context() {
  const server = fixtureServer();
  const dir = mkdtempSync(join(tmpdir(), 'futryn-tui-'));
  cleanup.push(
    () => server.server.stop(true),
    () => rmSync(dir, { recursive: true, force: true }),
  );
  async function cli(args: string[], input = '') {
    const child = Bun.spawn([process.execPath, resolve('apps/cli/src/index.ts'), ...args], {
      env: { ...process.env, HANNES_HOME: dir, HANNES_TEST_KEY: 'fixture-e2e-sensitive-value' },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    child.stdin.write(input);
    child.stdin.end();
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(stdout + stderr).not.toContain('fixture-e2e-sensitive-value');
    return { stdout, stderr, code };
  }
  // Mỗi "lần khởi động" TUI = một startup() mới trên cùng HANNES_HOME (mô phỏng restart).
  async function launch(cols = 120, rows = 36) {
    process.env.HANNES_TEST_KEY = 'fixture-e2e-sensitive-value';
    const appCtx = startup(dir);
    const tui = new FutrynTuiApp({ client: appCtx.createFutrynClient(dir), cols, rows, env: { COLORTERM: 'truecolor' } });
    await tui.initialize();
    return { tui, close: () => appCtx.db.close() };
  }
  return { server, dir, cli, launch };
}

async function configure(x: ReturnType<typeof context>) {
  expect(
    (await x.cli(['providers', 'add', 'gateway', '--url', x.server.url + '/v1', '--protocol', 'chat', '--catalog', 'openai'])).code,
  ).toBe(0);
  const login = await x.cli(['auth', 'login', '--provider', 'gateway', '--alias', 'personal', '--env', 'HANNES_TEST_KEY', '--json']);
  expect(login.code).toBe(0);
  expect((await x.cli(['models', 'select', 'fixture-model', '--account', 'personal', '--json'])).code).toBe(0);
}

async function type(tui: FutrynTuiApp, text: string) {
  for (const ch of text) await tui.handleKey(ch);
}

test('TUI: welcome screen → /themes preview/cancel/apply → persistence across restart', async () => {
  const x = context();
  const a = await x.launch();
  expect(a.tui.computeFrameSnapshot().plainText).toContain('FUTRYN');
  expect(a.tui.computeFrameSnapshot().plainText).toContain('Fyn · ready');

  await type(a.tui, '/themes');
  await a.tui.handleKey('Enter');
  expect(a.tui.getActiveOverlay()).toBe('themes');

  // Preview (ArrowDown) rồi Esc phải khôi phục theme gốc.
  const original = a.tui.computeFrameSnapshot().activeThemeId;
  await a.tui.handleKey('ArrowDown');
  const previewing = a.tui.computeFrameSnapshot();
  expect(previewing.isPreviewing).toBe(true);
  expect(previewing.activeThemeId).not.toBe(original);
  await a.tui.handleKey('Escape');
  const restored = a.tui.computeFrameSnapshot();
  expect(restored.isPreviewing).toBe(false);
  expect(restored.activeThemeId).toBe(original);

  // Tìm "sakura dusk", Enter để áp dụng (kèm live wallpaper).
  await a.tui.handleKey('Ctrl+T');
  await type(a.tui, 'sakura dusk');
  await a.tui.handleKey('Enter');
  const applied = a.tui.computeFrameSnapshot();
  expect(applied.activeThemeId).toBe('sakura-dusk');
  expect(applied.activeWallpaperId).toBe('sakura-dusk');
  a.close();

  // Restart: theme + wallpaper phải còn nguyên.
  const b = await x.launch();
  const after = b.tui.computeFrameSnapshot();
  expect(after.activeThemeId).toBe('sakura-dusk');
  expect(after.activeWallpaperId).toBe('sakura-dusk');
  b.close();
});

test('TUI: CLI themes commands share the same persisted state; malformed import is rejected safely', async () => {
  const x = context();
  expect((await x.cli(['themes', 'set', 'terminal', '--json'])).code).toBe(0);
  expect((await x.cli(['themes', 'mode', 'dark'])).code).toBe(0);
  expect((await x.cli(['themes', 'wallpaper', 'neon-rain'])).code).toBe(0);
  expect((await x.cli(['themes', 'animation', '--speed', '2.5', '--motion', 'grid'])).code).toBe(0);
  const listed = JSON.parse((await x.cli(['themes', 'list', '--json'])).stdout);
  expect(listed.activeTheme).toBe('terminal');
  expect(listed.animations.speed).toBe(2.5);
  expect(listed.animations.motion).toBe('grid');

  const bad = join(x.dir, 'bad.json');
  writeFileSync(bad, '{ not json');
  expect((await x.cli(['themes', 'import', bad])).code).toBe(1);
  const unknown = join(x.dir, 'unknown.json');
  writeFileSync(unknown, JSON.stringify({ random: 1 }));
  expect((await x.cli(['themes', 'import', unknown])).code).toBe(1);

  const good = join(x.dir, 'good.json');
  writeFileSync(
    good,
    JSON.stringify({ id: 'cd-aurora', name: 'Aurora', bg: '#111622', text: '#e5ecf6', accent: '#6be5b8' }),
  );
  expect((await x.cli(['themes', 'import', good])).code).toBe(0);
  expect((await x.cli(['themes', 'set', 'cd-aurora'])).code).toBe(0);

  // App vẫn khởi động bình thường sau khi import lỗi, và thấy theme tùy chỉnh.
  const a = await x.launch();
  expect(a.tui.computeFrameSnapshot().activeThemeId).toBe('cd-aurora');
  a.close();
  expect((await x.cli(['themes', 'remove', 'sakura'])).code).toBe(1);
  expect((await x.cli(['themes', 'remove', 'cd-aurora'])).code).toBe(0);
  expect(JSON.parse((await x.cli(['themes', 'list', '--json'])).stdout).activeTheme).toBe('futryn-default');
});

test('TUI: real provider/model/chat workflow against fixture server, transcript, sessions, /new and /clear', async () => {
  const x = context();
  await configure(x);
  const a = await x.launch();

  await type(a.tui, 'Say hello');
  await a.tui.handleKey('Enter');
  const transcript = a.tui.getTranscript();
  expect(transcript.length).toBe(2);
  expect(transcript[1]!.content).toBe('Hello fixture');
  expect(transcript[1]!.streaming).toBe(false);
  expect(a.tui.computeFrameSnapshot().plainText).toContain('Hello fixture');
  expect(a.tui.computeFrameSnapshot().plainText).toContain('Fyn · complete');
  a.tui.stepAnimation(2);
  expect(a.tui.computeFrameSnapshot().plainText).toContain('Fyn · ready');
  const posts = x.server.requests.filter(r => r.body);
  expect(JSON.stringify(posts.at(-1)?.body)).toContain('Say hello');

  // /models liệt kê model thật từ cache provider.
  await type(a.tui, '/models');
  await a.tui.handleKey('Enter');
  expect(a.tui.getActiveOverlay()).toBe('models');
  expect(a.tui.computeFrameSnapshot().plainText).toContain('fixture-model');
  await a.tui.handleKey('Escape');

  // Session đã được lưu và hiển thị trong picker.
  await a.tui.handleKey('Ctrl+S');
  expect(a.tui.getActiveOverlay()).toBe('sessions');
  expect(a.tui.computeFrameSnapshot().plainText).toContain('fixture-model');
  await a.tui.handleKey('Escape');

  await type(a.tui, '/clear');
  await a.tui.handleKey('Enter');
  expect(a.tui.getTranscript().length).toBe(0);
  a.close();

  // Restart rồi resume session đã lưu.
  const b = await x.launch();
  await b.tui.handleKey('Ctrl+S');
  await b.tui.handleKey('Enter');
  expect(b.tui.getTranscript().some(m => m.content === 'Hello fixture')).toBe(true);
  b.close();
});

test('TUI: permission dialog dismiss never grants; unknown command and tiny terminal degrade safely', async () => {
  const x = context();
  const a = await x.launch(60, 18);

  await type(a.tui, '/permissions');
  await a.tui.handleKey('Enter');
  expect(a.tui.getActiveOverlay()).toBe('permissions');
  a.tui.client.enqueuePermissionRequest({ capability: 'fs.write', action: 'Write fixture', target: '/fixture/path', reason: 'Test pending request dismissal' });
  expect(a.tui.client.listPendingPermissions().length).toBe(1);
  await a.tui.handleKey('Escape');
  expect(a.tui.client.listPendingPermissions().length).toBe(0);
  expect(a.tui.client.listPermissions().every(p => p.status === 'denied')).toBe(true);

  await type(a.tui, '/nonexistent');
  await a.tui.handleKey('Enter');
  expect(a.tui.getStatusBanner()).toContain('Unknown slash command');

  // Terminal nhỏ: không throw, wallpaper tự tắt, composer vẫn hiển thị.
  a.tui.resize(30, 10);
  const tiny = a.tui.computeFrameSnapshot();
  expect(tiny.rows).toBe(10);
  a.tui.resize(120, 36);
  a.close();
});

test('Fyn: animation without wallpaper, focus/reduced motion, sleep, and pending approval', async () => {
  const x = context();
  const a = await x.launch();
  try {
    await a.tui.themeEngine.updateAppearance({ wallpaper: null });
    const initial = a.tui.computeFrameSnapshot();
    expect(initial.activeWallpaperId).toBeNull();
    a.tui.stepAnimation(0.8);
    expect(a.tui.computeFrameSnapshot().plainText).not.toBe(initial.plainText);
    await a.tui.handleKey('FocusOut');
    const paused = a.tui.computeFrameSnapshot().plainText;
    a.tui.stepAnimation(1);
    expect(a.tui.computeFrameSnapshot().plainText).toBe(paused);
    await a.tui.handleKey('FocusIn');
    await a.tui.themeEngine.updateAnimation({ reducedMotion: true });
    const reduced = a.tui.computeFrameSnapshot().plainText;
    a.tui.stepAnimation(4);
    expect(a.tui.computeFrameSnapshot().plainText).toBe(reduced);
    a.tui.stepAnimation(60);
    expect(a.tui.computeFrameSnapshot().plainText).toContain('Fyn · sleeping');
    await a.tui.handleKey('x');
    expect(a.tui.computeFrameSnapshot().plainText).toContain('Fyn · ready');
    const request = a.tui.client.enqueuePermissionRequest({ capability: 'fs.read', action: 'read', target: 'fixture', reason: 'Presentation fixture only' });
    a.tui.stepAnimation(120);
    expect(a.tui.computeFrameSnapshot().plainText).toContain('Fyn · awaiting approval');
    expect(a.tui.client.listPendingPermissions()).toHaveLength(1);
    a.tui.client.resolvePermission(request.approvalId, request.scopeHash, 'deny');
    expect(a.tui.computeFrameSnapshot().plainText).not.toContain('awaiting approval');
    a.tui.resize(30, 10);
    expect(a.tui.computeFrameSnapshot().plainText).not.toContain('Fyn');
  } finally { a.close(); }
});

test('Fyn: provider stream, cancellation and failure never show a false completion', async () => {
  const x = context();
  await configure(x);
  const a = await x.launch();
  try {
    x.server.set({ streamDelay: 100 });
    const turn = a.tui.submitPrompt('Slow fixture response');
    expect(a.tui.computeFrameSnapshot().plainText).toContain('Fyn · processing');
    const deadline = Date.now() + 3000;
    while (!a.tui.getTranscript().at(-1)?.content && Date.now() < deadline) await Bun.sleep(10);
    expect(a.tui.computeFrameSnapshot().plainText).toContain('Fyn · replying');
    a.tui.stepAnimation(120);
    expect(a.tui.computeFrameSnapshot().plainText).toContain('Fyn · replying');
    await a.tui.handleKey('Escape');
    await turn;
    expect(a.tui.computeFrameSnapshot().plainText).toContain('Fyn · cancelled');
    expect(a.tui.computeFrameSnapshot().plainText).not.toContain('Fyn · complete');
    x.server.set({ status: 500, streamDelay: 0 });
    await a.tui.submitPrompt('Fail this fixture response');
    expect(a.tui.computeFrameSnapshot().plainText).toContain('Fyn · error');
    a.tui.stepAnimation(120);
    expect(a.tui.computeFrameSnapshot().plainText).toContain('Fyn · error');
  } finally { a.close(); }
});

test.skipIf(process.platform === 'win32')('Fyn: actual PTY renders and exits cleanly without wallpaper', async () => {
  const x = context();
  expect((await x.cli(['themes', 'wallpaper', 'none'])).code).toBe(0);
  expect((await x.cli(['themes', 'animation', '--enabled', 'true'])).code).toBe(0);
  let output = '';
  const decoder = new TextDecoder();
  const terminal = new Bun.Terminal({ cols: 100, rows: 36, data(_terminal, data) { output += decoder.decode(data, { stream: true }); } });
  const child = Bun.spawn([process.execPath, resolve('apps/cli/src/index.ts'), 'tui'], {
    terminal, env: { ...process.env, HANNES_HOME: x.dir, NO_COLOR: '1' },
  });
  try {
    const deadline = Date.now() + 4000;
    while (!output.includes('Fyn · ready') && Date.now() < deadline) await Bun.sleep(20);
    expect(output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')).toContain('Fyn · ready');
    const before = output.length;
    await Bun.sleep(800);
    expect(output.length).toBeGreaterThan(before);
    terminal.write('\x03');
    expect(await Promise.race([child.exited, Bun.sleep(3000).then(() => -1)])).toBe(0);
    expect(output).toContain('\x1b[?25h');
    expect(output).toContain('\x1b[?1049l');
  } finally {
    child.kill('SIGKILL');
    await child.exited;
    terminal.close();
  }
}, 10000);
