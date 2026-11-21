#!/usr/bin/env bun
/**
 * Headless UAT driver: runs the real Cosmew agent (same startup/client/tool path as the TUI)
 * Canonical state variable: COSMEW_HOME (legacy prefixes are read-only fallbacks).
 * over a list of prompts and writes a JSON report. See scripts/uat/README.md.
 *
 * `--approve all` auto-approves EVERY permission request. Use only against disposable projects.
 */
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {CONTRACT_VERSION, type PermissionPromptRequest, type PlanState, type UserAnswers} from '@cosmew/contracts';
import {defaultStateDirectory} from '../../apps/cli/src/bootstrap/paths';
import {startup, type Application} from '../../apps/cli/src/bootstrap/startup';
import {collectTurnEvidence, type TurnEvidence} from './evidence';

export interface AgentRunOptions {
  workspace: string;
  prompts: string[];
  approve?: 'all' | 'none';
  turnTimeoutMs?: number;
  /** Explicit state directory; defaults to the CLI's resolution (COSMEW_HOME first; legacy environment and state roots are read-only fallbacks). */
  stateDir?: string;
  /** Existing application (tests); the driver then does not open or close one. */
  app?: Application;
  log?: (line: string) => void;
  signal?: AbortSignal;
  /** Compatibility option; interactions are now event-driven and this value is ignored. */
  pollMs?: number;
}

interface ToolCallRecord {
  callId: string;
  name: string;
  target: string;
  status?: string;
  code?: string;
  /** Failed calls only: the redacted result text the model saw, one line, at most 300 chars. */
  error?: string;
  exitCode?: number | null;
  durationMs?: number;
}
interface PermissionRecord {
  capability: string;
  action: string;
  tool: string;
  target: string;
  reason: string;
  network: boolean;
  decision: 'approved_once' | 'denied';
}
interface QuestionRecord {
  question: string;
  answer: string;
}
interface TurnReport {
  prompt: string;
  finalText: string;
  toolCalls: ToolCallRecord[];
  permissions: PermissionRecord[];
  questions: QuestionRecord[];
  planFinal: PlanState | null;
  error: string | null;
  durationMs: number;
  evidence?: TurnEvidence;
}
export interface AgentRunReport {
  contractVersion: string;
  workspace: string;
  approve: 'all' | 'none';
  status: unknown;
  turns: TurnReport[];
  usage: unknown;
  ok: boolean;
}

export function splitPrompts(text: string): string[] {
  return text
    .split(/\r?\n---[ \t]*(?:\r?\n|$)/)
    .map(p => p.replace(/^---[ \t]*\r?\n/, '').trim())
    .filter(Boolean);
}

const clip = (value: string, max = 100) => {
  const one = value.replace(/\s+/g, ' ').trim();
  return one.length > max ? one.slice(0, max - 1) + '…' : one;
};

function shortTarget(input: unknown): string {
  if (input && typeof input === 'object') {
    const o = input as Record<string, unknown>;
    for (const key of ['cmd', 'command', 'path', 'file_path', 'pattern', 'query', 'url'])
      if (typeof o[key] === 'string') return clip(o[key] as string);
  }
  try {
    return clip(JSON.stringify(input) ?? '');
  } catch {
    return '';
  }
}

export async function runAgent(options: AgentRunOptions): Promise<{report: AgentRunReport; exitCode: number}> {
  const approve = options.approve ?? 'all';
  const timeoutMs = options.turnTimeoutMs ?? 20 * 60_000;
  const workspace = resolve(options.workspace);
  const app = options.app ?? startup(options.stateDir ?? defaultStateDirectory());
  const redact = (value: string) => app.redactor.text(value);
  const out = options.log ?? ((line: string) => process.stdout.write(line + '\n'));
  const log = (line: string) => out(redact(line));
  const abortAll = new AbortController();
  options.signal?.addEventListener('abort', () => abortAll.abort(), {once: true});
  if (options.signal?.aborted) abortAll.abort();

  const turns: TurnReport[] = [];
  let report: AgentRunReport = {
    contractVersion: CONTRACT_VERSION,
    workspace,
    approve,
    status: null,
    turns,
    usage: null,
    ok: false,
  };
  try {
    const client = app.createFutrynClient(workspace);
    const snapshot = () => {
      const s = client.status();
      return {
        account: s.activeAccount
          ? {id: s.activeAccount.id, alias: s.activeAccount.alias, provider: s.activeAccount.providerId}
          : null,
        model: s.selection?.modelId ?? null,
        executionBackend: s.executionBackend,
        permissionMode: s.permissionMode,
        sandbox: s.terminalRuntime,
        workspaceReadStatus: s.workspaceReadStatus,
        tools: client.availableTools(),
        toolsEnabled: s.toolsEnabled,
        sessionId: s.activeSessionId,
      };
    };
    const before = client.status();
    if (!before.activeAccount || !before.selection || !before.activeModel) {
      log('ERROR: no account/model selected. Run `cosmew auth` / `cosmew model use` first. Status:');
      log(JSON.stringify(snapshot(), null, 2));
      report = {...report, status: JSON.parse(redact(JSON.stringify(snapshot())))};
      return {report: JSON.parse(redact(JSON.stringify(report))), exitCode: 2};
    }
    client.setToolsEnabled(true);
    client.setUserInputAvailable(true);
    const status = JSON.parse(redact(JSON.stringify(snapshot())));
    report.status = status;
    log('status: ' + JSON.stringify(status));

    for (const [index, prompt] of options.prompts.entries()) {
      if (abortAll.signal.aborted) break;
      const turn: TurnReport = {
        prompt: redact(prompt),
        finalText: '',
        toolCalls: [],
        permissions: [],
        questions: [],
        planFinal: null,
        error: null,
        durationMs: 0,
      };
      turns.push(turn);
      const started = Date.now();
      const auditAfter = (
        app.db.query('SELECT COALESCE(MAX(rowid),0) AS position FROM tool_audit').get() as {position: number}
      ).position;
      let turnId = '';
      log(`--- turn ${index + 1}/${options.prompts.length}: ${clip(prompt, 120)}`);
      const controller = new AbortController();
      let timedOut = false;
      const onAbort = () => controller.abort();
      abortAll.signal.addEventListener('abort', onAbort, {once: true});
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);

      const handlePermission = (p: PermissionPromptRequest) => {
        const decision = approve === 'all' ? 'once' : 'deny';
        const network = p.capability.startsWith('network.');
        const record: PermissionRecord = {
          capability: p.capability,
          action: redact(p.action),
          tool: redact(p.action),
          target: redact(p.target),
          reason: redact(p.reason),
          network,
          decision: decision === 'once' ? 'approved_once' : 'denied',
        };
        try {
          client.resolvePermission(p.approvalId, p.scopeHash, decision);
          turn.permissions.push(record);
          log(
            `permission ${record.decision}: ${p.capability} ${record.action} -> ${clip(record.target)} network=${network} (${clip(record.reason)})`,
          );
        } catch (e) {
          log(`permission resolve failed (${p.approvalId}): ${(e as Error).message}`);
        }
      };
      const seenQuestions = new Set<string>();
      const handleQuestion = (
        questionId: string,
        questions: {id: string; question: string; options: {label: string}[]}[],
      ) => {
        const answers: UserAnswers = {};
        for (const q of questions) {
          const answer = q.options[0]!.label;
          answers[q.id] = {answers: [answer]};
          turn.questions.push({question: redact(q.question), answer: redact(answer)});
          log(`question: ${clip(q.question)} -> ${clip(answer)}`);
        }
        try {
          client.answerQuestion(questionId, answers);
        } catch (e) {
          log(`answerQuestion failed: ${(e as Error).message}`);
        }
      };
      const unsubscribe = client.onInteractionEvent(event => {
        if (event.type === 'permission.requested') handlePermission(event.request);
        else if (!seenQuestions.has(event.request.questionId)) {
          seenQuestions.add(event.request.questionId);
          handleQuestion(event.request.questionId, event.request.questions);
        }
      });

      const calls = new Map<string, ToolCallRecord>();
      let lastPlan = '';
      let text = '';
      let responseStart = 0;
      try {
        for await (const event of client.sendMessage(prompt, {signal: controller.signal})) {
          switch (event.type) {
            case 'started':
              turnId ||= event.requestId;
              responseStart = text.length;
              break;
            case 'textDelta':
              text += event.text;
              break;
            case 'responseDiscarded':
              text = text.slice(0, responseStart);
              log(
                `response discarded (${event.reason}${event.attempt ? ` attempt ${event.attempt}/${event.maxRetries ?? '?'}` : ''})`,
              );
              break;
            case 'toolCallComplete': {
              const record: ToolCallRecord = {
                callId: event.call.id,
                name: event.call.name,
                target: redact(shortTarget(event.call.input)),
              };
              calls.set(event.call.id, record);
              turn.toolCalls.push(record);
              log(`tool call: ${record.name} ${record.target}`);
              break;
            }
            case 'toolResult': {
              const r = event.result;
              const record = calls.get(r.callId) ?? {callId: r.callId, name: r.name, target: ''};
              if (!calls.has(r.callId)) turn.toolCalls.push(record);
              record.status = r.status;
              if (r.target) record.target = redact(r.target);
              if (r.code !== undefined) record.code = r.code;
              if (r.status !== 'ok') record.error = clip(redact(r.content), 300);
              if (r.exitCode !== undefined) record.exitCode = r.exitCode;
              if (r.durationMs !== undefined) record.durationMs = r.durationMs;
              log(
                `tool result: ${r.name} status=${r.status} code=${r.code ?? '-'} exit=${r.exitCode ?? '-'} ${r.durationMs ?? '-'}ms`,
              );
              const plan = client.plan();
              const serialized = plan ? JSON.stringify(plan.items) : '';
              if (plan && serialized !== lastPlan) {
                lastPlan = serialized;
                log('plan: ' + plan.items.map(i => `[${i.status}] ${clip(i.step, 60)}`).join(' | '));
              }
              break;
            }
            case 'completed':
              log(`completed: ${event.finishReason}`);
              break;
          }
        }
        turn.finalText = redact(text);
        if (controller.signal.aborted) turn.error = timedOut ? `turn timed out after ${timeoutMs}ms` : 'aborted';
      } catch (e) {
        turn.finalText = redact(text);
        turn.error = timedOut
          ? `turn timed out after ${timeoutMs}ms`
          : redact(`${(e as {code?: string}).code ?? 'ERROR'}: ${(e as Error).message ?? ''}`.trim());
      } finally {
        clearTimeout(timer);
        abortAll.signal.removeEventListener('abort', onAbort);
        unsubscribe();
      }
      turn.planFinal = client.plan();
      const sessionId = client.activeSession()?.id;
      if (sessionId && turnId)
        turn.evidence = JSON.parse(
          redact(JSON.stringify(collectTurnEvidence(app, sessionId, turnId, turn.toolCalls, auditAfter))),
        );
      turn.durationMs = Date.now() - started;
      log(`final text:\n${turn.finalText}`);
      if (turn.error) log(`ERROR: ${turn.error}`);
      if (turn.error) break;
    }
    report.usage = JSON.parse(redact(JSON.stringify(client.usage())));
    report.ok = turns.length === options.prompts.length && turns.every(t => !t.error);
    return {report: JSON.parse(redact(JSON.stringify(report))), exitCode: report.ok ? 0 : 1};
  } finally {
    if (!options.app) {
      await app.shutdownCommands();
      app.db.close();
    }
  }
}

async function main() {
  const {values} = parseArgs({
    options: {
      workspace: {type: 'string'},
      prompts: {type: 'string'},
      report: {type: 'string'},
      approve: {type: 'string', default: 'all'},
      'turn-timeout-ms': {type: 'string'},
      'state-dir': {type: 'string'},
    },
  });
  const usage =
    'usage: bun scripts/uat/agent-run.ts --workspace <dir> --prompts <file> --report <file.json> [--approve all|none] [--turn-timeout-ms <n>] [--state-dir <dir>]';
  if (!values.workspace || !values.prompts || !values.report || !['all', 'none'].includes(values.approve!)) {
    process.stderr.write(usage + '\n');
    process.exit(64);
  }
  const timeout = values['turn-timeout-ms'] === undefined ? undefined : Number(values['turn-timeout-ms']);
  if (timeout !== undefined && (!Number.isSafeInteger(timeout) || timeout <= 0)) {
    process.stderr.write('invalid --turn-timeout-ms\n' + usage + '\n');
    process.exit(64);
  }
  const approve = values.approve as 'all' | 'none';
  if (approve === 'all')
    process.stdout.write(
      '================================================================\n' +
        ' UAT ONLY: --approve all AUTO-APPROVES EVERY permission request\n' +
        ' (file writes, shell commands, network). Use a disposable project.\n' +
        '================================================================\n',
    );
  const prompts = splitPrompts(readFileSync(values.prompts, 'utf8'));
  if (!prompts.length) {
    process.stderr.write('no prompts found\n');
    process.exit(64);
  }
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  process.once('SIGTERM', () => controller.abort());
  const {report, exitCode} = await runAgent({
    workspace: values.workspace,
    prompts,
    approve,
    turnTimeoutMs: timeout,
    stateDir: values['state-dir'],
    signal: controller.signal,
  });
  mkdirSync(dirname(resolve(values.report)), {recursive: true});
  writeFileSync(values.report, JSON.stringify(report, null, 2) + '\n', {mode: 0o600});
  process.stdout.write(`report: ${values.report} (exit ${exitCode})\n`);
  process.exit(exitCode);
}

if (import.meta.main) await main();
