# ADR 0123 — Cross-Platform Infrastructure: Linux Bubblewrap Proxy Bridge, Multi-OS Clipboard, Standalone Packaging & Windows Support

Date: 2026-11-27. Status: implemented (contract 1.68).

## Context

Cosmew already enforced macOS Seatbelt with loopback HTTP/CONNECT proxy filtering (ADR 0061), macOS text/image clipboard, and Linux text clipboard (`wl-copy`/`xclip`/`xsel`). Three cross-platform infrastructure gaps remained:
1. **Linux Bubblewrap (`--unshare-net`) network proxy bridge**: Sandboxed Linux commands could not reach the host loopback proxy (`127.0.0.1:<port>`), leaving all sandboxed Linux commands offline even when domains were explicitly allowed.
2. **Multi-OS image & Windows text clipboard**: Image paste only worked on macOS (`osascript`), and Windows had no native text or image clipboard bridge.
3. **Standalone binary packaging & Windows hardening**: There was no `bun build --compile` release pipeline, and Windows paths/shells/process termination/external editors had hardcoded POSIX assumptions (`:` PATH splits, `/bin/bash`, `process.kill(-pid)`, `lsof`).

## Decision

### 1. Linux Bubblewrap Network Proxy Bridge (Contract 1.68)
- Add optional `CommandSandbox.proxySocketPath?: string` in `packages/contracts/src/command-runtime.ts`.
- Extend `SandboxProxy` (`packages/tools/src/exec/proxy.ts`) with `startUnix(socketPath?)`, starting an HTTP/CONNECT listener on a private Unix domain socket (`0700` directory, `0600` socket, path bounded under 100 bytes for `UNIX_PATH_MAX`) that shares the exact same `decide`, DNS pinning, `isPrivateAddress` refusal, connection limit, and audit events as TCP `start()`. `stop()` closes both listeners and unlinks the socket/owned directory.
- Extend `BubblewrapSandbox` (`packages/tools/src/exec/bubblewrap.ts`): when both `socat` and `sandbox.proxySocketPath` are present, bind-mount the Unix socket to `/tmp/cosmew-proxy.sock` inside `--unshare-net` and run a fixed shell trampoline passing `socat`, socket path, port (`3128`), and target argv exclusively as positional parameters (never interpolated into shell syntax). The trampoline starts `socat TCP-LISTEN:3128,bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:...`, waits briefly for `/proc/net/tcp` to show `:0C38`, then `exec "$@"`. Because `bwrap` runs with `--unshare-pid --die-with-parent`, `socat` terminates cleanly with the sandboxed command.
- If `socat` is absent on Linux, `bwrap` stays **fail-closed** (`--unshare-net` offline, never dropping namespace isolation) and `sandboxDependencies` continues reporting `socat: false`.

### 2. Multi-OS Image & Text Clipboard (`apps/tui/src/clipboard.ts`)
- Extend `ClipboardImage['mediaType']` to `'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'`.
- Add `readLinuxClipboardImage` using fixed absolute binaries (`/usr/bin/wl-paste` on Wayland, `/usr/bin/xclip` on X11; filtered display env allowlist; 20 MiB cap; hard timeout; magic-byte verification).
- Add `readWindowsClipboardImage` and `writeWindowsClipboard` using the fixed `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` binary (`-NoProfile -NonInteractive -STA`, no shell, no temporary files, UTF-8 stdin for writes, in-memory PNG export + magic-byte check for reads).
- Add unified `readClipboardImage()` dispatcher and wire it in `apps/tui/src/ink/integrated-shell.tsx`.

### 3. Standalone Binary Packaging & Windows Hardening
- Add `scripts/build-binary.ts` (`bun run build:binary`, `bun run build:binary:all`) using `Bun.build(..., {compile})` for `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`, and `windows-x64`, stubbing Ink's optional dev-only `react-devtools-core`, emitting `SHA256SUMS.txt`, and supporting `--smoke` verification on host builds. Cross-compiles warn explicitly that native `@napi-rs/keyring` requires building on the target OS/arch for native keyring access.
- Harden Windows execution and UX without faking OS sandboxing:
  - `NativeCommandRuntime.availability()` remains **fail-closed** (`{ok: false}`) on `win32` because no native Windows sandbox exists yet.
  - Approved unsandboxed commands (`sandbox.unsandboxed === true`) on `win32` now use `;` PATH splitting, `.exe`/`.cmd`/`.bat` executable discovery, Windows shells (`bash.exe` when requested and present, else `pwsh.exe`/`powershell.exe`/`ComSpec`), `windowsHide: true`, and `taskkill /T /F /PID` process-tree cleanup instead of POSIX `process.kill(-pid)`.
  - `sandboxDependencies` checks `ripgrep` (`rg.exe`) on `win32`; `paths.ts` skips `lsof` on `win32`; external editor (`$VISUAL`/`$EDITOR`, default `notepad.exe`) is enabled on `win32` while POSIX `SIGTSTP` suspend remains disabled.

## Verification Status

- Verified on macOS arm64 (Bun 1.4.4): real Unix Domain Socket `SandboxProxy` HTTP/CONNECT + private-IP refusal + cleanup, `BubblewrapSandbox` bridge argv & injection safety, Linux/Windows clipboard unit suites, Windows PATH/executable/shell/fail-closed sandbox tests, and real compiled binary `--smoke` (`--version` & `--help`) with SHA-256 verification.
- Live Linux kernel `bwrap --unshare-net` + `socat` execution, live Wayland/X11 clipboard, and live Windows host execution (PowerShell clipboard, `taskkill`, WinCred keyring, Windows compiled binary) remain **Needs verification**.
