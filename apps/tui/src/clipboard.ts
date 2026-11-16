/** Terminal-host clipboard bridge. Only rendered/redacted selections reach this module. */
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

/** Fixed native clipboard executable, never a shell or user-supplied command. */
export async function writeMacClipboard(text: string, launch = launchMacClipboard, timeoutMs = 1500): Promise<boolean> {
  if (!text || Buffer.byteLength(text) > 65536) return false;
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

/** Prefer a native host writer; OSC 52 remains the remote/unsupported-host fallback. */
export async function deliverClipboard(
  sequence: string,
  terminal: (sequence: string) => void,
  native?: (text: string) => Promise<boolean>,
): Promise<void> {
  const match = /^\x1b\]52;c;([A-Za-z0-9+/]*={0,2})\x07$/.exec(sequence);
  if (!match || sequence.length > 87400) return;
  const bytes = Buffer.from(match[1]!, 'base64');
  if (!bytes.length || bytes.length > 65536) return;
  try {
    if (native && (await native(bytes.toString('utf8')))) return;
  } catch {
    /* Fall back to the terminal. */
  }
  terminal(sequence);
}
