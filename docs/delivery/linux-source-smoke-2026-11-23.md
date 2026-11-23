# Isolated Linux source CLI smoke

Date: 2026-11-23. Host: macOS, using the already-running OrbStack Docker context and its Linux/arm64 engine. Image was already cached: `oven/bun:1.4.4`, image/repository digest `sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d`.

The container ran with `--rm --pull never --network none --read-only`, the repository bind-mounted read-only at `/workspace`, and a 256 MiB `/tmp` tmpfs. `COSMEW_HOME=/tmp/cosmew-linux-smoke`; Bun/XDG caches also pointed into `/tmp`. `COSMEW_COMMAND_BACKEND=none` and `NO_COLOR=1`. No user state, credential directory or user cache was mounted. No image pull, package installation, daemon start, privileged flag, global CLI link change, provider request or writable checkout was used.

## Results

| Check | Outcome |
| --- | --- |
| `bun --version` | Exit 0, `1.4.4` |
| `uname -sm` | Exit 0, `Linux aarch64` |
| Source CLI `--help` | Exit 0, Cosmew provider/authentication/TUI help |
| Source CLI `--version` | Exit 1, `INVALID_INPUT`; this CLI option is not currently supported |
| `bun test tests/contracts/cli-commands.test.ts` | Exit 0, **9 pass / 0 fail / 62 assertions**, 90 ms |
| `Bun.which('bwrap')` | `null`; bubblewrap is not installed in the cached image |

The probe driver collected each exit code independently and continued after the unsupported version command. Its own completion is not an assertion that every probe passed. Captured local evidence is `/tmp/cosmew-linux-source-smoke-results.log`; it contains one bounded JSON result per probe. A preceding raw help/version run is `/tmp/cosmew-linux-source-smoke.log`.

Equivalent source commands inside the constrained container:

```sh
bun --version
uname -sm
bun --config=/dev/null --no-env-file apps/cli/src/index.ts --help
bun --config=/dev/null --no-env-file apps/cli/src/index.ts --version
bun test tests/contracts/cli-commands.test.ts
```

The repository preload remained enabled for the contract tests; its temporary state lived in the container tmpfs, not the checkout or host user directory. The tested slash contracts include implemented MCP/rewind overlay metadata and aliases.

## Limits

This establishes that the current bind-mounted source and existing dependency tree can import the CLI, render help and run the selected pure command contracts on this isolated Linux runtime. It is **not** a clean dependency installation, installable release, compiled-artifact check, upgrade/resume acceptance, Linux bubblewrap containment test, sandbox proxy/network acceptance or full Linux test-suite result. Native macOS tests that skip on Linux provide none of that evidence.

No supported `--version` output exists yet for artifact identification. A future release smoke needs a dedicated artifact/source manifest and a clean install/upgrade path; the current README source instructions use global `bun link`, which this check deliberately did not execute. The existing `scripts/smoke-public-catalogs.ts` tests opt-in public HTTP catalogs from source and does not serve as an installation smoke.
