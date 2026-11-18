import {afterEach, expect, test} from 'bun:test';
import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {startup} from '../../apps/cli/src/bootstrap/startup';
import {FutrynTuiApp, type ActiveOverlay} from '@futryn/tui';
import {fixtureServer, memoryVault} from '../fixtures';

/**
 * Golden frames for every overlay at several terminal sizes. They pin the rendered
 * output so structural refactors of the TUI cannot silently change behavior.
 * Regenerate deliberately with UPDATE_GOLDEN=1 and review the diff.
 */
const GOLDEN = join(import.meta.dir, '__golden__', 'tui-overlays.json');
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

const OVERLAYS: ActiveOverlay[] = [
  'none',
  'palette',
  'themes',
  'theme-editor',
  'models',
  'connect',
  'sessions',
  'permissions',
  'diff',
  'settings',
  'effort',
  'usage',
  'context',
  'status',
  'help',
];
const SIZES: [number, number][] = [
  [80, 24],
  [120, 36],
  [44, 14],
];

const normalize = (text: string, dir: string) =>
  text
    .split(dir)
    .join('<WS>')
    // Narrow path-tail elision can remove the temporary directory's stable prefix.
    .split(dir.slice(-6))
    .join('<RAND>')
    .replace(/futryn-golden-[A-Za-z0-9]{6}/g, 'futryn-golden-<RAND>')
    .replace(/127\.0\.0\.1:\d+/g, '<HOST>')
    .replace(/Worked for \d+\.\d+s/g, 'Worked for <TIME>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<UUID>')
    .replace(/\b[0-9a-f]{8}\b/g, '<ID8>')
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, '<TS>');

/** A fresh workspace, provider and account for every terminal size, so scenarios cannot leak into each other. */
async function environment() {
  const dir = mkdtempSync(join(tmpdir(), 'futryn-golden-'));
  const server = fixtureServer();
  cleanup.push(
    () => rmSync(dir, {recursive: true, force: true}),
    () => server.server.stop(true),
  );
  const app = startup(dir, {vault: memoryVault(), memoriesHome: dir});
  cleanup.push(() => app.db.close());
  app.registry.add(server.provider('chat', {id: 'golden', auth: 'none'}));
  await app.accounts.add('golden', 'primary', {kind: 'none'});
  const client = app.createFutrynClient(dir);
  await client.discoverModels();
  client.selectModel('fixture-model');
  return {dir, client};
}

async function frames(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [cols, rows] of SIZES) {
    const {dir, client} = await environment();
    const tui = new FutrynTuiApp({client, cols, rows, env: {HANNES_HOME: dir}});
    await tui.initialize();
    cleanup.push(() => tui.shutdown());
    tui.resize(cols, rows);
    const snap = (name: string) => {
      out[`${name}@${cols}x${rows}`] = normalize(tui.computeFrameSnapshot().plainText, dir);
    };
    for (const overlay of OVERLAYS) {
      tui.openOverlay(overlay);
      snap(overlay);
    }
    tui.openOverlay('none');
    // Composer states and a live conversation (the main screen, not an overlay).
    for (const typed of ['/', '/th', '@']) {
      for (const ch of typed) await tui.handleKey(ch);
      snap(`composer:${typed}`);
      await tui.handleKey('Escape');
      await tui.handleKey('Escape');
    }
    await tui.submitPrompt('hello golden');
    snap('chatting');
    await tui.handleKey('PageUp');
    snap('chatting-scrolled');
    await tui.handleKey('Ctrl+R');
    snap('chatting-reasoning-toggle');
    await tui.handleKey('Ctrl+B');
    snap('chatting-sidebar-toggled');
  }
  return out;
}

test('every overlay renders the same frames as the recorded golden set', async () => {
  const actual = await frames();
  if (process.env.UPDATE_GOLDEN === '1' || !existsSync(GOLDEN)) {
    mkdirSync(dirname(GOLDEN), {recursive: true});
    writeFileSync(GOLDEN, JSON.stringify(actual, null, 1) + '\n');
    return;
  }
  const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Record<string, string>;
  expect(Object.keys(actual).sort()).toEqual(Object.keys(golden).sort());
  for (const key of Object.keys(golden)) expect({key, frame: actual[key]}).toEqual({key, frame: golden[key]});
});

test('golden frames are deterministic across independent runs', async () => {
  expect(await frames()).toEqual(await frames());
});
