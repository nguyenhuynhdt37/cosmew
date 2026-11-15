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

test('TUI: Auto, Dark and Light preview, cancel, apply and persist after restart', async () => {
  const x = context(); const a = await x.launch();
  await type(a.tui, '/theme'); await a.tui.handleKey('Enter');
  const menu = a.tui.computeFrameSnapshot().plainText;
  expect(menu).toContain('Auto'); expect(menu).toContain('Dark'); expect(menu).toContain('Light');
  expect(menu).not.toContain('Sakura');
  a.tui.resize(24, 14);
  const compactMenu = a.tui.computeFrameSnapshot().plainText;
  expect(compactMenu).toContain('Enter'); expect(compactMenu).toContain('Esc');
  a.tui.resize(120, 36);
  expect(a.tui.computeFrameSnapshot().cells.flat().some(cell => cell.fg === '#8ab4f8' || cell.fg === '#195dbc')).toBe(true);
  await a.tui.handleKey('ArrowDown'); expect(a.tui.computeFrameSnapshot().isPreviewing).toBe(true);
  expect(a.tui.computeFrameSnapshot().activeThemeId).toBe('dark');
  await a.tui.handleKey('Escape'); expect(a.tui.computeFrameSnapshot().activeThemeId).toBe('auto');
  await a.tui.handleKey('Ctrl+T'); await a.tui.handleKey('ArrowUp'); await a.tui.handleKey('Enter');
  expect(a.tui.computeFrameSnapshot().activeThemeId).toBe('light');
  expect(a.tui.computeFrameSnapshot().activeWallpaperId).toBeNull();
  expect(a.tui.computeFrameSnapshot().cells.flat().some(cell => cell.fg === '#195dbc')).toBe(true); a.close();
  const b = await x.launch(); expect(b.tui.computeFrameSnapshot().activeThemeId).toBe('light');
  expect(b.tui.computeFrameSnapshot().effectiveMode).toBe('light');
  await b.tui.executeSlashCommand('/theme dark'); expect(b.tui.getStatusBanner()).toContain('Usage: /theme');
  expect(b.tui.computeFrameSnapshot().activeThemeId).toBe('light');
  await b.tui.executeSlashCommand('/theme set auto'); expect(b.tui.getStatusBanner()).toContain('Use /theme');
  await b.tui.executeSlashCommand('/themes'); expect(b.tui.getActiveOverlay()).toBe('themes');
  await b.tui.handleKey('ArrowDown'); await b.tui.handleKey('Enter');
  expect(b.tui.computeFrameSnapshot().activeThemeId).toBe('auto'); b.close();
});

test('TUI: CLI exposes only three appearances and rejects retired color themes', async () => {
  const x = context();
  expect((await x.cli(['themes', 'set', 'dark'])).code).toBe(0);
  const listed = JSON.parse((await x.cli(['themes', 'list', '--json'])).stdout);
  expect(listed.themes.map((theme: {id:string}) => theme.id)).toEqual(['auto', 'dark', 'light']);
  expect(listed.mode).toBe('dark');
  expect((await x.cli(['themes', 'set', 'sakura'])).code).toBe(1);
  expect((await x.cli(['themes', 'wallpaper', 'neon-rain'])).code).toBe(1);
  const file = join(x.dir, 'old-theme.json'); writeFileSync(file, JSON.stringify({id:'old', bg:'#ff0000'}));
  expect((await x.cli(['themes', 'import', file])).code).toBe(1);
  expect((await x.cli(['themes', 'mode', 'light'])).code).toBe(0);
  const a = await x.launch(); expect(a.tui.computeFrameSnapshot().activeThemeId).toBe('light'); a.close();
  expect((await x.cli(['themes', 'mode', 'auto'])).code).toBe(0);
  expect(JSON.parse((await x.cli(['themes', 'list', '--json'])).stdout).mode).toBe('system');
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
  expect(a.tui.computeFrameSnapshot().plainText).toContain('Weepinbell · complete');
  a.tui.stepAnimation(2);
  expect(a.tui.computeFrameSnapshot().plainText).toContain('Weepinbell · ready');
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
    expect(a.tui.computeFrameSnapshot().plainText).toContain('Weepinbell · processing');
    const deadline = Date.now() + 3000;
    while (!a.tui.getTranscript().at(-1)?.content && Date.now() < deadline) await Bun.sleep(10);
    expect(a.tui.computeFrameSnapshot().plainText).toContain('Weepinbell · replying');
    a.tui.stepAnimation(120);
    expect(a.tui.computeFrameSnapshot().plainText).toContain('Weepinbell · replying');
    await a.tui.handleKey('Escape');
    await turn;
    expect(a.tui.computeFrameSnapshot().plainText).toContain('Weepinbell · cancelled');
    expect(a.tui.computeFrameSnapshot().plainText).not.toContain('Weepinbell · complete');
    x.server.set({ status: 500, streamDelay: 0 });
    await a.tui.submitPrompt('Fail this fixture response');
    expect(a.tui.computeFrameSnapshot().plainText).toContain('Weepinbell · error');
    a.tui.stepAnimation(120);
    expect(a.tui.computeFrameSnapshot().plainText).toContain('Weepinbell · error');
  } finally { a.close(); }
});

test.skipIf(process.platform === 'win32')('Fyn: actual PTY renders and exits cleanly without wallpaper', async () => {
  const x = context(); await configure(x);
  expect((await x.cli(['themes', 'wallpaper', 'none'])).code).toBe(0);
  expect((await x.cli(['themes', 'animation', '--enabled', 'true'])).code).toBe(0);
  let output = '';
  const decoder = new TextDecoder();
  const terminal = new Bun.Terminal({ cols: 100, rows: 36, data(_terminal, data) { output += decoder.decode(data, { stream: true }); } });
  const child = Bun.spawn([process.execPath, resolve('apps/cli/src/index.ts'), 'tui'], {
    terminal, env: { ...process.env, HANNES_HOME: x.dir, HANNES_TEST_KEY: 'fixture-e2e-sensitive-value', NO_COLOR: '1' },
  });
  try {
    const deadline = Date.now() + 6000;
    while (!output.includes('Trust this folder?') && Date.now() < deadline) await Bun.sleep(10);
    expect(output).toContain('Trust this folder?'); terminal.write('\x1b[A\r');
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

test('TUI: responsive full-screen width utilizes full terminal cols without 88-char clamp', async () => {
  const x = context();
  const a = await x.launch(160, 40);
  try {
    const home = a.tui.computeFrameSnapshot();
    expect(home.cols).toBe(160);
    expect(home.rows).toBe(40);
    // Màn trống dùng thẻ nhập hẹp, căn giữa. Không kẹp cả khung về 88 cột.
    const homeBorder = home.plainLines.find(line => line.includes('─'.repeat(40)));
    expect(homeBorder).toBeDefined();
    expect(homeBorder!.trim().length).toBeLessThan(90);
    await a.tui.submitPrompt('Wide room');
    const chat = a.tui.computeFrameSnapshot();
    const wideBorderLine = chat.plainLines.find(line => line.includes('─'.repeat(100)));
    expect(wideBorderLine).toBeDefined();
  } finally {
    a.close();
  }
});

test('chat resize keeps the composer usable and shows compact Fyn or its status fallback', async () => {
  const x = context(); await configure(x);
  const a = await x.launch(100, 30);
  try {
    await a.tui.submitPrompt('Responsive chat');
    for (const [cols, rows] of [[100, 30], [60, 24], [40, 14], [30, 10], [20, 10], [160, 40]]) {
      a.tui.resize(cols!, rows!);
      const frame = a.tui.computeFrameSnapshot();
      expect(frame.plainLines).toHaveLength(rows!);
      expect(frame.plainLines.every(line => line.length === cols)).toBe(true);
      expect(frame.plainText).toContain('Ask anything');
      if (rows! >= 24) {
        expect(frame.plainText).toContain('Weepinbell ·');
        const colored = frame.cells.flatMap(row => row.map((cell,col) => ({cell,col}))).filter(({cell}) => cell.fg === '#f7e65a' || cell.bg === '#f7e65a');
        expect(colored.length).toBeGreaterThan(0);
        expect(colored.every(({col}) => col > cols! / 2)).toBe(true);
      }
    }
  } finally { a.close(); }
});

test.skipIf(process.platform === 'win32')('TUI: real terminal chooses and persists the light theme', async () => {
  const x = context(); await configure(x); let output = '';
  const terminal = new Bun.Terminal({cols:80, rows:24, data(_terminal, bytes) { output += Buffer.from(bytes).toString('utf8'); }});
  const child = Bun.spawn([process.execPath, resolve('apps/cli/src/index.ts'), 'tui'], {
    terminal, env: {...process.env, HANNES_HOME:x.dir, HANNES_TEST_KEY:'fixture-e2e-sensitive-value', COLORTERM:'truecolor', FUTRYN_THEME_MODE:'dark'},
  });
  const wait = async (text:string, from = 0) => { const deadline = Date.now() + 5000; while (!output.slice(from).includes(text) && Date.now() < deadline) await Bun.sleep(10); expect(output.slice(from)).toContain(text); };
  try {
    await wait('Trust this folder?'); terminal.write('\x1b[A\r');
    await wait('Ask anything');
    const commandMark = output.length; terminal.write('/theme'); await wait('Commands', commandMark);
    expect(output.slice(commandMark)).not.toContain('/theme set'); expect(output.slice(commandMark)).not.toContain('/theme edit');
    terminal.write('\r'); await wait('Auto'); await wait('Dark'); await wait('Light');
    const mark = output.length; terminal.write('\x1b[B\x1b[B\r'); await wait('Theme: Light.', mark);
    terminal.write('\x03'); expect(await child.exited).toBe(0);
    const saved = JSON.parse((await x.cli(['themes', 'list', '--json'])).stdout);
    expect(saved.mode).toBe('light'); expect(saved.activeTheme).toBe('light');
  } finally { child.kill('SIGKILL'); await child.exited; terminal.close(); }
}, 15000);

test('short terminal keeps the draft and slash chooser visible while reconnecting', async () => {
  const x = context(); const a = await x.launch(60, 18);
  try {
    a.tui.resize(30, 10);
    await type(a.tui, '/mo');
    const frame = a.tui.computeFrameSnapshot();
    expect(frame.plainText).toContain('Commands');
    expect(frame.plainText).toContain('/model');
    expect(a.tui.getComposerState().value).toBe('/mo');
    expect(frame.plainLines.at(-2)).toContain('Chat');
    await a.tui.handleKey('Escape');
    expect(a.tui.getComposerState().value).toBe('/mo');
  } finally { a.close(); }
});

test('standard chat layout reserves conversation space while keeping model and context visible', async () => {
  const x = context(); await configure(x); const a = await x.launch(100, 30);
  try {
    await a.tui.submitPrompt('Layout test');
    const frame = a.tui.computeFrameSnapshot();
    expect(frame.plainText).toContain('Weepinbell · complete');
    expect(frame.plainText).toContain('fixture-model');
    expect(frame.plainText).toContain('Context');
    expect(frame.plainText).toContain('Ask anything');
    expect(frame.plainLines.slice(0, 20).some(line => line.includes('Hello fixture'))).toBe(true);
    expect(frame.plainLines.filter(line => /[▀▄]/.test(line))).toHaveLength(11);
    expect(frame.cells.flatMap(row => row.slice(0, 70)).every(cell => cell.ch !== '▀')).toBe(true);
  } finally { a.close(); }
});
