import {expect, test} from 'bun:test';
import {dialogFixture, selection} from '../features/picker/test-fixture';
import {openInk} from './ink-session';

for (const width of [40, 80])
  test(`read-only session mode is visible even when sandbox is off at ${width} columns`, async () => {
    let calls = 0;
    const {client} = dialogFixture({
      startSession: () => ({id: 'owner', selection, messages: []}),
      async *sendTurn() {
        calls++;
      },
    });
    client.createSession();
    const ui = await openInk(client, {width, rows: 24});
    try {
      expect(client.status().sandbox.enabled).toBe(false);
      client.setMode('review');
      await ui.waitFor('Review · read-only', 1000);
      expect(ui.frame()).toContain('/chat');
      client.setMode('plan');
      await ui.waitFor('Plan · read-only', 1000);
      await ui.executeSlashCommand('/chat');
      expect(client.mode()).toBe('chat');
      expect(ui.frame()).not.toContain('Review · read-only');
      expect(ui.frame()).not.toContain('Plan · read-only');
      expect(client.status().sandbox.enabled).toBe(false);
      expect(calls).toBe(0);
    } finally {
      await ui.close();
    }
  });
