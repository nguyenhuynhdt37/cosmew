/** Actual editor process over the full Ink shell; SDK owns publishing the reviewed text. */
import {expect, test} from 'bun:test';
import {mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {ModelEvent, PlanApprovalOutcome} from '@cosmew/contracts';
import {dialogFixture, selection} from '../features/picker/test-fixture';
import {openInk} from './ink-session';

test.skipIf(process.platform === 'win32')(
  'plan Ctrl+G runs VISUAL on a private copy, preserves plan mode and approves reviewed text',
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'futryn-plan-editor-test-'));
    const editor = join(dir, 'editor');
    const copy = join(dir, 'copy.md');
    const oldVisual = process.env.VISUAL;
    await writeFile(editor, `#!/bin/sh\n/bin/cp -p "$1" "${copy}"\nprintf '# Edited by real editor\\n' > "$1"\n`, {
      mode: 0o700,
    });
    process.env.VISUAL = editor;
    let client: ReturnType<typeof dialogFixture>['client'];
    let outcome: PlanApprovalOutcome | undefined;
    const f = dialogFixture({
      validateAccount: async () => ({models: 1, validation: 'fixture'}),
      startSession: () => ({id: 'editor-session', selection, messages: []}),
      async *sendTurn(_id, _content, signal): AsyncIterable<ModelEvent> {
        outcome = await client.proposePlan('# Original proposal', signal);
      },
    });
    client = f.client;
    const ui = await openInk(client, {width: 100, rows: 24});
    try {
      client.setPermissionMode('plan');
      await ui.submit('plan it');
      await ui.waitFor('Ready to code?');
      await ui.press('\x07');
      await ui.waitFor('Plan updated. Review before approving.');
      expect(await readFile(copy, 'utf8')).toBe('# Original proposal');
      expect((await stat(copy)).mode & 0o777).toBe(0o600);
      expect(client.pendingPlanApproval()?.plan).toBe('# Edited by real editor');
      expect(client.permissionMode()).toBe('plan');
      const reviewed = client.pendingPlanApproval();
      await writeFile(editor, '#!/bin/sh\nprintf discarded > "$1"\nexit 7\n', {mode: 0o700});
      await ui.press('\x07');
      await ui.waitFor('Action failed; review current state and retry.');
      expect(client.pendingPlanApproval()).toEqual(reviewed);
      expect(client.permissionMode()).toBe('plan');
      await ui.press('2');
      await ui.idle();
      expect(outcome).toEqual({kind: 'approved', mode: 'manual', plan: '# Edited by real editor'});
      expect(client.permissionMode()).toBe('default');
    } finally {
      await ui.close();
      if (oldVisual === undefined) delete process.env.VISUAL;
      else process.env.VISUAL = oldVisual;
      await rm(dir, {recursive: true, force: true});
    }
  },
);
