/** @jsxImportSource react */
import {render, renderToString} from 'ink';
import {BYPASS_PERMISSIONS_WARNING} from '@cosmew/contracts';
import type {FutrynTuiOptions} from '../types';
import {ThemeEngine} from '../theme/theme';
import {queryTerminalBackground} from '../theme/terminal-background';
import {FoundationNotice, InkApp, type AppSlots} from './app';
import {keybindingsLogPath, keybindingsPath, keymapStore, watchKeybindings} from './hooks';
import {createTerminalMouseInput} from '../input/mouse-input';
import {TerminalMouseProvider} from './hooks/use-terminal-wheel';

export interface InkRuntimeOptions extends FutrynTuiOptions {
  initialCommand?: string;
  stdin?: NodeJS.ReadableStream & {isTTY?: boolean};
  stdout?: NodeJS.WritableStream & {isTTY?: boolean; columns?: number};
  stderr?: NodeJS.WritableStream;
  slots?: AppSlots;
}
/** Interactive host owns cancellation; CLI retains backend ownership. */
export async function runInkTui(options: InkRuntimeOptions): Promise<void> {
  const stdout = options.stdout ?? process.stdout;
  const stdin = options.stdin ?? process.stdin;
  const interactive = Boolean(stdout.isTTY && stdin.isTTY);
  const engine = options.themeEngine ?? new ThemeEngine({client: options.client, env: options.env});
  options.client.setToolsEnabled(false);
  options.client.setUserInputAvailable(false);
  await engine.initialize();
  // Theme `auto` follows the terminal's real background (OSC 11, bounded wait), never the host OS appearance.
  if (interactive && engine.getActiveAppearance().mode === 'system')
    engine.applyTerminalBackground(
      await queryTerminalBackground({
        stdin: stdin as NodeJS.ReadStream,
        stdout: stdout as NodeJS.WriteStream,
      }),
    );
  let shutdown = async () => {};
  const registerShutdown = (fn: () => Promise<void>) => {
    shutdown = fn;
  };
  const tree = (
    <InkApp
      client={options.client}
      themeEngine={engine}
      width={options.cols}
      rows={options.rows}
      initialCommand={options.initialCommand}
      registerShutdown={registerShutdown}
      slots={
        options.slots ??
        (!interactive
          ? {
              status: (
                <FoundationNotice
                  initialCommand={options.initialCommand}
                  warning={
                    options.client.permissionMode() === 'bypassPermissions' ? BYPASS_PERMISSIONS_WARNING : undefined
                  }
                />
              ),
            }
          : undefined)
      }
    />
  );
  if (!interactive) {
    stdout.write(renderToString(tree, {columns: options.cols ?? stdout.columns ?? 80}) + '\n');
    return;
  }
  // User keybindings (~/.cosmew/keybindings.json, with legacy roots reused): loaded now, reloaded when the file changes. Never from the workspace.
  const stopKeybindings = watchKeybindings({
    path: keybindingsPath(),
    store: keymapStore,
    logPath: keybindingsLogPath(),
  });
  const mouse = createTerminalMouseInput(stdin, stdout);
  let instance: ReturnType<typeof render>;
  try {
    instance = render(<TerminalMouseProvider value={mouse}>{tree}</TerminalMouseProvider>, {
      stdout,
      stdin: mouse.stdin,
      stderr: options.stderr,
      interactive: true,
      alternateScreen: true,
      exitOnCtrlC: false,
      patchConsole: false,
      maxFps: 30,
      incrementalRendering: true,
    });
  } catch (error) {
    stopKeybindings();
    mouse.dispose();
    throw error;
  }
  const stop = () => {
    void shutdown().finally(() => instance.unmount());
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    await instance.waitUntilExit();
  } finally {
    stopKeybindings();
    mouse.dispose();
    try {
      await shutdown();
    } finally {
      process.off('SIGTERM', stop);
      process.off('SIGINT', stop);
      instance.unmount();
      instance.cleanup();
      options.client.setToolsEnabled(false);
      options.client.setUserInputAvailable(false);
    }
    const sessionId = options.client.activeSession()?.id;
    if (sessionId) {
      const line = `Resume this session with: cosmew --resume ${sessionId}`;
      stdout.write((engine.colorCapability === 'none' ? line : `\x1b[2m${line}\x1b[22m`) + '\n');
    }
  }
}
