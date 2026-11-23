# Background agents: real provider validation

Verified on 2026-11-22 in the working tree based on revision
`f5f88929008bd5394608d15e66d4f61b076b5ae5` (with the concurrent background-agent changes).
Harness: [`tests/end-to-end/subagent-live-provider.test.ts`](../../tests/end-to-end/subagent-live-provider.test.ts).
This is authenticated API evidence through Cosmew's own provider adapter, core loop,
ToolDispatcher and background-child runner. No external agent CLI, fake transport,
fixture model, memory vault or fake operating-system runtime was used.

## Actual result

The saved `chatgpt-api` account with session-selected model `gpt-6.2-sol` passed:
**1 test, 16 assertions, 22.62 seconds** (22.97 seconds including test startup).
The test observed:

- A real model invoked `agent` with `background: true`, creating an `explore` child.
- The parent streamed text while a child was still running, then finished its turn.
- The child read the synthetic `sample.txt`, completed, and exposed its expected
  result marker and file content in the background task output. A completion
  notice reached the parent observer.
- A second child produced text or tool output before the SDK stopped its exact
  task ID. The child became `cancelled`; its background projection became
  `stopped`; its cancellation notice arrived.
- The completed sibling stayed completed. Stopping that finished sibling and an
  unknown ID returned false.
- A subsequent real request on the same parent session returned the requested
  marker, proving that targeted child cancellation preserved the parent.

Bounded emitted evidence (no IDs, credentials or provider response bodies):

```json
{"realProvider":true,"syntheticWorkspace":true,"provider":"chatgpt-api","model":"gpt-6.2-sol","parentContinuedWhileChildRunning":true,"completedChild":{"status":"completed","outputObserved":true,"noticeObserved":true},"targetedStop":{"accepted":true,"childOutputBeforeStop":true,"status":"cancelled","siblingPreserved":true},"parentSurvived":true}
```

The first attempt used the already active `xai` / `grok-4.7` selection and failed
with sanitized code **`PROVIDER_BILLING`** in 953 ms. Historical account status
`valid` did not establish current billing availability. No background-child
success is claimed for xAI; it needs a usable billing state before revalidation.
An initial ChatGPT run reached completion and cancellation assertions but its
final assertion incorrectly searched for a whole marker inside one streaming
chunk. The harness now joins text deltas; the reported passing run used that fix.

## Reproduce explicitly

Root integration revalidated the production lifecycle observer wiring on the
same date with the same saved provider/model: **1 test, 17 assertions, 25.15
seconds** (25.34 seconds including startup). The added assertion observes a
running child `task.updated` with output after the parent's turn has finished;
it proves progress does not depend on parent-stream traffic. Bounded evidence
includes `outOfTurnProgressObserved: true`. The original lifecycle assertions
also passed again. No additional global settings/model selection changes.

The normal suite skips this test and makes no provider calls. For a live run,
create a private, disposable state directory under the OS temp directory with
`mktemp -d`. Use `COSMEW_HOME` when signing in and caching a supported model in
that fixture.
Pass the same directory to the test. Opting in may incur provider charges.

```sh
COSMEW_LIVE_SUBAGENTS=1 \
COSMEW_LIVE_SUBAGENTS_STATE="$fixture_state" \
COSMEW_LIVE_ACCOUNT=chatgpt-api \
COSMEW_LIVE_MODEL=gpt-6.2-sol \
bun --no-env-file test tests/end-to-end/subagent-live-provider.test.ts
```

Omit account/model overrides to use the fixture's active account and its default
model. The harness never creates a login, extracts a secret, approves repository
settings, connects MCP servers, changes global account/model selection, or
writes permission rules.
Normal application session/usage/journal persistence still occurs in the selected
Cosmew state directory. Model selection and work budgets are session-only.

The workspace is a temporary directory containing one synthetic text file. It is
removed after execution. Only agent spawn and workspace reads receive launch
allow rules; mutation, shell, web and memory tools are denied, and unresolved
permissions fail closed. User deny rules still take precedence. Skills and memory
lookup homes are isolated to the temporary directory. Work has a 180-second total
abort deadline, 120-second turn budget, 24 steps, 36 tool calls, 24,000 tokens and
$1 configured turn budget; these are runtime limits, not a guarantee of an exact
bill because provider metadata and final usage accounting may vary. Cleanup shuts
down background children even after a failed assertion.

## Limits

This establishes the API/SDK background-child lifecycle and out-of-turn progress for the stated provider
and model on this machine. It does not establish all providers, TUI visual or
keyboard acceptance, OS sandbox compatibility, simultaneous active sibling
isolation, persistence/recovery across restart, or general Product MVP completion.
The test intentionally relies on real model tool behavior: a refusal, incorrect
tool invocation, billing/auth failure, or provider timeout fails the opt-in test;
it is never replaced with fixture success. Other provider/model combinations and
these additional cases remain **Needs verification**.
