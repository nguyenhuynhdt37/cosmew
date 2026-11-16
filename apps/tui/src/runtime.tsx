import {deliverClipboard, writeMacClipboard} from './clipboard';
import {FutrynError} from '@futryn/contracts';
import {FutrynTuiApp} from './app';
import {TerminalInputDecoder} from './input/terminal-keys';
import type {FutrynTuiOptions} from './types';

export async function runInteractiveTui(options: FutrynTuiOptions & {initialCommand?: string}): Promise<void> {
  const app = new FutrynTuiApp(options);
  await app.initialize();
  const stdout = process.stdout;
  const stdin = process.stdin;
  const isTty = Boolean(stdout.isTTY && stdin.isTTY);

  if (isTty) app.startStartupGate(options.initialCommand);
  else {
    // No terminal to ask on: never read the workspace without consent.
    app.denyWorkspaceAccess();
    if (options.initialCommand) await app.executeSlashCommand(options.initialCommand);
  }

  if (!isTty) {
    // Non-TTY deterministic single-frame output and clean exit
    const snap = app.computeFrameSnapshot();
    stdout.write(snap.plainText + '\n');
    return;
  }

  let cleanedUp = false;
  let clipboardTask = Promise.resolve();
  let timer: ReturnType<typeof setInterval> | null = null;
  let inputTimer: ReturnType<typeof setTimeout> | null = null;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let lastSystemCheck = Date.now();
  let stopUpdates: (() => void) | null = null;
  const inputDecoder = new TerminalInputDecoder();

  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    stopUpdates?.();
    stopUpdates = null;
    if (refreshTimer) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }
    if (inputTimer) {
      clearTimeout(inputTimer);
      inputTimer = null;
    }
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    try {
      if (stdin.isTTY && typeof stdin.setRawMode === 'function') {
        stdin.setRawMode(false);
      }
      stdin.pause();
    } catch {
      // Ignore cleanup error
    }
    stdout.write('\x1b[0m\x1b[?7h\x1b[?1006l\x1b[?1002l\x1b[?1000l\x1b[?1007l\x1b[?1004l\x1b[?25h\x1b[?1049l');
  };

  stdout.write(
    '\x1b[?1049h\x1b[?7l\x1b[?25l\x1b[?1004h\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?1007h\x1b[2J\x1b[3J\x1b[H',
  );
  if (typeof stdin.setRawMode === 'function') {
    stdin.setRawMode(true);
  }
  stdin.resume();

  app.resize(stdout.columns || 110, stdout.rows || 32);

  const renderNow = (force = false) => {
    if (cleanedUp) return;
    app.advanceStartupGate();
    const clipboard = app.takeClipboardSequence();
    if (clipboard)
      clipboardTask = clipboardTask.then(() =>
        deliverClipboard(
          clipboard,
          sequence => {
            if (!cleanedUp) stdout.write(sequence);
          },
          process.platform === 'darwin' && !process.env.SSH_CONNECTION && !process.env.SSH_TTY
            ? writeMacClipboard
            : undefined,
        ),
      );
    const ansi = app.renderAnsiFrame(force);
    if (ansi) stdout.write(ansi);
  };

  renderNow(true);

  try {
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: unknown) => {
        stdout.off('resize', onResize);
        stdin.off('data', onData);
        process.off('SIGINT', onSignal);
        process.off('SIGTERM', onSignal);
        cleanup();
        if (error) reject(error);
        else resolve();
      };
      stopUpdates = options.client.onReactiveEvent(() => {
        if (cleanedUp || refreshTimer) return;
        // Render after the TUI consumes the deltas, coalescing provider bursts.
        refreshTimer = setTimeout(() => {
          refreshTimer = null;
          try {
            renderNow(false);
          } catch {
            finish(new FutrynError('INVALID_INPUT'));
          }
        }, 16);
      });
      const onSignal = () => finish(new FutrynError('CANCELLED'));
      const onResize = () => {
        app.resize(stdout.columns || 110, stdout.rows || 32);
        renderNow(true);
      };
      const onData = async (chunk: Buffer) => {
        try {
          if (inputTimer) {
            clearTimeout(inputTimer);
            inputTimer = null;
          }
          const keys = inputDecoder.feed(chunk);
          if (inputDecoder.waiting)
            inputTimer = setTimeout(() => {
              inputTimer = null;
              void (async () => {
                for (const key of inputDecoder.flush()) await app.handleKey(key);
                if (app.isExitRequested()) finish();
                else renderNow(false);
              })().catch(error => finish(error instanceof FutrynError ? error : new FutrynError('INVALID_INPUT')));
            }, 30);
          for (const key of keys) {
            await app.handleKey(key);
            if (app.isExitRequested()) {
              finish();
              return;
            }
          }
          renderNow(false);
        } catch (error) {
          finish(error instanceof FutrynError ? error : new FutrynError('INVALID_INPUT'));
        }
      };
      stdout.on('resize', onResize);
      stdin.on('data', onData);
      process.on('SIGINT', onSignal);
      process.on('SIGTERM', onSignal);
      timer = setInterval(() => {
        try {
          if (app.themeEngine.getCommittedAppearance().mode === 'system' && Date.now() - lastSystemCheck >= 5000) {
            lastSystemCheck = Date.now();
            app.themeEngine.refreshSystemPreference();
          }
          app.stepAnimation(0.08);
          renderNow(false);
        } catch {
          finish(new FutrynError('INVALID_INPUT'));
        }
      }, 80);
    });
  } finally {
    cleanup();
    // Drain cancellation/credential rollback before composition closes the database.
    await app.shutdown();
    await clipboardTask;
  }
}
