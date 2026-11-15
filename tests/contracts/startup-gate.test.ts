import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startup } from '../../apps/cli/src/bootstrap/startup';
import { FutrynTuiApp } from '@hannes/tui';
import { fixtureServer, memoryVault } from '../fixtures';
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const f of cleanup.splice(0).reverse()) await f(); });
async function make() {
  const dir = mkdtempSync(join(tmpdir(), 'futryn-startup-')); const server = fixtureServer();
  cleanup.push(() => rmSync(dir, {recursive:true, force:true}), () => server.server.stop(true));
  const app = startup(dir, {vault:memoryVault()}); cleanup.push(() => app.db.close());
  app.registry.add(server.provider('chat', {id:'startup', auth:'none'}));
  const client = app.createFutrynClient(dir); const tui = new FutrynTuiApp({client, cols:80, rows:24});
  await tui.initialize(); cleanup.push(() => tui.shutdown());
  return {app, client, tui, server, dir};
}
async function waitFor(fn:()=>boolean) { const until=Date.now()+4000; while (!fn() && Date.now()<until) await Bun.sleep(10); expect(fn()).toBe(true); }
test('startup asks for folder approval before checking account; denial makes no request', async () => {
  const c=await make(); const a=await c.app.accounts.add('startup','primary',{kind:'none'}); await c.client.discoverModels(); c.client.selectModel('fixture-model');
  c.tui.startStartupGate(); const before=c.server.requests.length;
  expect(c.tui.computeFrameSnapshot().plainText).toContain('Trust this folder?');
  c.tui.resize(20, 8); expect(c.tui.computeFrameSnapshot().plainText).toContain('May incur cost.');
  expect(c.tui.computeFrameSnapshot().plainText).toContain('Exit'); c.tui.resize(80, 24);
  await c.tui.handleKey('x'); expect(c.tui.getComposerState().value).toBe('');
  await c.tui.handleKey('Enter'); expect(c.tui.isExitRequested()).toBe(true);
  expect(c.server.requests.length).toBe(before); expect(c.app.accounts.get(a.id).status).not.toBe('logged-out');
});
test('startup validates active account and offers retry, alternate account, and login on failure', async () => {
  const c=await make(); const a=await c.app.accounts.add('startup','primary',{kind:'none'}); await c.client.discoverModels(); c.client.selectModel('fixture-model');
  c.tui.startStartupGate(); await c.tui.handleKey('ArrowUp'); await c.tui.handleKey('Enter');
  await waitFor(()=>!c.tui.computeFrameSnapshot().plainText.includes('Checking account'));
  expect(c.tui.computeFrameSnapshot().plainText).not.toContain('Choose an account');
  expect(c.server.requests.some(r=>r.body?.messages?.[0]?.content==='Reply with OK.')).toBe(true);
  const b=await c.app.accounts.add('startup','secondary',{kind:'none'}); c.client.useAccount(a.id); c.client.selectModel('fixture-model');
  c.server.set({status:401}); c.tui.startStartupGate(); await c.tui.handleKey('ArrowUp'); await c.tui.handleKey('Enter');
  await waitFor(()=>c.tui.computeFrameSnapshot().plainText.includes('Choose an account'));
  expect(c.tui.computeFrameSnapshot().plainText).toContain('Sign in to another account');
  expect(c.app.accounts.get(a.id)).toBeDefined();
  expect(c.tui.computeFrameSnapshot().plainText).toContain('› secondary');
  c.server.set({status:200}); await c.tui.handleKey('Enter');
  await waitFor(()=>!c.tui.computeFrameSnapshot().plainText.includes('Checking account'));
  expect(c.client.status().activeAccount?.id).toBe(b.id);
});

test('startup without accounts requires sign-in and cancellation never opens chat', async () => {
  const c=await make(); c.tui.startStartupGate();
  await c.tui.handleKey('ArrowUp'); await c.tui.handleKey('Enter');
  expect(c.tui.computeFrameSnapshot().plainText).toContain('Sign in to another account');
  await c.tui.handleKey('Enter'); expect(c.tui.getActiveOverlay()).toBe('connect');
  await c.tui.handleKey('Ctrl+S'); expect(c.tui.getActiveOverlay()).toBe('connect');
  await c.tui.handleKey('Ctrl+P'); expect(c.tui.getActiveOverlay()).toBe('connect');
  await c.tui.handleKey('Escape'); c.tui.stepAnimation(0.1);
  expect(c.tui.computeFrameSnapshot().plainText).toContain('Choose an account');
  await c.tui.handleKey('Escape'); expect(c.tui.isExitRequested()).toBe(true);
});

test.skipIf(process.platform === 'win32')('actual PTY blocks until folder consent and reports rejected account without deleting it', async () => {
  const c = await make(); const account = await c.app.accounts.add('startup','primary',{kind:'none'}); await c.client.discoverModels(); c.client.selectModel('fixture-model');
  c.server.set({status:401}); let output = '';
  const terminal = new Bun.Terminal({cols:80, rows:24, data(_terminal, bytes) { output += Buffer.from(bytes).toString(); }});
  const child = Bun.spawn([process.execPath, 'apps/cli/src/index.ts', 'tui'], {terminal, env:{...process.env, HANNES_HOME:c.dir, NO_COLOR:'1'}});
  const wait = async (value:string) => { const until=Date.now()+5000; while(!output.includes(value) && Date.now()<until) await Bun.sleep(10); expect(output).toContain(value); };
  try {
    const before=c.server.requests.length; await wait('Trust this folder?');
    await Bun.sleep(100); expect(c.server.requests.length).toBe(before);
    terminal.write('\x1b[A\r'); await wait('Choose an account');
    await wait('Account access was rejected'); expect(c.app.accounts.get(account.id)).toBeDefined();
    terminal.write('\x03'); expect(await child.exited).toBe(0);
  } finally { child.kill('SIGKILL'); await child.exited; terminal.close(); }
}, 12000);

test('network failure remains retryable and does not mark the account invalid', async () => {
  const c=await make(); const account=await c.app.accounts.add('startup','primary',{kind:'none'}); await c.client.discoverModels(); c.client.selectModel('fixture-model');
  c.server.set({status:503}); c.tui.startStartupGate(); await c.tui.handleKey('ArrowUp'); await c.tui.handleKey('Enter');
  await waitFor(()=>c.tui.computeFrameSnapshot().plainText.includes('Choose an account'));
  expect(c.tui.computeFrameSnapshot().plainText).toContain('Check failed');
  expect(c.app.accounts.get(account.id).status).not.toBe('invalid');
});

test('changed account during validation is checked again rather than entering chat', async () => {
  const c=await make(); const first=await c.app.accounts.add('startup','primary',{kind:'none'}); await c.client.discoverModels(); c.client.selectModel('fixture-model');
  const second=await c.app.accounts.add('startup','secondary',{kind:'none'}); c.client.useAccount(first.id); c.client.selectModel('fixture-model');
  c.server.set({delay:150}); c.tui.startStartupGate(); await c.tui.handleKey('ArrowUp'); await c.tui.handleKey('Enter');
  c.client.useAccount(second.id);
  await waitFor(()=>c.tui.computeFrameSnapshot().plainText.includes('Choose an account'));
  expect(c.tui.computeFrameSnapshot().plainText).toContain('changed during verification');
});

test('an account without a selected model must select one before entering chat', async () => {
  const c=await make(); await c.app.accounts.add('startup','primary',{kind:'none'});
  c.tui.startStartupGate(); await c.tui.handleKey('ArrowUp'); await c.tui.handleKey('Enter');
  await waitFor(()=>c.tui.getActiveOverlay()==='models');
  await c.tui.handleKey('Enter'); c.tui.advanceStartupGate();
  await waitFor(()=>!c.tui.computeFrameSnapshot().plainText.includes('Checking account'));
  expect(c.client.status().selection?.modelId).toBe('fixture-model');
  expect(c.tui.computeFrameSnapshot().plainText).not.toContain('Choose an account');
});

test('cancelling the startup check exits and never reports successful access', async () => {
  const c=await make(); await c.app.accounts.add('startup','primary',{kind:'none'}); await c.client.discoverModels(); c.client.selectModel('fixture-model');
  c.server.set({delay:300}); c.tui.startStartupGate(); await c.tui.handleKey('ArrowUp'); await c.tui.handleKey('Enter');
  expect(c.tui.computeFrameSnapshot().plainText).toContain('Checking account');
  await c.tui.handleKey('Escape'); expect(c.tui.isExitRequested()).toBe(true);
  await c.tui.shutdown(); expect(c.tui.computeFrameSnapshot().plainText).not.toContain('Choose an account');
});

test('dismissing the model picker during startup never re-sends a billed check', async () => {
  const c=await make(); await c.app.accounts.add('startup','primary',{kind:'none'});
  c.tui.startStartupGate(); await c.tui.handleKey('ArrowUp'); await c.tui.handleKey('Enter');
  await waitFor(()=>c.tui.getActiveOverlay()==='models');
  const probes=()=>c.server.requests.filter(r=>r.body?.messages?.[0]?.content==='Reply with OK.').length;
  expect(probes()).toBe(0); // choosing a model needs the list, not a generation
  await c.tui.handleKey('Escape'); c.tui.advanceStartupGate();
  for (let i=0;i<5;i++) { c.tui.advanceStartupGate(); await Bun.sleep(5); }
  expect(c.tui.getActiveOverlay()).toBe('none');
  expect(c.tui.computeFrameSnapshot().plainText).toContain('No model selected');
  expect(probes()).toBe(0);
});

test('nothing is sent to the provider before consent and verification', async () => {
  const c=await make(); await c.app.accounts.add('startup','primary',{kind:'none'}); await c.client.discoverModels(); c.client.selectModel('fixture-model');
  c.tui.startStartupGate(); const before=c.server.requests.length;
  await c.tui.submitPrompt('hello before consent');
  expect(c.server.requests.length).toBe(before); expect(c.tui.getTranscript().length).toBe(0);
});

test('workspace-reading features stay locked until the folder is approved, and in non-interactive runs', async () => {
  const c=await make(); await c.app.accounts.add('startup','primary',{kind:'none'}); await c.client.discoverModels(); c.client.selectModel('fixture-model');
  c.tui.startStartupGate();
  c.tui.openOverlay('diff');
  expect(c.tui.getActiveOverlay()).toBe('none'); expect(c.tui.getStatusBanner()).toContain('Workspace access');
  await c.tui.handleKey('ArrowUp'); await c.tui.handleKey('Enter'); // approve
  await waitFor(()=>!c.tui.computeFrameSnapshot().plainText.includes('Checking account'));
  c.tui.openOverlay('diff'); expect(c.tui.getActiveOverlay()).toBe('diff');
  c.tui.openOverlay('none'); c.tui.denyWorkspaceAccess(); // what a non-TTY run does
  c.tui.openOverlay('diff'); expect(c.tui.getActiveOverlay()).toBe('none');
});
