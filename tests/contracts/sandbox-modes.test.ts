import {expect, spyOn, test} from 'bun:test';
import {mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {Server} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DEFAULT_SANDBOX_CONFIG, NativeCommandRuntime, SandboxProxy, ToolDispatcher} from '@cosmew/tools';
import {SessionGrants} from '@cosmew/security';
import {WorkspaceRoot} from '@cosmew/workspace';

for (const failure of ['missing backend', 'failed self-test']) {
  for (const mode of ['escape', 'excluded', 'disabled', 'required']) {
    test(`${failure}: ${mode} command respects its effective sandbox`, async () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'cosmew-sandbox-mode-')));
      const runtime = new NativeCommandRuntime({workspaceRoot: root, platform: 'win32'});
      // Missing backend is real; the self-test variant injects only the health-check failure,
      // while the approved command still uses the real native launcher and shell.
      const health =
        failure === 'failed self-test'
          ? spyOn(runtime, 'availability').mockReturnValue({ok: false, reason: 'The native sandbox self-test failed.'})
          : undefined;
      const launches = spyOn(runtime, 'run');
      let approvals = 0;
      const dispatcher = new ToolDispatcher({
        workspace: new WorkspaceRoot(root),
        grants: new SessionGrants(),
        commands: runtime,
        sandbox: () => ({
          ...DEFAULT_SANDBOX_CONFIG,
          readOnly: false,
          allowUnsandboxed: true,
          enabled: mode !== 'disabled',
          excludedCommands: mode === 'excluded' ? ['printf'] : [],
          permissionMode: 'default',
        }),
        redact: text => text,
        approve: async () => {
          approvals++;
          return 'once';
        },
      });
      try {
        const result = await dispatcher.invoke({
          id: crypto.randomUUID(),
          name: 'exec_command',
          input: {
            cmd: 'printf sandbox-mode-output',
            ...(mode === 'escape'
              ? {dangerouslyDisableSandbox: true, justification: 'test approved host execution'}
              : {}),
          },
        });
        if (mode === 'required') {
          expect(result.status).toBe('error');
          expect(result.code).toBe('SANDBOX_UNAVAILABLE');
          expect(launches).not.toHaveBeenCalled();
          expect(result.content).toContain('Nothing was run.');
        } else {
          expect(result.status).toBe('ok');
          expect(result.content).toContain('sandbox-mode-output');
          expect(approvals).toBe(1);
          expect(launches).toHaveBeenCalledTimes(1);
          // Health may be consulted to decide whether the tool is offered; it must not gate this launch (status ok above).
        }
      } finally {
        health?.mockRestore();
        await runtime.shutdown();
        rmSync(root, {recursive: true, force: true});
      }
    });
  }
}

test('proxy startup lifecycle retries a rejected bind and shares subsequent startup', async () => {
  const proxy = new SandboxProxy({decide: async () => false});
  const listen = spyOn(Server.prototype, 'listen').mockImplementationOnce(function (this: Server) {
    queueMicrotask(() => this.emit('error', Object.assign(new Error('first bind failed'), {code: 'EADDRINUSE'})));
    return this;
  });
  try {
    await expect(proxy.start()).rejects.toThrow('first bind failed');
    // Drive the bind callback without opening a port: this proves promise lifecycle only.
    // Real loopback binding is covered by sandbox-proxy.test.ts, not by this synthetic bind.
    listen.mockImplementation(function (this: Server, ...args: unknown[]) {
      spyOn(this, 'address').mockReturnValue({address: '127.0.0.1', family: 'IPv4', port: 12345});
      queueMicrotask(() => (args.at(-1) as () => void)());
      return this;
    });
    const url = await proxy.start();
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(await proxy.start()).toBe(url);
  } finally {
    listen.mockRestore();
    await proxy.stop();
  }
});
