import {existsSync} from 'node:fs';

/** Terminal-host clipboard bridge. Only rendered/redacted selections reach this module. */
export const MAX_OSC52_CLIPBOARD_BYTES = 65536;
export const MAX_NATIVE_CLIPBOARD_BYTES = 4 * 1024 * 1024;

interface ClipboardProcess {
  stdin: {write(text: string): unknown; end(): unknown};
  exited: Promise<number>;
  kill(): void;
}
const launchMacClipboard = (): ClipboardProcess =>
  Bun.spawn({
    cmd: ['/usr/bin/pbcopy'],
    stdin: 'pipe',
    stdout: 'ignore',
    stderr: 'ignore',
    env: {LANG: 'en_US.UTF-8'},
  });

const LINUX_ENV_ALLOWLIST = [
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XDG_RUNTIME_DIR',
  'XAUTHORITY',
  'DBUS_SESSION_BUS_ADDRESS',
] as const;

function linuxClipboardEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {LANG: source.LANG || 'en_US.UTF-8'};
  for (const key of LINUX_ENV_ALLOWLIST) {
    const value = source[key];
    if (value) env[key] = value;
  }
  return env;
}

const launchLinuxClipboard = (cmd: readonly string[], env: NodeJS.ProcessEnv): ClipboardProcess =>
  Bun.spawn({
    cmd: [...cmd],
    stdin: 'pipe',
    stdout: 'ignore',
    stderr: 'ignore',
    env: linuxClipboardEnv(env),
  });

async function writeProcessClipboard(text: string, launch: () => ClipboardProcess, timeoutMs = 1500): Promise<boolean> {
  if (!text || Buffer.byteLength(text) > MAX_NATIVE_CLIPBOARD_BYTES) return false;
  let child: ClipboardProcess | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    child = launch();
    const process = child;
    const transfer = async () => {
      await process.stdin.write(text);
      await process.stdin.end();
      return (await process.exited) === 0;
    };
    return await Promise.race([
      transfer(),
      new Promise<boolean>(resolve => {
        timer = setTimeout(() => {
          try {
            child?.kill();
          } catch {
            /* Process may already have exited. */
          }
          resolve(false);
        }, timeoutMs);
      }),
    ]);
  } catch {
    try {
      child?.kill();
    } catch {
      /* Process may already have exited. */
    }
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Fixed native clipboard executable, never a shell or user-supplied command. */
export async function writeMacClipboard(text: string, launch = launchMacClipboard, timeoutMs = 1500): Promise<boolean> {
  return writeProcessClipboard(text, launch, timeoutMs);
}

export interface LinuxClipboardOptions {
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
  launch?: (cmd: readonly string[]) => ClipboardProcess;
}

const LINUX_WAYLAND_BINS = ['/usr/bin/wl-copy', '/bin/wl-copy'] as const;
const LINUX_X11_TOOLS = [
  {paths: ['/usr/bin/xclip', '/bin/xclip'] as const, args: ['-selection', 'clipboard'] as const},
  {paths: ['/usr/bin/xsel', '/bin/xsel'] as const, args: ['--clipboard', '--input'] as const},
] as const;

/** Fixed absolute Linux clipboard executables (`wl-copy`, `xclip`, `xsel`), never via a shell. */
export async function writeLinuxClipboard(
  text: string,
  timeoutMs = 1500,
  options?: LinuxClipboardOptions,
): Promise<boolean> {
  if (!text || Buffer.byteLength(text) > MAX_NATIVE_CLIPBOARD_BYTES) return false;
  const env = options?.env ?? process.env;
  const exists = options?.exists ?? existsSync;
  const launch = options?.launch ?? ((cmd: readonly string[]) => launchLinuxClipboard(cmd, env));
  const candidates: (readonly string[])[] = [];
  if (env.WAYLAND_DISPLAY) {
    for (const path of LINUX_WAYLAND_BINS) candidates.push([path]);
  }
  if (env.DISPLAY) {
    for (const tool of LINUX_X11_TOOLS) {
      for (const path of tool.paths) candidates.push([path, ...tool.args]);
    }
  }
  for (const cmd of candidates) {
    if (!exists(cmd[0]!)) continue;
    if (await writeProcessClipboard(text, () => launch(cmd), timeoutMs)) return true;
  }
  return false;
}

export interface CopyToClipboardOptions {
  terminal?: (sequence: string) => void;
  native?: (text: string) => Promise<boolean>;
  platform?: NodeJS.Platform;
}

/** Write up to 4 MiB via native clipboard, falling back (or mirroring over SSH) to OSC 52 within 64 KiB. */
export async function copyToClipboard(text: string, options?: CopyToClipboardOptions): Promise<boolean> {
  const bytes = Buffer.byteLength(text);
  if (!text || bytes > MAX_NATIVE_CLIPBOARD_BYTES) return false;
  const platform = options?.platform ?? process.platform;
  const native =
    options?.native ??
    (platform === 'darwin' ? writeMacClipboard : platform === 'linux' ? writeLinuxClipboard : undefined);
  let wroteNative = false;
  if (native) {
    try {
      wroteNative = await native(text);
    } catch {
      wroteNative = false;
    }
  }
  const osc52 =
    bytes <= MAX_OSC52_CLIPBOARD_BYTES ? `\x1b]52;c;${Buffer.from(text).toString('base64')}\x07` : undefined;
  if (wroteNative) {
    if (options?.terminal && osc52 && Boolean(process.env.SSH_CONNECTION || process.env.SSH_TTY)) {
      options.terminal(osc52);
    }
    return true;
  }
  if (options?.terminal && osc52) {
    options.terminal(osc52);
    return true;
  }
  return false;
}

/** Prefer a native host writer; OSC 52 remains the remote/unsupported-host fallback. */
export async function deliverClipboard(
  sequence: string,
  terminal: (sequence: string) => void,
  native?: (text: string) => Promise<boolean>,
): Promise<void> {
  const match = /^\x1b\]52;c;([A-Za-z0-9+/]*={0,2})\x07$/.exec(sequence);
  if (!match || sequence.length > 87400) return;
  const bytes = Buffer.from(match[1]!, 'base64');
  if (!bytes.length || bytes.length > MAX_OSC52_CLIPBOARD_BYTES) return;
  try {
    if (native && (await native(bytes.toString('utf8')))) return;
  } catch {
    /* Fall back to the terminal. */
  }
  terminal(sequence);
}

export interface ClipboardImage {
  mediaType: 'image/png';
  data: string;
}
interface ClipboardImageProcess {
  stdout: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(): void;
}
const launchMacClipboardImage = (): ClipboardImageProcess =>
  Bun.spawn({
    cmd: ['/usr/bin/osascript', '-e', 'get the clipboard as «class PNGf»'],
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'ignore',
    env: {LANG: 'en_US.UTF-8'},
  });
/** The user explicitly requested image paste. Fixed AppleScript reads PNG bytes without a shell or temporary file. */
export async function readMacClipboardImage(
  timeoutMs = 1500,
  launch = launchMacClipboardImage,
): Promise<ClipboardImage | undefined> {
  if (process.platform !== 'darwin' && launch === launchMacClipboardImage)
    throw new Error('Image clipboard is unsupported on this host');
  const child = launch();
  const stop = () => {
    try {
      child.kill();
    } catch {
      /* Already exited. */
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const read = async () => {
      const reader = child.stdout.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const {value, done} = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 40 * 1024 * 1024 + 256) throw new Error('Clipboard image exceeds 20 MiB');
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      if ((await child.exited) !== 0) throw new Error('Clipboard does not contain a PNG image');
      const result = Buffer.concat(chunks).toString('utf8').trim();
      const match = /^«data PNGf([0-9a-fA-F]+)»$/.exec(result);
      if (!match || match[1]!.length % 2) throw new Error('Clipboard does not contain a PNG image');
      return {mediaType: 'image/png' as const, data: Buffer.from(match[1]!, 'hex').toString('base64')};
    };
    return await Promise.race([
      read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          stop();
          reject(new Error('Image clipboard timed out'));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    stop();
  }
}
