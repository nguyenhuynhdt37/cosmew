import {afterEach, expect, test} from 'bun:test';
import {mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startup} from '../../apps/cli/src/bootstrap/startup';
import {routeCommand} from '../../apps/tui/src/ink/features/commands';
import {account, model, provider, selection} from '../../apps/tui/src/ink/features/picker/test-fixture';
import {memoryVault} from '../fixtures';
const close: (() => void)[] = [];
afterEach(() => {
  for (const fn of close.splice(0).reverse()) fn();
});
function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'p3-diff-regression-')));
  const root = join(dir, 'project');
  mkdirSync(root);
  const app = startup(join(dir, 'state'), {vault: memoryVault()});
  close.push(
    () => rmSync(dir, {recursive: true, force: true}),
    () => app.db.close(),
  );
  app.settings.update(s => {
    s.providers = [provider];
    s.accounts = [account];
    s.activeAccountId = account.id;
    s.selection = selection;
    s.catalogs = [
      {accountId: account.id, providerFingerprint: 'fixture', fetchedAt: new Date().toISOString(), models: [model]},
    ];
  });
  app.catalog(account).manual(model.id);
  const client = app.createFutrynClient(root);
  client.setToolsEnabled(true);
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(
      ['/usr/bin/git', '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args],
      {cwd: root},
    );
    expect(r.exitCode).toBe(0);
  };
  return {app, client, root, git};
}
async function review(client: ReturnType<typeof fixture>['client']) {
  const submitted: string[] = [];
  const notices: string[] = [];
  await routeCommand(
    {
      client,
      busy: () => false,
      open: () => {},
      notice: t => notices.push(t),
      reset: () => {},
      submit: t => {
        submitted.push(t);
        return true;
      },
      exit: () => {},
    },
    '/review focus on value.ts',
  );
  return {submitted, notices};
}
test('default SDK diff detects real shell writes against the session snapshot without patch receipts', async () => {
  const {client, root} = fixture();
  writeFileSync(join(root, 'value.ts'), 'pre-existing uncommitted content\n');
  client.createSession();
  expect((await client.refreshWorkspaceDiff()).files).toEqual([]);
  const shell = Bun.spawnSync(
    [
      '/bin/sh',
      '-c',
      "mkdir -p src; printf 'export const add = (a, b) => a + b;\\n' > src/math.ts; printf 'changed by shell\\n' > value.ts",
    ],
    {cwd: root},
  );
  expect(shell.exitCode).toBe(0);
  const report = await client.refreshWorkspaceDiff();
  expect(report.base).toBe('session');
  expect(report.files.find(f => f.path === 'src/math.ts')?.lines.some(l => l.content.includes('a + b'))).toBe(true);
  expect(
    report.files
      .find(f => f.path === 'value.ts')
      ?.lines.some(l => l.type === 'del' && l.content === 'pre-existing uncommitted content'),
  ).toBe(true);
});
test('review explicitly collects real uncommitted Git changes before a session exists', async () => {
  const {client, root, git} = fixture();
  git('init', '-q');
  writeFileSync(join(root, 'value.ts'), 'export const value = 1;\n');
  git('add', '.');
  git('commit', '-qm', 'baseline');
  writeFileSync(join(root, 'value.ts'), 'export const value = 0;\n');
  expect(client.activeSession()).toBeNull();
  const {submitted} = await review(client);
  expect(submitted).toHaveLength(1);
  expect(submitted[0]).toContain('export const value = 0;');
  expect(client.mode()).toBe('review');
  expect(readFileSync(join(root, 'value.ts'), 'utf8')).toContain('value = 0');
});
test('review submits ask-policy file metadata while withholding its old and new Git contents', async () => {
  const {client, root, git} = fixture();
  git('init', '-q');
  writeFileSync(join(root, 'value.ts'), 'before\n');
  writeFileSync(join(root, '.env'), 'API_TOKEN=old-private-value\n');
  git('add', '.');
  git('commit', '-qm', 'baseline');
  writeFileSync(join(root, 'value.ts'), 'after\n');
  writeFileSync(join(root, '.env'), 'API_TOKEN=new-private-value\n');
  const {submitted} = await review(client);
  expect(submitted).toHaveLength(1);
  expect(submitted[0]).toContain('"path":".env"');
  expect(submitted[0]).toContain('contentWithheld');
  expect(submitted[0]).toContain('after');
  expect(submitted[0]).not.toContain('old-private-value');
  expect(submitted[0]).not.toContain('new-private-value');
});

test('a persisted whole-workspace baseline survives SDK resume and still discovers shell-only files', async () => {
  const {CheckpointStore} = await import('@cosmew/persistence');
  const {captureWorkspaceDiffSnapshot} = await import('@cosmew/workspace');
  const {app, client, root} = fixture();
  writeFileSync(join(root, 'value.ts'), 'before shell\n');
  const session = client.createSession();
  const store = new CheckpointStore(app.db);
  const checkpoint = store.begin(session.id, root, 'first', []);
  store.saveWorkspaceDiffSnapshot(
    checkpoint,
    captureWorkspaceDiffSnapshot(
      root,
      () => true,
      text => text,
    ),
  );
  app.conversations.append(session.id, {role: 'user', content: 'first'}, 'committed');
  const shell = Bun.spawnSync(
    ['/bin/sh', '-c', "printf 'after shell\\n' > value.ts; printf 'new from shell\\n' > created.ts"],
    {cwd: root},
  );
  expect(shell.exitCode).toBe(0);
  const resumed = app.createFutrynClient(root);
  resumed.setToolsEnabled(true);
  resumed.resumeSession(session.id);
  const report = await resumed.refreshWorkspaceDiff();
  expect(report.files.find(f => f.path === 'created.ts')?.lines.some(l => l.content === 'new from shell')).toBe(true);
  expect(
    report.files.find(f => f.path === 'value.ts')?.lines.some(l => l.type === 'del' && l.content === 'before shell'),
  ).toBe(true);
});

test('review keeps its original mode and refuses submission when the session changes during collection', async () => {
  const {client, root, git} = fixture();
  git('init', '-q');
  writeFileSync(join(root, 'value.ts'), 'changed\n');
  client.createSession();
  const report = await client.refreshWorkspaceDiff({base: 'uncommitted'});
  let finish!: (value: typeof report) => void;
  let collectionStarted!: () => void;
  const collecting = new Promise<void>(resolve => {
    collectionStarted = resolve;
  });
  client.refreshWorkspaceDiff = () =>
    new Promise(resolve => {
      finish = resolve;
      collectionStarted();
    });
  const running = review(client);
  await collecting;
  expect(client.mode()).toBe('chat');
  client.clearSessionView();
  finish(report);
  const result = await running;
  expect(result.submitted).toEqual([]);
  expect(result.notices).toContain('Review cancelled: conversation changed.');
  expect(client.mode()).toBe('chat');
});

test('workspace snapshot respects read filtering and refuses registered secrets before durable storage', async () => {
  const {captureWorkspaceDiffSnapshot} = await import('@cosmew/workspace');
  const {CheckpointStore} = await import('@cosmew/persistence');
  const {app, client, root} = fixture();
  writeFileSync(join(root, 'value.ts'), 'REGISTERED-SECRET\n');
  writeFileSync(join(root, '.env'), 'ASK-PATH-CONTENT\n');
  const snapshot = captureWorkspaceDiffSnapshot(
    root,
    path => path !== '.env',
    text => text.replaceAll('REGISTERED-SECRET', '[redacted]'),
  );
  expect(snapshot.reason).toContain('redacted');
  expect(JSON.stringify(snapshot)).not.toContain('REGISTERED-SECRET');
  expect(JSON.stringify(snapshot)).not.toContain('ASK-PATH-CONTENT');
  const session = client.createSession();
  const store = new CheckpointStore(app.db, text => text.replaceAll('REGISTERED-SECRET', '[redacted]'));
  const id = store.begin(session.id, root, 'first', []);
  store.saveWorkspaceDiffSnapshot(id, {files: [{path: 'value.ts', before: 'REGISTERED-SECRET'}]});
  expect(JSON.stringify(store.workspaceDiffSnapshot(session.id, root))).not.toContain('REGISTERED-SECRET');
});
