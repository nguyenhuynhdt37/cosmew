/** @jsxImportSource react */
import {render, renderToString} from 'ink';
import type {FutrynTuiOptions} from '../types';
import {ThemeEngine} from '../theme/theme';
import {FoundationNotice, InkApp, type AppSlots} from './app';

export function selectTuiRuntime(env: Record<string, string | undefined> = process.env): 'ink' | 'legacy' {
  return env.FUTRYN_TUI === 'ink' ? 'ink' : 'legacy';
}
export interface InkRuntimeOptions extends FutrynTuiOptions {
  initialCommand?: string;
  stdin?: NodeJS.ReadableStream & {isTTY?: boolean};
  stdout?: NodeJS.WritableStream & {isTTY?: boolean; columns?: number};
  stderr?: NodeJS.WritableStream;
  slots?: AppSlots;
}
/** The Phase 0 shell never starts generation, reads the workspace or advertises unanswered dialogs. */
export async function runInkTui(options: InkRuntimeOptions): Promise<void> {
  const stdout = options.stdout ?? process.stdout;
  const stdin = options.stdin ?? process.stdin;
  const interactive = Boolean(stdout.isTTY && stdin.isTTY);
  const engine = options.themeEngine ?? new ThemeEngine({client: options.client, env: options.env});
  options.client.setToolsEnabled(false);
  options.client.setUserInputAvailable(false);
  await engine.initialize();
  const tree = (
    <InkApp
      client={options.client}
      themeEngine={engine}
      width={options.cols}
      slots={options.slots ?? {status: <FoundationNotice initialCommand={options.initialCommand} />}}
    />
  );
  if (!interactive) {
    stdout.write(renderToString(tree, {columns: options.cols ?? stdout.columns ?? 80}) + '\n');
    return;
  }
  const instance = render(tree, {
    stdout,
    stdin,
    stderr: options.stderr,
    interactive: true,
    alternateScreen: false,
    exitOnCtrlC: false,
    patchConsole: false,
    maxFps: 30,
  });
  const stop = () => instance.unmount();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    await instance.waitUntilExit();
  } finally {
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
    instance.unmount();
    instance.cleanup();
    options.client.setToolsEnabled(false);
    options.client.setUserInputAvailable(false);
  }
}
