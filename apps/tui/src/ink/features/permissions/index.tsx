/** @jsxImportSource react */
import {useEffect, useState} from 'react';
import {Box, Text} from 'ink';
import {
  BYPASS_PERMISSIONS_WARNING,
  PERMISSION_MODE_HINTS,
  PERMISSION_MODE_LABELS,
  type PermissionMode,
  type PermissionSettingsScope,
  type PermissionPromptRequest,
  type PermissionResolutionScope,
  type PermissionRuleEffect,
} from '@cosmew/contracts';
import {useFutrynClient, useKeybindings, useTextInput} from '../../hooks';
import {useTheme} from '../../theme';
import {useOverlay} from '../../core';
import {
  ListPicker,
  OptionList,
  Panel,
  PanelTabs,
  Rule,
  TextLine,
  parseUnifiedDiff,
  safeText,
  useDialogRows,
  useUiTheme,
  type OptionItem,
} from '../../ui';
import {
  Dialog,
  PickerDialog,
  TextEntry,
  useDialogRefresh,
  useDialogSize,
  useDialogTask,
  usePicker,
  type DialogProps,
} from '../picker';
import {
  createsFile,
  permissionChoices,
  isEscalation,
  permissionQuestion,
  permissionTitle,
  type PermissionChoiceId,
} from './logic';
export {permissionChoices, isEscalation, permissionTitle} from './logic';
export function usePermissions() {
  const client = useFutrynClient();
  useDialogRefresh();
  const router = usePicker();
  return {
    ...router,
    pending: client.listPendingPermissions(),
    rules: client.permissionRules(),
    mode: client.permissionMode(),
    /** Shift+Tab: default -> acceptEdits -> plan (-> bypassPermissions when launched in it). */
    cycleMode: () => client.cyclePermissionMode(),
    openPermissions: (props: PermissionsDialogProps = {}) =>
      router.open('permissions', <PermissionsDialog {...props} />),
  };
}
export interface PermissionsDialogProps extends DialogProps {
  approvalId?: string;
  toolName?: string;
  /** SDK has no denial-reason field. Host may deliver this text as user feedback after denying. */
  onDenied?: (reason: string, request: PermissionPromptRequest) => void;
}
export function PermissionsDialog(props: PermissionsDialogProps) {
  const client = useFutrynClient();
  useDialogRefresh();
  const request = client.listPendingPermissions().find(r => !props.approvalId || r.approvalId === props.approvalId);
  return request ? (
    <PermissionRequestDialog key={request.approvalId} {...props} request={request} />
  ) : (
    <PermissionRulesDialog {...props} />
  );
}
/** Rows of the edit preview: `Edit file` shows `1 -old` / `1 +new`, `Create file` plain numbered lines. */
function EditPreview({request, width, maxLines}: {request: PermissionPromptRequest; width: number; maxLines: number}) {
  const {color} = useTheme();
  const ui = useUiTheme();
  const rows = parseUnifiedDiff(request.diffPreview ?? '').filter(row => row.kind !== 'meta' && row.kind !== 'hunk');
  const create = createsFile(request);
  const limit = Math.max(1, Math.floor(maxLines));
  const digits = rows.reduce((size, row) => Math.max(size, String(row.newLine ?? row.oldLine ?? 0).length), 1);
  return (
    <Box flexDirection="column" width={width} minWidth={0}>
      {rows.slice(0, limit).map((row, at) => {
        const number = String(row.kind === 'removed' ? row.oldLine : (row.newLine ?? row.oldLine)).padStart(digits);
        const sign = create ? ' ' : row.kind === 'added' ? '+' : row.kind === 'removed' ? '-' : ' ';
        const gutter = ` ${number} ${create ? '' : sign}`;
        const text = safeText(row.text.slice(1));
        const changed = !create && row.kind !== 'context';
        const bg = !changed ? undefined : ui.color(row.kind === 'added' ? 'diffAdded' : 'diffRemoved');
        const fill = Math.max(0, width - gutter.length - Array.from(text).length);
        return (
          <Box key={at} minWidth={0}>
            <Text backgroundColor={bg} color={changed ? color(row.kind === 'added' ? 'success' : 'error') : undefined}>
              {gutter}
            </Text>
            <Box flexShrink={1} minWidth={0}>
              <Text backgroundColor={bg} wrap="truncate-end">
                {text + ' '.repeat(bg ? fill : 0)}
              </Text>
            </Box>
          </Box>
        );
      })}
      {rows.length > limit ? (
        <Text color={color('foregroundMuted')}>{` ↓ ${rows.length - limit} more lines`}</Text>
      ) : null}
    </Box>
  );
}
function previewTarget(target: string, maxLines: number): string {
  const lines = target.split('\n');
  const room = Math.max(1, Math.floor(maxLines));
  if (lines.length <= room) return target;
  return `${lines.slice(0, room).join('\n')}\n… ${lines.length - room} more lines`;
}
/** One-line wording for short terminals: every offered choice keeps its scope and stays on screen. */
const COMPACT_LABELS: Partial<Record<PermissionChoiceId, string>> = {
  acceptEdits: 'Yes, accept edits (shift+tab)',
  session: 'Yes, for this session',
  always: 'Yes, always (save rule)',
};
export function PermissionRequestDialog({
  request,
  toolName,
  onDenied,
  ...props
}: PermissionsDialogProps & {request: PermissionPromptRequest}) {
  const client = useFutrynClient();
  const router = useOverlay();
  const task = useDialogTask();
  const size = useDialogSize(props);
  const {color} = useTheme();
  const ui = useUiTheme();
  const title = permissionTitle(request, toolName);
  const dialogRows = useDialogRows();
  const compact = dialogRows !== undefined && dialogRows <= 12;
  const mode = client.permissionMode();
  const items = permissionChoices(request, mode);
  // Short and narrow: wrapped labels would push choices off the screen.
  const terse = compact && size.width < 60;
  const safeFirst = isEscalation(request) || request.capability === 'settings.trust';
  const [cursor, setCursor] = useState(safeFirst ? items.length - 1 : 0);
  const [amending, setAmending] = useState(false);
  useEffect(
    () => () => {
      if (client.listPendingPermissions().some(r => r.approvalId === request.approvalId))
        client.dismissPermissionDialog(request.approvalId);
    },
    [client, request.approvalId],
  );
  const resolve = (decision: PermissionResolutionScope, reason = '') =>
    void task.run(() => {
      client.resolvePermission(request.approvalId, request.scopeHash, decision);
      if (decision === 'deny') onDenied?.(reason, request);
      if (!client.listPendingPermissions().length) router.close();
    });
  const choose = (id: PermissionChoiceId) => {
    if (id !== 'acceptEdits') return resolve(id);
    void task.run(() => {
      client.resolvePermission(request.approvalId, request.scopeHash, 'once');
      client.setPermissionMode('acceptEdits');
      if (!client.listPendingPermissions().length) router.close();
    });
  };
  const move = (delta: number) => setCursor(current => (current + delta + items.length) % items.length);
  // Confirmation keys: Enter yes, ↑/↓ choose, Tab opens/closes the comment field, Shift+Tab takes the
  // "accept edits for the session" choice (or closes the comment field). Esc is the shell's `confirm:no` (deny).
  useKeybindings(
    {
      Confirmation: {
        'confirm:previous': () => (amending ? false : move(-1)),
        'confirm:next': () => (amending ? false : move(1)),
        'confirm:yes': () => (amending ? false : choose(items[cursor]!.id)),
        'confirm:amend': () => setAmending(value => !value),
        'confirm:cycleMode': () => {
          if (amending) return setAmending(false);
          const accept = items.find(item => item.id === 'acceptEdits');
          if (accept) choose(accept.id);
        },
      },
    },
    {isActive: !task.busy},
  );
  useTextInput((input, key) => {
    if (key.eventType === 'release') return;
    if (key.ctrl && input === 'x') {
      client.revokeToolGrants();
      return;
    }
    if (amending || task.busy) return;
    if (key.ctrl || key.meta || key.tab) return;
    const at = items.findIndex(item => item.key === input);
    if (at >= 0) choose(items[at]!.id);
  });
  const muted = color('foregroundMuted');
  const kind = request.capability;
  const edit = kind === 'fs.write';
  const width = size.width;
  const optionItems: OptionItem[] = items.map(item => ({
    id: item.id,
    label: terse ? (COMPACT_LABELS[item.id] ?? item.label) : item.label,
    description: compact ? undefined : item.description,
    content:
      item.id === 'acceptEdits' && !terse ? (
        <>
          {'Yes, and switch to '}
          <Text bold>accept edits (auto-approve file edits and common file commands)</Text>
          {' for this session '}
          <Text bold>(shift+tab)</Text>
        </>
      ) : undefined,
  }));
  const footer = ['Esc to cancel', 'Tab to amend'];
  if (client.listToolGrants().length) footer.push('Ctrl+X revoke grants');
  return (
    <Panel width={width} ruleStyle="dialog" padding={0}>
      <Box paddingX={1} flexDirection="column" minWidth={0}>
        <Text bold color={ui.color('rule')}>
          {safeText(title)}
        </Text>
        {isEscalation(request) ? (
          <TextLine bold color={color('error')}>
            {compact ? 'NO SANDBOX' : 'NO SANDBOX · This command runs outside the sandbox.'}
          </TextLine>
        ) : null}
        {request.subagent && !compact ? (
          <TextLine
            color={muted}
          >{`Subagent: ${request.subagent.agentType} · ${request.subagent.description}`}</TextLine>
        ) : null}
        {edit || kind === 'fs.read' ? null : <Box height={compact ? 0 : 1} />}
        {edit || kind === 'fs.read' ? (
          <TextLine color={muted}>{request.target}</TextLine>
        ) : (
          <Box paddingLeft={2} flexDirection="column" minWidth={0}>
            <TextLine>
              {previewTarget(request.target, compact ? 1 : Math.max(1, Math.min(8, size.visibleRows)))}
            </TextLine>
            {!compact ? <TextLine color={muted}>{request.reason}</TextLine> : null}
          </Box>
        )}
        {(edit || kind === 'fs.read') && !compact && request.riskLevel === 'high' ? (
          <TextLine color={color('error')}>{`High risk · ${request.reason}`}</TextLine>
        ) : null}
      </Box>
      {edit && request.diffPreview && !compact ? (
        <>
          <Rule glyph="╌" color={muted} width={width} />
          <EditPreview request={request} width={width} maxLines={size.visibleRows} />
          <Rule glyph="╌" color={muted} width={width} />
        </>
      ) : null}
      <Box paddingX={1} flexDirection="column" minWidth={0}>
        {compact || edit || kind === 'fs.read' ? null : <Box height={1} />}
        {compact ? null : <TextLine bold>{permissionQuestion(request, title)}</TextLine>}
        {amending ? (
          <TextEntry
            label="Tell Cosmew what to do differently (optional)"
            allowEmpty
            onSubmit={reason => resolve('deny', reason)}
          />
        ) : (
          <>
            <OptionList items={optionItems} cursor={cursor} indent={0} width={width - 2} />
            {task.message ? <TextLine color={color('warning')}>{task.message}</TextLine> : null}
            {compact ? null : <Box height={1} />}
            <TextLine color={muted}>{footer.join(' · ')}</TextLine>
          </>
        )}
      </Box>
    </Panel>
  );
}
export type PermissionRulesDialogProps = DialogProps;
const RULE_TABS = ['Recently blocked', 'Allow', 'Ask', 'Deny', 'Mode', 'Workspace'] as const;
type RuleTab = (typeof RULE_TABS)[number];
const TAB_NOTE: Record<RuleTab, string> = {
  'Recently blocked': 'Requests that were denied, expired or dismissed in this session.',
  Allow: "Cosmew won't ask before using allowed tools.",
  Ask: 'Cosmew will always ask for confirmation before using these tools.',
  Deny: 'Cosmew will always reject requests to use denied tools.',
  Mode: 'Session permission mode. Shift+Tab cycles it.',
  Workspace: 'Directories Cosmew can read and write.',
};
export function PermissionRulesDialog(props: PermissionRulesDialogProps) {
  const client = useFutrynClient();
  useDialogRefresh();
  const task = useDialogTask();
  const size = useDialogSize(props);
  const {color} = useTheme();
  const [tab, setTab] = useState<RuleTab>('Allow');
  const [adding, setAdding] = useState<PermissionSettingsScope | 'scope' | false>(false);
  const [remove, setRemove] = useState<{scope: PermissionSettingsScope; rule: string} | null>(null);
  const effect = (
    tab === 'Allow' || tab === 'Ask' || tab === 'Deny' ? tab.toLowerCase() : null
  ) as PermissionRuleEffect | null;
  useTextInput((input, key) => {
    if (key.eventType === 'release') return;
    if (key.ctrl && input === 'x') {
      client.revokeToolGrants();
      return;
    }
  });
  const turnTab = (step: 1 | -1) =>
    setTab(t => RULE_TABS[(RULE_TABS.indexOf(t) + (step < 0 ? RULE_TABS.length - 1 : 1)) % RULE_TABS.length]!);
  useKeybindings(
    {Tabs: {'tabs:next': () => turnTab(1), 'tabs:previous': () => turnTab(-1)}},
    {isActive: !adding && !remove},
  );
  const snapshot = client.permissionSettings();
  if (adding === 'scope' && effect)
    return (
      <PickerDialog
        title={`Add ${effect} rule: which settings file?`}
        {...size}
        message={task.message}
        filterable={false}
        items={(['local', 'project', 'user'] as const).map(scope => ({
          id: scope,
          label: scope,
          description:
            scope === 'local'
              ? '.futryn/settings.local.json (this project, not shared)'
              : scope === 'project'
                ? '.futryn/settings.json (this project, shared with the repository)'
                : '~/.futryn/settings.json (all projects)',
        }))}
        onSelect={item => setAdding(item.id as PermissionSettingsScope)}
      />
    );
  if (adding && adding !== 'scope' && effect)
    return (
      <Dialog title={`Add ${effect} rule (${adding})`} {...size} message={task.message}>
        <TextEntry
          label="Bash(cmd:*) / Read(glob) / Edit(glob) / WebFetch(domain:x) / WebSearch / mcp__server__tool / Tool(name)"
          onSubmit={rule =>
            void task.run(() => {
              client.addPermissionRule(effect, rule, adding);
              setAdding(false);
            })
          }
        />
      </Dialog>
    );
  if (remove && effect)
    return (
      <PickerDialog
        title={`Remove ${effect} rule`}
        {...size}
        filterable={false}
        items={[
          {id: 'cancel', label: 'Keep rule'},
          {id: 'remove', label: `Remove ${remove.rule} (${remove.scope})`},
        ]}
        onSelect={item =>
          void task.run(() => {
            if (item.id === 'remove') client.removePermissionRule(effect, remove.rule, remove.scope);
            setRemove(null);
          })
        }
        message={task.message}
      />
    );
  const modes: PermissionMode[] = [
    'default',
    'acceptEdits',
    'plan',
    ...(client.status().bypassAvailable ? (['bypassPermissions'] as const) : []),
  ];
  const blocked = client
    .listPermissions()
    .filter(request => request.status !== 'pending' && !request.status.startsWith('approved'))
    .slice(0, 30);
  const items =
    tab === 'Mode'
      ? [
          ...modes.map(mode => ({
            id: `mode:${mode}`,
            label: PERMISSION_MODE_LABELS[mode],
            current: client.permissionMode() === mode,
            description: PERMISSION_MODE_HINTS[mode],
          })),
          ...snapshot.pendingTrust.flatMap(pending => [
            {
              id: `trust-session:${pending.path}`,
              label: `Trust ${pending.scope} settings for this session`,
              description: pending.grants.join('; ').slice(0, 200),
            },
            {
              id: `trust-always:${pending.path}`,
              label: `Always trust this content of ${pending.scope} settings`,
              description: pending.path,
            },
          ]),
        ]
      : tab === 'Recently blocked'
        ? blocked.map(request => ({
            id: request.approvalId,
            label: `${request.action} ${request.target}`.slice(0, 80),
            description: request.status,
          }))
        : tab === 'Workspace'
          ? [
              {id: 'ws:root', label: client.status().workspace, description: 'Working directory'},
              ...snapshot.additionalDirectories.map(dir => ({
                id: `ws:${dir}`,
                label: dir,
                description: 'Additional directory',
              })),
            ]
          : [
              {id: 'add', label: `Add a new rule…`},
              ...snapshot.files.flatMap(file =>
                file.rules[effect!].map(rule => ({
                  id: `${file.scope}\0${rule}`,
                  label: rule,
                  description: `${file.scope}${file.trusted ? '' : ', untrusted'}`,
                })),
              ),
            ];
  const muted = color('foregroundMuted');
  return (
    <Panel width={size.width}>
      <PanelTabs title="Permissions" tabs={RULE_TABS} selected={tab} />
      <Box height={1} />
      <TextLine>{TAB_NOTE[tab]}</TextLine>
      {client.permissionMode() === 'bypassPermissions' ? (
        <TextLine color={color('error')}>{BYPASS_PERMISSIONS_WARNING}</TextLine>
      ) : null}
      {tab === 'Mode' ? (
        <TextLine
          color={muted}
        >{`sandbox ${snapshot.sandbox.enabled ? 'on' : 'OFF'} · auto-allow sandboxed commands ${snapshot.sandbox.autoAllowBashIfSandboxed ? 'on' : 'off'} · allowed domains ${snapshot.sandbox.allowedDomains.length} · session grants ${client.listToolGrants().length} · Ctrl+X revoke`}</TextLine>
      ) : null}
      {snapshot.diagnostics.slice(0, 2).map(line => (
        <TextLine key={line} color={muted}>
          {line}
        </TextLine>
      ))}
      <Box height={1} />
      <ListPicker
        key={tab}
        items={items}
        visibleRows={size.visibleRows}
        placeholder="Search…"
        filterable={tab !== 'Workspace' && tab !== 'Mode'}
        hint={false}
        onSelect={item =>
          void task.run(() => {
            if (effect) {
              if (item.id === 'add') setAdding('scope');
              else {
                const [scope, rule] = item.id.split('\0') as [PermissionSettingsScope, string];
                setRemove({scope, rule});
              }
            } else if (item.id.startsWith('mode:')) {
              client.setPermissionMode(item.id.slice(5) as PermissionMode);
            } else if (item.id.startsWith('trust-')) {
              const persist = item.id.startsWith('trust-always:');
              client.approvePendingSettings(item.id.slice(item.id.indexOf(':') + 1), persist);
            }
          })
        }
      />
      {task.message ? <TextLine color={color('warning')}>{task.message}</TextLine> : null}
      <Box height={1} />
      <TextLine color={muted}>
        {tab === 'Allow' || tab === 'Ask' || tab === 'Deny'
          ? '↓ to navigate · ←/→ to switch · type to search · Enter to remove a rule · Esc to close'
          : '↓ to navigate · ←/→ to switch · Esc to close'}
      </TextLine>
    </Panel>
  );
}
