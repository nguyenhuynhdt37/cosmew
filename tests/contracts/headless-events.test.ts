import {afterEach, expect, test} from 'bun:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startup} from '../../apps/cli/src/bootstrap/startup';
import {memoryVault} from '../fixtures';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});
function client() {
  const dir = mkdtempSync(join(tmpdir(), 'fyn-interactions-'));
  const app = startup(join(dir, 'state'), {vault: memoryVault()});
  app.redactor.register('private-event-marker');
  cleanup.push(async () => {
    await app.shutdownCommands();
    app.db.close();
    rmSync(dir, {recursive: true, force: true});
  });
  return app.createFutrynClient(dir);
}

test('permission subscribers can resolve immediately, receive isolated sanitized requests and unsubscribe', async () => {
  const c = client();
  c.setPermissionMode('default');
  const observed: string[] = [];
  c.onInteractionEvent(event => {
    event.request.createdAt = 'mutated';
    throw new Error('observer failed');
  });
  const off = c.onInteractionEvent(event => {
    if (event.type !== 'permission.requested') return;
    expect(event.request.createdAt).not.toBe('mutated');
    expect(event.request.target).not.toContain('private-event-marker');
    observed.push(event.type);
    c.resolvePermission(event.request.approvalId, event.request.scopeHash, 'deny');
  });
  expect(
    await c.requestPermission({
      capability: 'fs.write',
      action: 'write',
      target: 'private-event-marker',
      reason: 'test',
    }),
  ).toBe('deny');
  expect(observed).toEqual(['permission.requested']);
  expect(c.listPendingPermissions()).toHaveLength(0);
  off();
  const abort = new AbortController();
  const pending = c.requestPermission(
    {capability: 'fs.write', action: 'write', target: 'next.txt', reason: 'test'},
    abort.signal,
  );
  await Promise.resolve();
  abort.abort();
  expect(await pending).toBe('deny');
  expect(observed).toHaveLength(1);
});

test('plan mode reports itself and denies network without emitting a prompt', async () => {
  const c = client();
  c.setPermissionMode('plan');
  expect(c.status().permissionMode).toBe('plan');
  let events = 0;
  c.onInteractionEvent(() => events++);
  expect(
    await c.requestPermission({
      capability: 'network.connect',
      action: 'connect',
      target: 'example.com',
      reason: 'network',
      kind: 'network',
    }),
  ).toBe('deny');
  expect(events).toBe(0);
  expect(c.listPendingPermissions()).toHaveLength(0);
});

test('questions are unavailable headlessly; attached subscribers answer synchronously and cancellation clears pending state', async () => {
  const c = client();
  const questions = [
    {
      id: 'q',
      header: 'Choose',
      question: 'private-event-marker',
      multiple: false,
      options: [
        {label: 'Yes', description: 'Continue'},
        {label: 'No', description: 'Stop'},
      ],
    },
  ];
  expect(await c.askUser(questions)).toMatchObject({kind: 'unavailable'});
  c.setUserInputAvailable(true);
  const off = c.onInteractionEvent(event => {
    if (event.type !== 'question.asked') return;
    expect(event.request.questions[0]!.question).not.toContain('private-event-marker');
    c.answerQuestion(event.request.questionId, {q: {answers: ['Yes']}});
  });
  expect(await c.askUser(questions)).toEqual({kind: 'answered', answers: {q: {answers: ['Yes']}}});
  off();
  const controller = new AbortController();
  const pending = c.askUser(questions, controller.signal);
  controller.abort();
  await expect(pending).rejects.toMatchObject({code: 'CANCELLED'});
  expect(c.listPendingQuestions()).toHaveLength(0);
});
