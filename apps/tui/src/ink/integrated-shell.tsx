/** @jsxImportSource react */
import {useEffect, useRef, useState} from 'react';
import {Box, useApp, useWindowSize, useStdout} from 'ink';
import {FutrynError, type ToolCall, type ToolResult} from '@futryn/contracts';
import {commandForShortcut} from '@futryn/sdk';
import {useOverlay} from './core';
import {InputScope, useClientEvents, useFutrynClient, useKeymap, useTextInput} from './hooks';
import {useTheme} from './theme';
import {Panel, TextLine, safeText} from './ui';
import {deliverClipboard, writeMacClipboard} from '../clipboard';
import {Header, useHeader} from './features/header';
import {Welcome} from './features/welcome';
import {StartupGate, useStartupGate} from './features/startup-gate';
import {Transcript, useTranscript, type TranscriptItem} from './features/transcript';
import {ComposerView, useComposer} from './features/composer';
import {Plan, usePlan} from './features/plan';
import {Notices, useNotices} from './features/notices';
import {Subagents, useSubagents} from './features/subagents';
import {StatusLine, useStatusLine} from './features/status';
import {PermissionRequestDialog, PermissionRulesDialog, usePermissions} from './features/permissions';
import {QuestionRequestDialog} from './features/question';
import {ConnectDialog} from './features/connect';
import {ModelsDialog, EffortDialog} from './features/models';
import {SessionsDialog} from './features/sessions';
import {SettingsDialog} from './features/settings';
import type {SettingsSection} from './features/settings/logic';
import {ThemesDialog} from './features/themes';
import {HelpDialog} from './features/help';
import {MemoryDialog} from './features/memory';
import {AgentsDialog} from './features/agents';
import {SkillsDialog} from './features/skills';
import {Usage, useUsage, type ReportKind} from './features/usage';
import {Diff, useDiff} from './features/diff';
import {routeCommand, type CommandHost} from './features/commands';

export interface IntegratedShellProps {
  width?: number;
  initialCommand?: string;
  registerShutdown?: (shutdown: () => Promise<void>) => void;
}
function ReportDialog({kind}: {kind: ReportKind}) {
  const {close} = useOverlay();
  const state = useUsage({kind, onClose: close});
  return <Usage state={state} />;
}
function DiffDialog({notice}: {notice(text: string): void}) {
  const diff = useDiff();
  const {stdout} = useStdout();
  useEffect(() => {
    void diff.refresh();
  }, []);
  useEffect(() => {
    if (diff.error) notice(diff.error);
  }, [diff.error]);
  return (
    <Panel title="Workspace diff">
      <Diff
        report={diff.report}
        isActive
        onRefresh={() => void diff.refresh()}
        onCopy={text => {
          const clean = safeText(text).slice(0, 65536);
          if (Buffer.byteLength(clean) > 65536) {
            notice('Diff is too large to copy.');
            return;
          }
          void deliverClipboard(
            `\x1b]52;c;${Buffer.from(clean).toString('base64')}\x07`,
            sequence => {
              stdout.write(sequence);
            },
            process.platform === 'darwin' && !process.env.SSH_CONNECTION && !process.env.SSH_TTY
              ? writeMacClipboard
              : undefined,
          ).then(() => notice('Diff copied.'));
        }}
      />
    </Panel>
  );
}
function HistoryDialog({items, initialOffset = 0}: {items: readonly TranscriptItem[]; initialOffset?: number}) {
  const [offset, setOffset] = useState(initialOffset);
  useTextInput((_input, key) => {
    if (key.pageUp || key.home)
      setOffset(n => (key.home ? Math.max(0, items.length - 8) : Math.min(Math.max(0, items.length - 8), n + 8)));
    if (key.pageDown || key.end) setOffset(n => (key.end ? 0 : Math.max(0, n - 8)));
  });
  return (
    <Panel title="Transcript history">
      <Transcript items={items} historyOffset={offset} liveItems={8} isActive animate={false} />
      <TextLine>PgUp/PgDn Home/End · page · ↑↓ focus · Ctrl+O expand · Esc close</TextLine>
    </Panel>
  );
}
function requestFailure(error: unknown): string {
  if (!(error instanceof FutrynError)) return 'Request failed [ERROR]. Run /doctor for safe connection diagnostics.';
  const hint =
    error.code === 'AUTH'
      ? 'No active provider account or model selected. Run /login or /model.'
      : error.code === 'UNSUPPORTED'
        ? 'This model does not accept workspace tools. Tools are now off for it; send your message again.'
        : '';
  return `Request failed [${error.code}].${hint ? ' ' + hint : ''}`;
}
/** Owns SDK tasks; feature views never start a second agent loop or grant permissions. */
export function IntegratedShell({width: requestedWidth, initialCommand, registerShutdown}: IntegratedShellProps) {
  const client = useFutrynClient();
  const overlay = useOverlay();
  const {exit} = useApp();
  const {engine} = useTheme();
  const {columns} = useWindowSize();
  const width = Math.max(1, requestedWidth ?? columns);
  const transcript = useTranscript();
  const notices = useNotices();
  const plan = usePlan();
  const agents = useSubagents();
  const header = useHeader();
  const permissions = usePermissions();
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [historyKey, setHistoryKey] = useState(0);
  const [section, setSection] = useState<SettingsSection>('General');
  const turn = useRef<AbortController | null>(null);
  const pending = useRef<Promise<void>>(Promise.resolve());
  const closing = useRef(false);
  const commands = useRef(new Map<AbortController, Promise<void>>());
  const mounted = useRef(true);
  const started = useRef(false);
  const session = useRef(client.activeSession()?.id);
  const shellCall = useRef<ToolCall | null>(null);
  const controls = useRef<{interrupt(): boolean; shutdown(): Promise<void>} | null>(null);
  const current = useRef<{shutdown(): Promise<void>; command(raw: string): Promise<void>} | null>(null);
  const reset = () => {
    transcript.reset();
    session.current = client.activeSession()?.id;
    setHistoryKey(n => n + 1);
    notices.clearNotices();
  };
  const requestExit = () => {
    if (closing.current) return;
    closing.current = true;
    void current.current?.shutdown().finally(() => exit());
  };
  const open = (route: string, args?: string) => {
    if (closing.current) return;
    if (!ready && route !== 'connect' && route !== 'models') return;
    const changed = () => reset();
    const accountId = args
      ? (client
          .listAccounts()
          .find(account => account.id === args || account.alias.toLowerCase() === args.toLowerCase())?.id ?? args)
      : undefined;
    switch (route) {
      case 'connect':
      case 'accounts':
      case 'switch':
      case 'logout':
        overlay.open(
          'connect',
          <ConnectDialog
            initialStep={route === 'connect' ? 'provider' : 'accounts'}
            action={route === 'logout' ? 'logout' : route === 'switch' ? 'switch' : undefined}
            accountId={accountId}
            onChanged={changed}
            isStreaming={busy}
          />,
        );
        break;
      case 'models':
        overlay.open(route, <ModelsDialog onChanged={changed} isStreaming={busy} />);
        break;
      case 'effort':
        overlay.open(route, <EffortDialog />);
        break;
      case 'sessions':
        overlay.open(route, <SessionsDialog onChanged={changed} />);
        break;
      case 'themes':
        overlay.open(route, <ThemesDialog />);
        break;
      case 'settings':
        overlay.open(
          route,
          <SettingsDialog
            initialSection={section}
            onSectionChange={setSection}
            onNavigate={action => open(action)}
            isStreaming={busy}
          />,
        );
        break;
      case 'help':
        overlay.open(
          route,
          <HelpDialog
            onCommand={raw => {
              overlay.close();
              void current.current?.command(raw);
            }}
          />,
        );
        break;
      case 'permissions':
      case 'full-access':
        overlay.open('permissions', <PermissionRulesDialog confirmFullAccessOnOpen={route === 'full-access'} />);
        break;
      case 'agents':
        overlay.open(route, <AgentsDialog />);
        break;
      case 'memory':
        overlay.open(route, <MemoryDialog />);
        break;
      case 'skills':
        overlay.open(
          route,
          <SkillsDialog
            onInvoke={raw => {
              overlay.close();
              submit(raw);
            }}
          />,
        );
        break;
      case 'usage':
      case 'context':
      case 'status':
        overlay.open(route, <ReportDialog kind={route} />);
        break;
      case 'diff':
        overlay.open(route, <DiffDialog notice={notices.addNotice} />);
        break;
      default:
        notices.addNotice(`Not implemented: ${route}`);
    }
  };
  const gate = useStartupGate({
    overlayOpen: Boolean(overlay.active),
    openOverlay: open,
    onExit: requestExit,
    onReady: () => {
      setReady(true);
      client.setUserInputAvailable(true);
    },
  });
  const shutdown = async () => {
    turn.current?.abort();
    for (const abort of commands.current.keys()) abort.abort();
    for (const abort of overlay.tasks.keys()) abort.abort();
    controls.current?.interrupt();
    client.setUserInputAvailable(false);
    client.revokeToolGrants();
    for (const req of client.listPendingPermissions()) client.dismissPermissionDialog(req.approvalId);
    for (const req of client.listPendingQuestions()) client.dismissQuestion(req.questionId);
    await gate.shutdown();
    await pending.current;
    await controls.current?.shutdown();
    await Promise.allSettled(commands.current.values());
    await Promise.allSettled(overlay.tasks.values());
    client.setToolsEnabled(false);
    if (engine.isPreviewing()) engine.cancelPreview();
  };
  const submit = (text: string): boolean => {
    if (!ready || closing.current || turn.current || !client.toolsEnabled()) return false;
    const abort = new AbortController();
    turn.current = abort;
    setBusy(true);
    pending.current = (async () => {
      let prompt: string | undefined = text;
      while (prompt && !closing.current && !abort.signal.aborted) {
        transcript.begin(prompt);
        try {
          for await (const event of client.sendMessage(prompt, {signal: abort.signal})) {
            if (mounted.current) transcript.applyEvent(event);
          }
          transcript.finish({cancelled: abort.signal.aborted});
        } catch (error) {
          transcript.finish(abort.signal.aborted ? {cancelled: true} : {error: requestFailure(error)});
        }
        session.current = client.activeSession()?.id;
        prompt = abort.signal.aborted ? undefined : client.takeQueuedMessage();
      }
    })().finally(() => {
      turn.current = null;
      if (mounted.current) setBusy(false);
    });
    return true;
  };
  const host: CommandHost = {
    client,
    busy: () => !!turn.current || (!!controls.current && composer.busy),
    open,
    notice: notices.addNotice,
    reset,
    submit,
    exit: () => gate.exit(),
  };
  const command = async (raw: string) => {
    if (!ready || closing.current) return;
    const abort = new AbortController();
    const task = routeCommand({...host, signal: abort.signal}, raw);
    // /exit starts shutdown synchronously: do not make shutdown await itself.
    if (closing.current) return;
    commands.current.set(abort, task);
    try {
      await task;
    } finally {
      commands.current.delete(abort);
    }
  };
  current.current = {shutdown, command};
  const composer = useComposer({
    onSubmit: submit,
    onCommand: command,
    busy,
    workspaceAccess: ready,
    isActive: ready && !overlay.active,
    inputWidth: Math.max(1, width - 6),
    onNotice: notices.addNotice,
    onEmptyHomeEnd: edge =>
      overlay.open(
        'history',
        <HistoryDialog
          items={transcript.items}
          initialOffset={edge === 'start' ? Math.max(0, transcript.items.length - 8) : 0}
        />,
      ),
    onRemember: async content => {
      const result = await client.writeMemory({
        name: `note-${crypto.randomUUID().slice(0, 8)}`,
        description: content.replace(/\s+/g, ' ').slice(0, 300),
        type: 'feedback',
        content,
      });
      notices.addNotice(result.content);
      return result.status === 'ok';
    },
    onShellStart: command => {
      const call = {id: `shell-${crypto.randomUUID()}`, name: 'exec_command', input: {command}};
      shellCall.current = call;
      transcript.begin(`!${command}`);
      transcript.applyEvent({type: 'toolCallComplete', call});
      return call.id;
    },
    onShellError: code => {
      if (shellCall.current) transcript.finish({error: `Shell failed [${code}].`});
      shellCall.current = null;
    },
    onShellOutput: chunk => {
      if (!shellCall.current) {
        shellCall.current = {
          id: `shell-${crypto.randomUUID()}`,
          name: 'exec_command',
          input: {command: composer.content.slice(1).trim()},
        };
        transcript.begin(composer.content);
        transcript.applyEvent({type: 'toolCallComplete', call: shellCall.current});
      }
      transcript.applyEvent({
        type: 'toolOutputDelta',
        callId: shellCall.current.id,
        name: 'exec_command',
        stream: chunk.stream,
        text: chunk.text,
      });
    },
    onShellResult: (result: ToolResult) => {
      const call = shellCall.current ?? {
        id: result.callId,
        name: 'exec_command',
        input: {command: composer.content.slice(1).trim()},
      };
      if (!shellCall.current) {
        transcript.begin(composer.content);
        transcript.applyEvent({type: 'toolCallComplete', call});
      }
      transcript.applyEvent({type: 'toolResult', result: {...result, callId: call.id}});
      transcript.finish();
      if (result.sessionId)
        notices.addNotice(
          `Shell session ${result.sessionId} is still running. Ask the agent to collect its final result with write_stdin.`,
        );
      shellCall.current = null;
      session.current = client.activeSession()?.id;
    },
  });
  controls.current = composer;
  useEffect(() => {
    if (ready && !started.current) {
      started.current = true;
      if (initialCommand) void current.current?.command(initialCommand);
    }
  }, [ready, initialCommand]);
  const status = useStatusLine(composer.content, ready);
  useEffect(() => {
    mounted.current = true;
    registerShutdown?.(() => current.current!.shutdown());
    return () => {
      mounted.current = false;
      turn.current?.abort();
      client.setUserInputAvailable(false);
    };
  }, [client, registerShutdown]);
  // Reconcile pending requests after every interaction; replacing an overlay dismisses its old SDK request.
  const [interaction, setInteraction] = useState(0);
  useClientEvents({
    interaction: () => setInteraction(n => n + 1),
    // Idle parent: a queued <subagent> result becomes the next turn so the model can act on it (Codex wakes the parent).
    subagent: notice => {
      if (notice.delivery !== 'queued' || !ready || closing.current || turn.current || shellCall.current) return;
      if (client.activeSession()?.id !== notice.parentSessionId) return;
      const next = client.takeQueuedMessage();
      if (next !== undefined) submit(next);
    },
    reactive: event => {
      setInteraction(n => n + 1); // permissions resolved through the SDK elsewhere must close their dialog
      if (event.kind === 'idle' && !turn.current && !shellCall.current) {
        const id = client.activeSession()?.id;
        if (id !== session.current) reset();
      }
    },
  });
  useEffect(() => {
    if (!ready || closing.current) return;
    // Never replace a dialog whose request is still pending (replacement dismisses it = a silent deny); otherwise
    // ask oldest first (the SDK lists newest first).
    const waiting = client.listPendingPermissions();
    const permission = waiting.find(p => overlay.active?.id === `permission:${p.approvalId}`) ?? waiting.at(-1);
    const question = client.listPendingQuestions()[0];
    if (permission) {
      if (overlay.active?.id === `permission:${permission.approvalId}`) return;
      overlay.open(
        `permission:${permission.approvalId}`,
        <PermissionRequestDialog
          request={permission}
          onDenied={reason => {
            if (!reason.trim()) return;
            const feedback = `Permission denied. User feedback: ${reason}`;
            const result = client.submitWhileBusy(feedback);
            notices.addNotice(
              result.disposition === 'rejected'
                ? 'Denial feedback was not accepted; resend after the turn.'
                : 'Denial feedback accepted.',
            );
          }}
        />,
      );
    } else if (question) {
      if (overlay.active?.id !== `question:${question.questionId}`)
        overlay.open(`question:${question.questionId}`, <QuestionRequestDialog request={question} />);
    } else if (overlay.active?.id.startsWith('permission:') || overlay.active?.id.startsWith('question:'))
      overlay.close();
  }, [interaction, ready, overlay.active?.id]);
  useKeymap({
    close: () => {
      if (!ready) {
        if (overlay.active) overlay.close();
        else gate.exit();
      } else if (overlay.active) overlay.close();
      else if (!composer.interrupt()) {
        turn.current?.abort();
        for (const abort of commands.current.keys()) abort.abort();
      }
    },
    exit: () => gate.exit(),
    permissions: () => {
      if (ready && !overlay.active && !composer.busy) permissions.cyclePreset();
    },
    expand: () => {
      if (ready && !overlay.active) overlay.open('history', <HistoryDialog items={transcript.items} />);
    },
  });
  useTextInput((input, key) => {
    if (!ready || overlay.active || !key.ctrl) return;
    if (input === 'p') {
      open('help');
      return;
    }
    const label = ({l: 'Ctrl+L', s: 'Ctrl+S', d: 'Ctrl+D', n: 'Ctrl+N', t: 'Ctrl+T'} as Record<string, string>)[input];
    if (label) {
      const def = commandForShortcut(label);
      if (def) void command(def.command);
    }
  });
  return (
    <Box flexDirection="column" width={width} minWidth={0}>
      <InputScope active={!overlay.active}>
        {!ready ? (
          <StartupGate state={gate} width={width} />
        ) : (
          <>
            <Header status={header} version="Ink v3" width={width} />
            {!transcript.items.length && <Welcome status={status.status} width={width} />}
            <Transcript items={transcript.items} historyKey={String(historyKey)} width={width} />
            <Subagents agents={agents.agents} width={width} />
            <Notices notices={notices.notices} width={width} />
            <Plan plan={plan.plan} width={width} />
            <ComposerView controller={composer} width={width} />
            <StatusLine {...status} width={width} />
          </>
        )}
      </InputScope>
      {overlay.active?.content}
    </Box>
  );
}
