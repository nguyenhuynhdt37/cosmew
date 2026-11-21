import {afterEach, expect, test} from 'bun:test';
import {mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {PlanState} from '@cosmew/contracts';
import {SessionGrants} from '@cosmew/security';
import {ToolDispatcher} from '@cosmew/tools';
import {WorkspaceRoot} from '@cosmew/workspace';
const secret = 'registered-secret-for-regression';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true});
});
function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'fyn-redact-')));
  roots.push(root);
  const saved: PlanState[] = [];
  const tools = new ToolDispatcher({
    workspace: new WorkspaceRoot(root),
    grants: new SessionGrants(),
    approve: async () => 'deny',
    redact: t => t.replaceAll(secret, '[REDACTED]'),
    agentState: {updatePlan: p => saved.push(p)},
  });
  return {root, saved, call: (name: string, input: unknown) => tools.invoke({id: crypto.randomUUID(), name, input})};
}
test('notebook attachment names redact registered secrets before leaving the dispatcher', async () => {
  const s = setup();
  const path = secret + '.ipynb';
  writeFileSync(
    join(s.root, path),
    JSON.stringify({cells: [{cell_type: 'code', outputs: [{data: {'image/png': png}}]}]}),
  );
  const result = await s.call('read', {path});
  expect(result.status).toBe('ok');
  expect(result.attachments).toHaveLength(1);
  expect(JSON.stringify(result)).not.toContain(secret);
});
test('plan labels are redacted before the durable-state callback or UI sees them', async () => {
  const s = setup();
  const result = await s.call('update_plan', {
    explanation: secret,
    plan: [{step: secret, status: 'in_progress', activeForm: secret}],
  });
  expect(result.status).toBe('ok');
  expect(s.saved).toHaveLength(1);
  expect(JSON.stringify(s.saved)).not.toContain(secret);
  expect(s.saved[0]!.items[0]!.step).toBe('[REDACTED]');
});

test('UTF-8 Unicode registered secrets in media cannot leave as base64 attachments', async () => {
  const s = setup();
  const unicode = 'bí-mật-🔑-token';
  const tools = new ToolDispatcher({
    workspace: new WorkspaceRoot(s.root),
    grants: new SessionGrants(),
    approve: async () => 'deny',
    redact: t => t.replaceAll(unicode, '[REDACTED]'),
  });
  writeFileSync(join(s.root, 'unicode.pdf'), '%PDF-1.4\n' + unicode + '\n%%EOF');
  const result = await tools.invoke({id: crypto.randomUUID(), name: 'read', input: {path: 'unicode.pdf'}});
  expect(result.code).toBe('SECRET_IN_MEDIA');
  expect(result.attachments).toBeUndefined();
});
