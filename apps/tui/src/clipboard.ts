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

export interface WindowsClipboardOptions {
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
  launch?: (cmd: readonly string[]) => ClipboardProcess;
}

const WINDOWS_SET_CLIPBOARD_SCRIPT =
  '[Console]::InputEncoding = [System.Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())';

function windowsPowerShellPath(env: NodeJS.ProcessEnv): string {
  const root = (env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows').replace(/[\\/]+$/, '');
  return `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
}

const launchWindowsClipboardWrite = (cmd: readonly string[]): ClipboardProcess =>
  Bun.spawn({
    cmd: [...cmd],
    stdin: 'pipe',
    stdout: 'ignore',
    stderr: 'ignore',
  });

/** Fixed absolute Windows PowerShell writer reading UTF-8 text from stdin (no shell or argv injection). */
export async function writeWindowsClipboard(
  text: string,
  timeoutMs = 2000,
  options?: WindowsClipboardOptions,
): Promise<boolean> {
  if (!text || Buffer.byteLength(text) > MAX_NATIVE_CLIPBOARD_BYTES) return false;
  const env = options?.env ?? process.env;
  const exists = options?.exists ?? existsSync;
  const exe = windowsPowerShellPath(env);
  if (!exists(exe)) return false;
  const cmd = [exe, '-NoProfile', '-NonInteractive', '-STA', '-Command', WINDOWS_SET_CLIPBOARD_SCRIPT] as const;
  const launch = options?.launch ?? launchWindowsClipboardWrite;
  return writeProcessClipboard(text, () => launch(cmd), timeoutMs);
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
    (platform === 'darwin'
      ? writeMacClipboard
      : platform === 'linux'
        ? writeLinuxClipboard
        : platform === 'win32'
          ? writeWindowsClipboard
          : undefined);
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

export type ClipboardImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

export interface ClipboardImage {
  mediaType: ClipboardImageMediaType;
  data: string;
}
interface ClipboardImageProcess {
  stdout: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(): void;
}

const MAX_CLIPBOARD_IMAGE_BYTES = 20 * 1024 * 1024;
const SUPPORTED_IMAGE_MIMES: readonly ClipboardImageMediaType[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
];

function matchesImageMagic(bytes: Buffer, mime: ClipboardImageMediaType): boolean {
  if (mime === 'image/png') {
    return (
      bytes.length >= 8 &&
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47 &&
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a
    );
  }
  if (mime === 'image/jpeg') {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (mime === 'image/gif') {
    if (bytes.length < 6) return false;
    const header = bytes.subarray(0, 6).toString('ascii');
    return header === 'GIF87a' || header === 'GIF89a';
  }
  return (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  );
}

async function readBoundedStdout(
  launch: () => ClipboardImageProcess,
  timeoutMs: number,
  maxBytes: number,
  oversizeMessage: string,
): Promise<{exitCode: number; bytes: Buffer}> {
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
          if (size > maxBytes) throw new Error(oversizeMessage);
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      return {exitCode: await child.exited, bytes: Buffer.concat(chunks)};
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
  const {exitCode, bytes} = await readBoundedStdout(
    launch,
    timeoutMs,
    40 * 1024 * 1024 + 256,
    'Clipboard image exceeds 20 MiB',
  );
  if (exitCode !== 0) throw new Error('Clipboard does not contain a PNG image');
  const result = bytes.toString('utf8').trim();
  const match = /^«data PNGf([0-9a-fA-F]+)»$/.exec(result);
  if (!match || match[1]!.length % 2) throw new Error('Clipboard does not contain a PNG image');
  return {mediaType: 'image/png' as const, data: Buffer.from(match[1]!, 'hex').toString('base64')};
}

export interface LinuxImageClipboardOptions {
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
  launch?: (cmd: readonly string[]) => ClipboardImageProcess;
}

const LINUX_WAYLAND_PASTE_BINS = ['/usr/bin/wl-paste', '/bin/wl-paste'] as const;
const LINUX_XCLIP_BINS = ['/usr/bin/xclip', '/bin/xclip'] as const;

const launchLinuxImageClipboard = (cmd: readonly string[], env: NodeJS.ProcessEnv): ClipboardImageProcess =>
  Bun.spawn({
    cmd: [...cmd],
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'ignore',
    env: linuxClipboardEnv(env),
  });

function pickSupportedImageMime(typesOutput: string): ClipboardImageMediaType | undefined {
  const advertised = new Set(
    typesOutput
      .split(/\r?\n/)
      .map(line => line.trim().toLowerCase())
      .filter(Boolean),
  );
  return SUPPORTED_IMAGE_MIMES.find(mime => advertised.has(mime));
}

/** Fixed absolute Linux image clipboard readers (`wl-paste` on Wayland, `xclip` on X11), never via a shell. */
export async function readLinuxClipboardImage(
  timeoutMs = 1500,
  options?: LinuxImageClipboardOptions,
): Promise<ClipboardImage> {
  const env = options?.env ?? process.env;
  const exists = options?.exists ?? existsSync;
  const launch = options?.launch ?? ((cmd: readonly string[]) => launchLinuxImageClipboard(cmd, env));

  const tryReader = async (
    listCmd: readonly string[],
    readCmd: (mime: ClipboardImageMediaType) => readonly string[],
  ): Promise<ClipboardImage | undefined> => {
    const listed = await readBoundedStdout(
      () => launch(listCmd),
      timeoutMs,
      64 * 1024,
      'Clipboard target list exceeds limit',
    );
    if (listed.exitCode !== 0) return undefined;
    const mime = pickSupportedImageMime(listed.bytes.toString('utf8'));
    if (!mime) return undefined;
    const data = await readBoundedStdout(
      () => launch(readCmd(mime)),
      timeoutMs,
      MAX_CLIPBOARD_IMAGE_BYTES,
      'Clipboard image exceeds 20 MiB',
    );
    if (data.exitCode !== 0 || !data.bytes.length || !matchesImageMagic(data.bytes, mime)) {
      throw new Error('Clipboard does not contain a supported image');
    }
    return {mediaType: mime, data: data.bytes.toString('base64')};
  };

  let probedAny = false;
  if (env.WAYLAND_DISPLAY) {
    const bin = LINUX_WAYLAND_PASTE_BINS.find(path => exists(path));
    if (bin) {
      probedAny = true;
      const image = await tryReader([bin, '--list-types'], mime => [bin, '--no-newline', '--type', mime]);
      if (image) return image;
    }
  }
  if (env.DISPLAY) {
    const bin = LINUX_XCLIP_BINS.find(path => exists(path));
    if (bin) {
      probedAny = true;
      const image = await tryReader([bin, '-selection', 'clipboard', '-t', 'TARGETS', '-o'], mime => [
        bin,
        '-selection',
        'clipboard',
        '-t',
        mime,
        '-o',
      ]);
      if (image) return image;
    }
  }
  if (!probedAny) {
    throw new Error('Image clipboard requires wl-paste (Wayland) or xclip (X11) with an active display session');
  }
  throw new Error('Clipboard does not contain a supported image');
}

export interface WindowsImageClipboardOptions {
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
  launch?: (cmd: readonly string[]) => ClipboardImageProcess;
}

const WINDOWS_GET_IMAGE_SCRIPT =
  'Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $img = [System.Windows.Forms.Clipboard]::GetImage(); if ($null -eq $img) { exit 2 }; $ms = New-Object System.IO.MemoryStream; $img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); [Console]::Out.Write([Convert]::ToBase64String($ms.ToArray()))';

const launchWindowsImageClipboard = (cmd: readonly string[]): ClipboardImageProcess =>
  Bun.spawn({
    cmd: [...cmd],
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'ignore',
  });

/** Fixed absolute Windows PowerShell reader exporting clipboard images to PNG in memory (no temp files). */
export async function readWindowsClipboardImage(
  timeoutMs = 3000,
  options?: WindowsImageClipboardOptions,
): Promise<ClipboardImage> {
  const env = options?.env ?? process.env;
  const exists = options?.exists ?? existsSync;
  const exe = windowsPowerShellPath(env);
  if (!exists(exe)) throw new Error('Image clipboard is unavailable: Windows PowerShell was not found');
  const launch = options?.launch ?? launchWindowsImageClipboard;
  const cmd = [exe, '-NoProfile', '-NonInteractive', '-STA', '-Command', WINDOWS_GET_IMAGE_SCRIPT] as const;
  const maxBase64 = Math.ceil(MAX_CLIPBOARD_IMAGE_BYTES / 3) * 4 + 256;
  const {exitCode, bytes} = await readBoundedStdout(
    () => launch(cmd),
    timeoutMs,
    maxBase64,
    'Clipboard image exceeds 20 MiB',
  );
  if (exitCode !== 0) throw new Error('Clipboard does not contain a PNG image');
  const base64 = bytes.toString('utf8').replace(/\s+/g, '');
  if (!base64 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) {
    throw new Error('Clipboard does not contain a PNG image');
  }
  const raw = Buffer.from(base64, 'base64');
  if (raw.length > MAX_CLIPBOARD_IMAGE_BYTES) throw new Error('Clipboard image exceeds 20 MiB');
  if (!matchesImageMagic(raw, 'image/png')) throw new Error('Clipboard does not contain a PNG image');
  return {mediaType: 'image/png', data: base64};
}

export interface ReadClipboardImageOptions {
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  linux?: LinuxImageClipboardOptions;
  windows?: WindowsImageClipboardOptions;
}

/** Platform-dispatched clipboard image reader (macOS osascript, Linux wl-paste/xclip, Windows PowerShell). */
export async function readClipboardImage(options?: ReadClipboardImageOptions): Promise<ClipboardImage | undefined> {
  const platform = options?.platform ?? process.platform;
  if (platform === 'darwin') return readMacClipboardImage(options?.timeoutMs ?? 1500);
  if (platform === 'linux') return readLinuxClipboardImage(options?.timeoutMs ?? 1500, options?.linux);
  if (platform === 'win32') return readWindowsClipboardImage(options?.timeoutMs ?? 3000, options?.windows);
  throw new Error('Image clipboard is unsupported on this host');
}
