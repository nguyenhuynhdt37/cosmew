/** @jsxImportSource react */
import {render, renderToString} from 'ink';
import {FULL_ACCESS_WARNING} from '@futryn/contracts';
import type {FutrynTuiOptions} from '../types';
import {ThemeEngine} from '../theme/theme';
import {FoundationNotice, InkApp, type AppSlots} from './app';

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
  let shutdown = async () => {};
  const registerShutdown = (fn: () => Promise<void>) => {
    shutdown = fn;
  };
  const tree = (
    <InkApp
      client={options.client}
      themeEngine={engine}
      width={options.cols}
      initialCommand={options.initialCommand}
      registerShutdown={registerShutdown}
      slots={
        options.slots ??
        (!interactive
          ? {
              status: (
                <FoundationNotice
                  initialCommand={options.initialCommand}
                  warning={options.client.sandboxMode() === 'danger-full-access' ? FULL_ACCESS_WARNING : undefined}
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
  const stop = () => {
    void shutdown().finally(() => instance.unmount());
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    await instance.waitUntilExit();
  } finally {
    await shutdown();
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
    instance.unmount();
    instance.cleanup();
    options.client.setToolsEnabled(false);
    options.client.setUserInputAvailable(false);
  }
}
