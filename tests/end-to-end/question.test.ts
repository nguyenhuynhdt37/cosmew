import {afterEach, expect, test} from 'bun:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {SessionGrants} from '@futryn/security';
import {ToolDispatcher} from '@futryn/tools';
import {FutrynTuiApp} from '@futryn/tui';
import {WorkspaceRoot} from '@futryn/workspace';
import {startup} from '../../apps/cli/src/bootstrap/startup';
import {fixtureServer, memoryVault, type ScriptedReply, type ScriptedView} from '../fixtures';

/** ADR 0042: request_user_input — answer, multiple, Other, dismiss, cancel, non-interactive, restart. */

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

const QUESTIONS = {
  questions: [
    {
      id: 'db',
      header: 'Database',
      question: 'Which database should the service use?',
      options: [
        {label: 'Postgres (Recommended)', description: 'Matches production.'},
        {label: 'SQLite', description: 'Simplest locally.'},
      ],
    },
    {
      id: 'checks',
      header: 'Checks',
      question: 'Which checks should run?',
      multiple: true,
      options: [
        {label: 'Unit', description: 'Fast.'},
        {label: 'E2E', description: 'Slow.'},
      ],
    },
  ],
};

function dirs() {
  const home = mkdtempSync(join(tmpdir(), 'futryn-ask-home-')),
    root = mkdtempSync(join(tmpdir(), 'futryn-ask-project-'));
  cleanup.push(
    () => rmSync(home, {recursive: true, force: true}),
    () => rmSync(root, {recursive: true, force: true}),
  );
  return {home, root};
}

async function open(
  d: {home: string; root: string},
  script: (view: ScriptedView) => ScriptedReply,
  options: {tui?: boolean; reuse?: ReturnType<typeof fixtureServer>; fetch?: typeof fetch} = {},
) {
  const server = options.reuse ?? fixtureServer();
  if (!options.reuse) cleanup.push(() => server.server.stop(true));
  server.set({script});
  const app = startup(d.home, {vault: memoryVault(), fetch: options.fetch});
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await app.shutdownCommands();
    app.db.close();
  };
  cleanup.push(close);
  if (!options.reuse) {
    app.registry.add(server.provider('chat', {id: 'ask-model', auth: 'none'}));
    await app.accounts.add('ask-model', 'fixture', {kind: 'none'});
  }
  const client = app.createFutrynClient(d.root);
  await client.discoverModels();
  client.selectModel('fixture-model');
  client.setToolsEnabled(true);
  let tui: FutrynTuiApp | undefined;
  if (options.tui !== false) {
    tui = new FutrynTuiApp({client, cols: 110, rows: 34});
    await tui.initialize();
    cleanup.push(() => tui!.shutdown());
  }
  return {app, client, tui, server, close};
}

const askThenEcho = (view: ScriptedView): ScriptedReply => {
  const answer = view.results.find(r => r.name === 'request_user_input');
  return answer ? {text: 'GOT ' + answer.content} : {calls: [{name: 'request_user_input', input: QUESTIONS}]};
};

async function waitForQuestion(c: Awaited<ReturnType<typeof open>>) {
  const end = Date.now() + 4000;
  while (!c.client.listPendingQuestions().length && Date.now() < end) await Bun.sleep(5);
  expect(c.client.listPendingQuestions()).toHaveLength(1);
  c.tui!.advanceStartupGate();
  expect(c.tui!.getActiveOverlay()).toBe('question');
}

test('answers with a single choice, a multiple choice and free text reach the model as Codex JSON', async () => {
  const c = await open(dirs(), askThenEcho);
  const turn = c.tui!.submitPrompt('Set up the service');
  await waitForQuestion(c);
  const frame = c.tui!.computeFrameSnapshot().plainText;
  expect(frame).toContain('Which database should the service use?');
  expect(frame).toContain('Postgres (Recommended)');
  expect(frame).toContain('Other:');
  // Enter with nothing chosen on the second question jumps there and asks for an answer.
  await c.tui!.handleKey('1');
  await c.tui!.handleKey('Enter');
  expect(c.client.listPendingQuestions()).toHaveLength(1);
  expect(c.tui!.computeFrameSnapshot().plainText).toContain('Answer every question');
  // Multiple: toggle both options, then add free text via Other.
  await c.tui!.handleKey('1');
  await c.tui!.handleKey('2');
  await c.tui!.handleKey('3');
  for (const ch of 'lint') await c.tui!.handleKey(ch);
  await c.tui!.handleKey('Enter');
  await turn;
  const text = c.tui!.getTranscript().at(-1)!.content;
  expect(text).toContain('GOT {"answers":');
  const answers = JSON.parse(text.slice(4)).answers;
  expect(answers).toEqual({db: {answers: ['Postgres (Recommended)']}, checks: {answers: ['Unit', 'E2E', 'lint']}});
  expect(c.tui!.getActiveOverlay()).toBe('none');
  expect(c.tui!.computeFrameSnapshot().plainText).toContain('⏺ Ask(Database, Checks)');
});

test('Esc dismisses: the model is told and continues; nothing is granted', async () => {
  const c = await open(dirs(), askThenEcho);
  const turn = c.tui!.submitPrompt('Set up');
  await waitForQuestion(c);
  await c.tui!.handleKey('Escape');
  await turn;
  expect(c.tui!.getTranscript().at(-1)!.content).toContain('The user dismissed this question');
  expect(c.client.listToolGrants()).toEqual([]);
});

test('cancelling the turn removes the waiting question and no answer is sent', async () => {
  const c = await open(dirs(), askThenEcho, {tui: false});
  c.client.setUserInputAvailable(true);
  const controller = new AbortController();
  const run = (async () => {
    for await (const _ of c.client.sendMessage('ask me', {signal: controller.signal})) {
      /* drain */
    }
  })();
  const end = Date.now() + 4000;
  while (!c.client.listPendingQuestions().length && Date.now() < end) await Bun.sleep(5);
  const id = c.client.listPendingQuestions()[0]!.questionId;
  controller.abort();
  await run.catch(() => undefined);
  expect(c.client.listPendingQuestions()).toEqual([]);
  expect(() => c.client.answerQuestion(id, {db: {answers: ['SQLite']}, checks: {answers: ['Unit']}})).toThrow();
  expect(c.server.requests.filter(r => r.body).length).toBe(1);
});

test('non-interactive runs never offer the tool; a direct call reports it unavailable', async () => {
  const c = await open(
    dirs(),
    view => ({text: view.tools.includes('request_user_input') ? 'OFFERED' : 'NOT OFFERED'}),
    {
      tui: false,
    },
  );
  let text = '';
  for await (const event of c.client.sendMessage('hi')) if (event.type === 'textDelta') text += event.text;
  expect(text).toBe('NOT OFFERED');
  const root = mkdtempSync(join(tmpdir(), 'futryn-ask-unit-'));
  cleanup.push(() => rmSync(root, {recursive: true, force: true}));
  const dispatcher = new ToolDispatcher({
    workspace: new WorkspaceRoot(root),
    grants: new SessionGrants(),
    approve: async () => 'deny',
    redact: t => t,
    agentState: {askUser: async () => ({kind: 'unavailable', reason: 'non-interactive'}), canAskUser: () => true},
  });
  const call = (input: unknown) => dispatcher.invoke({id: crypto.randomUUID(), name: 'request_user_input', input});
  expect(await call(QUESTIONS)).toMatchObject({status: 'error', code: 'UNAVAILABLE'});
  for (const bad of [
    {questions: []},
    {questions: [...QUESTIONS.questions, ...QUESTIONS.questions.map(q => ({...q, id: q.id + '2'}))]},
    {questions: [{...QUESTIONS.questions[0], header: 'A header that is too long'}]},
    {questions: [{...QUESTIONS.questions[0], options: [{label: 'Other', description: ''}]}]},
    {questions: [QUESTIONS.questions[0], QUESTIONS.questions[0]]},
  ])
    expect((await call(bad)).code).toBe('INVALID_INPUT');
});

test('an answered question is history: a restarted session never asks it again', async () => {
  const d = dirs();
  const first = await open(d, askThenEcho);
  const turn = first.tui!.submitPrompt('Set up');
  await waitForQuestion(first);
  await first.tui!.handleKey('2');
  await first.tui!.handleKey('ArrowRight');
  await first.tui!.handleKey('1');
  await first.tui!.handleKey('Enter');
  await turn;
  const id = first.client.activeSession()!.id;
  await first.close();
  const second = await open(d, view => ({text: view.results.length ? 'REMEMBERED' : 'FORGOT'}), {reuse: first.server});
  second.client.resumeSession(id);
  await second.tui!.submitPrompt('continue');
  expect(second.client.listPendingQuestions()).toEqual([]);
  expect(second.tui!.getTranscript().at(-1)!.content).toContain('REMEMBERED');
  expect(JSON.stringify(second.server.requests.at(-1)!.body)).toContain('SQLite');
});

test('pending question UI text redacts registered secrets and terminal controls before display', async () => {
  const c = await open(dirs(), () => ({text: 'ready'}));
  const secret = 'registered-question-secret';
  c.app.redactor.register(secret);
  const questions = [
    {
      ...QUESTIONS.questions[0]!,
      header: 'Secret',
      question: secret + '\u001b[31m',
      options: [
        {label: secret, description: secret},
        {label: 'safe', description: 'safe'},
      ],
    },
  ];
  const answer = c.client.askUser(questions);
  const pending = c.client.listPendingQuestions()[0]!;
  expect(JSON.stringify(pending)).not.toContain(secret);
  expect(JSON.stringify(pending)).not.toContain('\\u001b');
  c.client.answerQuestion(pending.questionId, {db: {answers: [pending.questions[0]!.options[0]!.label]}});
  expect(await answer).toEqual({kind: 'answered', answers: {db: {answers: ['[REDACTED]']}}});
});

test('a new project deny revokes dispatcher and prompt session grants before another search', async () => {
  let query = 'first';
  let networkCalls = 0;
  const c = await open(
    dirs(),
    view =>
      view.results.some(r => r.input.query === query)
        ? {text: 'done'}
        : {calls: [{name: 'web_search', input: {query}}]},
    {
      fetch: (async (_input, init) => {
        if (!String(_input).includes('mcp.exa.ai')) return fetch(_input, init);
        const request = JSON.parse(String(init?.body)) as {method: string; id?: number};
        if (request.method === 'notifications/initialized') return new Response(null, {status: 202});
        if (request.method === 'initialize')
          return Response.json({
            jsonrpc: '2.0',
            id: request.id,
            result: {
              protocolVersion: '2025-03-26',
              capabilities: {tools: {}},
              serverInfo: {name: 'fixture', version: '1'},
            },
          });
        if (request.method === 'tools/call') {
          networkCalls++;
          return Response.json({
            jsonrpc: '2.0',
            id: request.id,
            result: {content: [{type: 'text', text: 'Title: Fixture\nURL: https://example.com/\nText: result'}]},
          });
        }
        return new Response(null, {status: 405});
      }) as typeof fetch,
    },
  );
  c.client.addPermissionRule('ask', 'Tool(web_search)');
  const first = c.tui!.submitPrompt('search first');
  const until = Date.now() + 4000;
  while (!c.client.listPendingPermissions().length && Date.now() < until) await Bun.sleep(5);
  const permission = c.client.listPendingPermissions()[0]!;
  expect(permission).toBeDefined();
  c.client.resolvePermission(permission.approvalId, permission.scopeHash, 'session');
  await first;
  expect(networkCalls).toBe(1);
  expect(c.client.listToolGrants().length).toBeGreaterThan(0);
  c.client.addPermissionRule('deny', 'Tool(web_search)');
  query = 'second';
  await c.tui!.submitPrompt('search second');
  expect(networkCalls).toBe(1);
  expect(c.client.listToolGrants()).toEqual([]);
});

test('a new deny invalidates a pending command approval before an old dialog can authorize it', async () => {
  const c = await open(dirs(), () => ({text: 'ready'}));
  const waiting = c.client.requestPermission({
    capability: 'process.execute',
    kind: 'execute',
    target: 'echo blocked',
    ruleTarget: 'echo blocked',
    action: 'Run fixture command',
    reason: 'fixture',
    riskLevel: 'high',
  });
  const request = c.client.listPendingPermissions()[0]!;
  expect(request).toBeDefined();
  c.client.addPermissionRule('deny', 'Bash(echo blocked)');
  const stale = c.client.listPendingPermissions().some(p => p.approvalId === request.approvalId);
  if (stale) c.client.resolvePermission(request.approvalId, request.scopeHash, 'once');
  expect(await waiting).toBe('deny');
  expect(() => c.client.resolvePermission(request.approvalId, request.scopeHash, 'once')).toThrow();
});
