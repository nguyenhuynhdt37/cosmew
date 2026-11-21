# Ink test suite timing

Measured on 2026-11-22 on macOS arm64 with Bun 1.4.4. The baseline is a
temporary clone of `f5f8892`. The three sequential comparison runs used the
same clone with this patch applied. The shared worktree had concurrent edits,
so the clone kept the test population constant. The earlier reported times
were 127 s before adaptive waits and about 196 s after they were introduced.
The local comparison below uses `/usr/bin/time -p` for wall time and Bun's
JUnit report for per-file and per-test measurements.

```sh
bun --no-env-file test apps --reporter=junit --reporter-outfile /tmp/cosmew-apps.xml
```

| Run | Wall time (s) | Pass | Existing skips | Fail |
| --- | ---: | ---: | ---: | ---: |
| Baseline | 181.21 | 562 | 4 | 0 |
| After 1 | 93.58 | 562 | 4 | 0 |
| After 2 | 58.22 | 562 | 4 | 0 |
| After 3 | 59.06 | 562 | 4 | 0 |

The patched average was **70.29 s**, down **61.2%** from 181.21 s. All runs
discovered 566 cases across 64 files.

## Where the suite spent its time

- `settle` required at least 45 ms of quiet on every key or render, even
  when Ink's debug renderer had finished and only React effects and promise
  continuations needed to drain. The old `waitForFrame` already checked the
  first frame immediately, then paid up to another 15 ms to see each new
  paint. It now yields event-loop turns first.
- `submitPrompt` used the open-stream count to decide whether a turn had
  started. A fixture turn that finished during submission looked like a turn
  that had yet to start, so the helper could spend another 300 ms waiting.
  A start counter distinguishes those two cases.
- Several tests waited for a fixed number of `settle` calls. They now wait
  for the composer, scroll position, or output they assert. Transcript
  search waits for both the match counter and the visible result because
  they can arrive in different paints.
- Bare Esc still waits for Ink's input parser and the fullscreen stream's
  mouse filter. Timer-specific fixtures and native PTY writes without an
  acknowledgement retain a timed quiet window. The keymap watcher test
  retains its observation window for duplicate warnings. The dependency
  source checked on 2026-11-22 was Ink 8.0.0's `build/components/App.js`
  and ink-testing-library 4.0.0's `build/index.js`. The local mouse filter
  is in `apps/tui/src/input/mouse-input.ts`.

## Fifteen slowest baseline tests

Paths are relative to `apps/tui/src`. Both columns use JUnit test case times.
The last column names the wait and fixture paths exercised by each case.

| Rank | File | Test | Baseline (s) | Patched mean (s) | Helpers |
| ---: | --- | --- | ---: | ---: | --- |
| 1 | `ink/testing/fullscreen.test.tsx` | detailed transcript Ctrl+E reveals and collapses inline history, resets on entry and yields to the composer | 4.996 | 2.567 | `openReady`, then two `settle` calls per prompt across 17 turns, plus fullscreen frame waits. |
| 2 | `ink/testing/native-pty.test.ts` | synthetic native PTY: replay, consent, permission, tasks, resize and confirmed exit in the alternate screen | 2.318 | 2.117 | Native PTY `send` (timed `settle`) and `wait` (child output), plus real terminal startup. |
| 3 | `ink/features/picker/v4-dialogs.test.tsx` | every permission kind retains target, warning/diff and all numbered offered scopes | 2.297 | 0.963 | `renderInk`, `settle` and the `key` helper across nine permission fixtures. |
| 4 | `ink/testing/background-tasks.test.tsx` | Down discovers a foreground child while chatting, opens its output and stops through the agent port | 2.143 | 0.655 | `openInk`, `submit`, `handleKey` and `waitFor` around a gated foreground child. |
| 5 | `ink/testing/integration.test.tsx` | host orders one spinner then live todos, toggles without mutation, and guards global shortcuts | 2.142 | 0.349 | `render`, `untilReady` and `key` around a fixture stream with live todos. |
| 6 | `ink/testing/integration.test.tsx` | slash commands leave their result under ❯ /cmd; Esc on a panel prints a cancellation; Esc Esc and /rewind open Rewind | 1.718 | 0.451 | `untilReady` and `key` for command typing, submission and repeated bare Esc. |
| 7 | `ink/testing/keys.test.tsx` | Select keys: arrows, J/K and Ctrl+N/P, PageUp/PageDown, Home/End; J/K type when a text field is active | 1.555 | 0.282 | `key` and `settle` for each navigation step in the plain and filterable pickers. |
| 8 | `ink/testing/integration.test.tsx` | host gates initial command, streams tool and session approval, history focus, reset, and drains shutdown | 1.548 | 0.442 | `render`, `untilReady` and `key` for consent, permission, history and reset. |
| 9 | `ink/testing/transcript-performance.test.tsx` | long transcript paint timings with 3000 items | 1.485 | 0.673 | `openInk`, `pressToFrame` → `waitForFrame` and `settle`, plus construction/rendering of 3,000 history items. |
| 10 | `ink/testing/keys.test.tsx` | transcript viewer: footer lists its keys; q, Esc and Ctrl+C leave; ? lists them; [ reports the scrollback | 1.312 | 0.344 | `readyApp`, `untilReady` and `key` across the detailed transcript shortcuts. |
| 11 | `ink/testing/fullscreen.test.tsx` | detailed transcript search owns text, keeps on Enter, cycles and cancels before exit | 1.290 | 0.167 | `openReady`, `settle` and fullscreen frame waits while the search index and scroll position update. |
| 12 | `ink/testing/integration.test.tsx` | permission denial reason reaches SDK steering and permission cleanup does not grant | 1.277 | 0.297 | `render` and `key` for consent and the permission amendment dialog. |
| 13 | `ink/features/composer/keys.test.tsx` | Ctrl+U/K/W kill text and join lines; Ctrl+Y, Alt+Y and consecutive kills use one ring entry | 1.269 | 0.274 | `mount`, `key` and `line` each call `settle` while driving the composer kill ring. |
| 14 | `ink/testing/background-tasks.test.tsx` | /tasks can inspect an agent while the main response is still running | 1.251 | 0.342 | `openInk`, `submit`, `executeSlashCommand`, `handleKey` and `waitFor` with a paused parent stream. |
| 15 | `ink/testing/integration.test.tsx` | the signed-out composer can open Connect and choose a model | 1.239 | 0.292 | `render`, `untilReady` and `key` through Connect and the model picker. |

## Per-file timings

<details>
<summary>All app test files, in baseline order</summary>

| File | Baseline (s) | Patched mean (s) |
| --- | ---: | ---: |
| `apps/tui/src/ink/testing/fullscreen.test.tsx` | 30.306 | 7.925 |
| `apps/tui/src/ink/features/picker/dialogs.test.tsx` | 21.685 | 10.153 |
| `apps/tui/src/ink/features/composer/keys.test.tsx` | 15.021 | 4.087 |
| `apps/tui/src/ink/testing/integration.test.tsx` | 13.827 | 3.811 |
| `apps/tui/src/ink/features/composer/composer.test.tsx` | 11.956 | 3.527 |
| `apps/tui/src/ink/testing/keys.test.tsx` | 10.516 | 2.777 |
| `apps/tui/src/ink/testing/p2-integration.test.tsx` | 8.357 | 1.869 |
| `apps/tui/src/ink/testing/background-tasks.test.tsx` | 5.881 | 1.439 |
| `apps/tui/src/ink/features/picker/v4-dialogs.test.tsx` | 5.718 | 2.450 |
| `apps/tui/src/ink/testing/foundation.test.tsx` | 4.501 | 2.202 |
| `apps/tui/src/ink/features/diff/diff.test.tsx` | 3.889 | 1.428 |
| `apps/tui/src/ink/features/plan-approval/plan-approval.test.tsx` | 3.746 | 1.707 |
| `apps/tui/src/ink/features/composer/reference-frames.test.tsx` | 3.172 | 1.507 |
| `apps/tui/src/theme/terminal-background.test.ts` | 3.039 | 3.030 |
| `apps/tui/src/ink/features/diff/panel.test.tsx` | 2.822 | 1.185 |
| `apps/tui/src/ink/features/transcript/reference-frames.test.tsx` | 2.728 | 1.294 |
| `apps/tui/src/ink/features/transcript/transcript.test.tsx` | 2.513 | 1.200 |
| `apps/tui/src/ink/testing/agent-conversation.test.tsx` | 2.374 | 0.346 |
| `apps/tui/src/ink/testing/native-pty.test.ts` | 2.319 | 2.118 |
| `apps/tui/src/ink/features/diff/navigation.test.tsx` | 2.280 | 0.888 |
| `apps/tui/src/ink/ui/mouse-controls.test.tsx` | 1.935 | 0.584 |
| `apps/tui/src/ink/features/background-tasks/background-tasks.test.tsx` | 1.900 | 1.937 |
| `apps/tui/src/ink/features/panels/panels.test.tsx` | 1.816 | 0.746 |
| `apps/tui/src/ink/features/diff/colors.test.ts` | 1.710 | 1.548 |
| `apps/tui/src/ink/testing/transcript-performance.test.tsx` | 1.487 | 0.675 |
| `apps/tui/src/ink/features/diff/interaction.test.tsx` | 1.136 | 0.340 |
| `apps/tui/src/ink/features/startup-gate/gate.test.tsx` | 0.990 | 0.990 |
| `apps/tui/src/ink/testing/plan-editor.test.tsx` | 0.964 | 0.453 |
| `apps/tui/src/ink/features/startup-gate/startup-gate.test.tsx` | 0.951 | 0.819 |
| `apps/tui/src/ink/features/subagents/subagents.test.tsx` | 0.940 | 0.650 |
| `apps/tui/src/ink/features/sandbox/sandbox.test.tsx` | 0.874 | 0.353 |
| `apps/tui/src/ink/features/transcript/tool-display.test.tsx` | 0.850 | 0.422 |
| `apps/tui/src/ink/features/status/chrome.test.tsx` | 0.836 | 0.480 |
| `apps/tui/src/ink/features/settings/settings.test.tsx` | 0.814 | 0.186 |
| `apps/tui/src/ink/features/status/footer.test.tsx` | 0.808 | 0.360 |
| `apps/tui/src/ink/features/transcript/footer-logic.test.ts` | 0.688 | 0.255 |
| `apps/tui/src/ink/testing/settle.test.tsx` | 0.684 | 0.642 |
| `apps/tui/src/ink/features/composer/reference-colors.test.ts` | 0.620 | 0.611 |
| `apps/tui/src/ink/features/plan/plan.test.tsx` | 0.615 | 0.306 |
| `apps/tui/src/ink/features/background-tasks/output.test.tsx` | 0.522 | 0.290 |
| `apps/tui/src/ink/features/onboarding/onboarding.test.tsx` | 0.502 | 0.499 |
| `apps/tui/src/ink/features/picker/v4-colors.test.ts` | 0.471 | 0.361 |
| `apps/tui/src/ink/features/autocomplete/autocomplete.test.tsx` | 0.395 | 0.189 |
| `apps/tui/src/ink/testing/phase-f-colors.test.ts` | 0.384 | 0.365 |
| `apps/tui/src/ink/features/notices/notices.test.tsx` | 0.336 | 0.271 |
| `apps/tui/src/ink/features/sandbox/dependencies.test.tsx` | 0.312 | 0.262 |
| `apps/tui/src/ink/features/history/history.test.tsx` | 0.265 | 0.149 |
| `apps/tui/src/ink/features/transcript/p2-events.test.tsx` | 0.182 | 0.081 |
| `apps/tui/src/ink/hooks/keymap/keymap.test.ts` | 0.159 | 0.153 |
| `apps/tui/src/input/key-delivery.test.tsx` | 0.129 | 0.135 |
| `apps/tui/src/ink/features/paste/paste.test.tsx` | 0.093 | 0.044 |
| `apps/tui/src/theme/phase-f.test.ts` | 0.060 | 0.034 |
| `apps/tui/src/input/mouse-input.test.ts` | 0.038 | 0.038 |
| `apps/tui/src/ink/testing/composition-golden.test.tsx` | 0.015 | 0.023 |
| `apps/tui/src/ink/features/transcript/search.test.ts` | 0.015 | 0.014 |
| `apps/tui/src/clipboard.test.ts` | 0.008 | 0.009 |
| `apps/tui/src/ink/features/composer/logic.test.ts` | 0.005 | 0.004 |
| `apps/tui/src/ink/features/commands-theme.test.ts` | 0.004 | 0.004 |
| `apps/tui/src/ink/features/picker/logic.test.ts` | 0.002 | 0.002 |
| `apps/tui/src/ink/features/background-tasks/conversation.test.ts` | 0.002 | 0.001 |
| `apps/tui/src/ink/features/background-tasks/commands.test.ts` | 0.002 | 0.001 |
| `apps/tui/src/input/terminal-input.test.ts` | 0.001 | 0.001 |
| `apps/tui/src/theme/cosmew-mascot.test.ts` | 0.001 | 0.002 |
| `apps/tui/src/ink/features/transcript/show-all.test.ts` | 0.001 | 0.001 |

</details>

## Verification scope

All six tests in `tests/end-to-end/subagents-background.test.ts` passed with
injected providers. `bun run typecheck` and `bun run lint` passed in both the
isolation clone and the shared worktree.

The four existing skips require `FORCE_COLOR=3`. Running them explicitly gave
three passes and one failure on both the clean baseline and the patch.
`tool-display.test.tsx` could not find the expected truecolor outcome dot in
“colour terminal paints outcome dots and user background.”

The requested app and subagent tests needed no listener. The sandbox rejected
a local bind on `127.0.0.1:0`, so the broader loopback-server tests remain for
the coordinator. These include mock OAuth callbacks in
`tests/end-to-end/chatgpt-oauth.test.ts`, HTTP fixtures in
`tests/end-to-end/web-search.test.ts`, and local proxy cases in
`tests/security/sandbox-proxy.test.ts`. No live provider requests were made.

See [Ink test waits](ink-test-waits.md) for helper usage.
