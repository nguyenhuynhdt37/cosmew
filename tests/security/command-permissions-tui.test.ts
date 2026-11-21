import {expect, test} from 'bun:test';
import {mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {CommandRequest, CommandRuntime} from '@cosmew/contracts';
import {SessionGrants} from '@cosmew/security';
import {ToolDispatcher} from '@cosmew/tools';
import {WorkspaceRoot} from '@cosmew/workspace';
import {toolPermissionRequest} from '../../apps/cli/src/bootstrap/approvals';
import {dialogFixture} from '../../apps/tui/src/ink/features/picker/test-fixture';
import {openInk, type InkSession} from '../../apps/tui/src/ink/testing/ink-session';
import {waitForFrame} from '../../apps/tui/src/ink/testing/wait';

const cases = [
  {name: 'disabled', enabled: false, excludedCommands: [], input: {cmd: 'echo fixture'}, focus: '❯ 1. Yes'},
  {name: 'sandboxed', enabled: true, excludedCommands: [], input: {cmd: 'echo fixture'}, focus: '❯ 1. Yes'},
  {
    name: 'escape',
    enabled: true,
    excludedCommands: [],
    input: {cmd: 'echo fixture', dangerouslyDisableSandbox: true, justification: 'Fixture needs host access'},
    focus: '❯ 3. No',
  },
  {name: 'excluded', enabled: true, excludedCommands: ['echo'], input: {cmd: 'echo fixture'}, focus: '❯ 4. No'},
] as const;

for (const width of [80, 36]) {
  for (const scenario of cases) {
    test(`Bash permission with sandbox ${scenario.name} at ${width} columns`, async () => {
      const directory = mkdtempSync(join(tmpdir(), 'cosmew-ink-permission-'));
      const root = realpathSync.native(directory);
      const launches: CommandRequest[] = [];
      const commands: CommandRuntime = {
        id: 'command-permission-fixture',
        label: 'fixture',
        availability: () => ({ok: true}),
        capabilities: () => ({
          modes: ['workspace-write', 'danger-full-access'],
          network: true,
          tty: false,
          unsandboxed: true,
          shells: ['bash'],
          tools: [],
        }),
        async run(request) {
          launches.push(request);
          return {
            kind: 'exited',
            exitCode: 0,
            signal: null,
            output: 'fixture command ran',
            omittedBytes: 0,
            durationMs: 1,
          };
        },
      };
      const {client} = dialogFixture();
      client.trustWorkspace();
      const dispatcher = new ToolDispatcher({
        workspace: new WorkspaceRoot(root),
        grants: new SessionGrants(),
        commands,
        sandbox: () => ({
          enabled: scenario.enabled,
          autoAllowBash: false,
          allowUnsandboxed: true,
          excludedCommands: [...scenario.excludedCommands],
          additionalDirectories: [],
          network: false,
          permissionMode: client.permissionMode(),
        }),
        redact: text => text,
        approve: (request, signal) => client.requestPermission(toolPermissionRequest(request), signal),
      });
      const abort = new AbortController();
      let ink: InkSession | undefined;
      let pending: ReturnType<ToolDispatcher['invoke']> | undefined;
      try {
        ink = await openInk(client, {width});
        pending = dispatcher.invoke({id: 'fixture-bash', name: 'exec_command', input: scenario.input}, abort.signal);
        const current = {lastFrame: ink.frame};
        await ink.nextPermission();
        const frame = await waitForFrame(current, frame => frame.includes('Bash command'));
        const warning = scenario.name === 'escape' || scenario.name === 'excluded';
        expect(frame.includes('NO SANDBOX')).toBe(warning);
        expect(frame.replace(/\s+/g, ' ').includes('full user permissions')).toBe(warning);
        expect(frame).toContain(scenario.focus);
        const sandboxHint = width === 36 ? 'sandbox off · /sandbox to enable' : 'sandbox off · /sandbox to turn it on';
        expect(frame.includes(sandboxHint)).toBe(scenario.name === 'disabled');
        expect(launches).toEqual([]);
        await ink.handleKey(scenario.name === 'sandboxed' ? 'Escape' : 'Enter');
        await waitForFrame(current, frame => !frame.includes('Bash command'));
        const result = await pending;
        if (scenario.name === 'disabled') {
          expect(result.status).toBe('ok');
          expect(result.content).toContain('fixture command ran');
          expect(launches).toHaveLength(1);
          expect(launches[0]).toMatchObject({command: 'echo fixture', sandbox: {unsandboxed: true}});
        } else {
          expect(result.status).toBe('denied');
          expect(launches).toEqual([]);
        }
      } finally {
        abort.abort();
        await pending?.catch(() => undefined);
        await ink?.close();
        rmSync(directory, {recursive: true, force: true});
      }
    });
  }
}
