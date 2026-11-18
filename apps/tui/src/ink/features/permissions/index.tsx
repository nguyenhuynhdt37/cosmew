/** @jsxImportSource react */
import {useEffect, useState} from 'react';
import {
  FULL_ACCESS_WARNING,
  PERMISSION_PRESETS,
  PERMISSION_MODE_HINTS,
  type PermissionMode,
  type PermissionPromptRequest,
  type PermissionResolutionScope,
  type PermissionRuleEffect,
} from '@futryn/contracts';
import {useFutrynClient, useTextInput, useKeymap} from '../../hooks';
import {useOverlay} from '../../core';
import {Diff, CodeBlock, ListPicker, TextLine, KeyHint} from '../../ui';
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
import {permissionChoices, isEscalation} from './logic';
export {permissionChoices, isEscalation} from './logic';
export function usePermissions() {
  const client = useFutrynClient();
  useDialogRefresh();
  const router = usePicker();
  return {
    ...router,
    pending: client.listPendingPermissions(),
    rules: client.permissionRules(),
    preset: client.permissionPreset(),
    cyclePreset: () => {
      const at = PERMISSION_PRESETS.findIndex(p => p.id === client.permissionPreset());
      const next = PERMISSION_PRESETS[(at + 1) % PERMISSION_PRESETS.length]!;
      if (next.id === 'full-access') router.open('permissions', <PermissionRulesDialog confirmFullAccessOnOpen />);
      else client.setPermissionPreset(next.id);
    },
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
export function PermissionRequestDialog({
  request,
  toolName,
  onDenied,
  ...props
}: PermissionsDialogProps & {request: PermissionPromptRequest}) {
  const client = useFutrynClient();
  const router = useOverlay();
  const [denying, setDenying] = useState(false);
  const [selected, setSelected] = useState<PermissionResolutionScope>('deny');
  const task = useDialogTask();
  const size = useDialogSize(props);
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
  const choose = (decision: PermissionResolutionScope) => (decision === 'deny' ? setDenying(true) : resolve(decision));
  const items = permissionChoices(request);
  const move = (delta: number) =>
    setSelected(
      current =>
        items[
          (Math.max(
            0,
            items.findIndex(item => item.id === current),
          ) +
            delta +
            items.length) %
            items.length
        ]!.id,
    );
  useKeymap(
    {previous: () => move(-1), next: () => move(1), submit: () => choose(selected)},
    {isActive: !denying && !task.busy},
  );
  useTextInput((input, key) => {
    if (key.eventType === 'release') return;
    if (key.ctrl && input === 'x') {
      client.revokeToolGrants();
      return;
    }
    if (key.ctrl || key.meta || denying || task.busy) return;
    const item = items.find(item => item.key === input);
    if (item) choose(item.id);
  });
  return (
    <Dialog title={toolName ?? request.action} {...size} message={task.message}>
      {isEscalation(request) ? <TextLine bold>NO SANDBOX</TextLine> : null}
      {request.subagent ? (
        <TextLine>{`Subagent: ${request.subagent.agentType} · ${request.subagent.description}`}</TextLine>
      ) : null}
      <TextLine>{`${request.capability} · ${request.riskLevel} · ${request.reason}`}</TextLine>
      <CodeBlock
        code={request.target}
        language={request.capability === 'process.execute' ? 'bash' : undefined}
        width={Math.max(1, size.width - 6)}
      />
      {request.diffPreview ? (
        <>
          <TextLine>Proposed changes · not applied</TextLine>
          <Diff diff={request.diffPreview} maxLines={size.visibleRows} width={Math.max(1, size.width - 6)} isActive />
        </>
      ) : null}
      {denying ? (
        <TextEntry label="Lý do từ chối (có thể để trống)" allowEmpty onSubmit={reason => resolve('deny', reason)} />
      ) : (
        <>
          <ListPicker
            items={items.map(item => ({...item, label: `${item.id === selected ? '› ' : ''}${item.label}`}))}
            onSelect={item => choose(item.id)}
            isActive={false}
          />
          <KeyHint keys="1 2 3 4" label="chỉ các quyết định được cung cấp · Esc dismiss" />
        </>
      )}
    </Dialog>
  );
}
export interface PermissionRulesDialogProps extends DialogProps {
  confirmFullAccessOnOpen?: boolean;
}
export function PermissionRulesDialog({confirmFullAccessOnOpen = false, ...props}: PermissionRulesDialogProps) {
  const client = useFutrynClient();
  useDialogRefresh();
  const task = useDialogTask();
  const size = useDialogSize(props);
  const [tab, setTab] = useState<'mode' | PermissionRuleEffect>('mode');
  const [adding, setAdding] = useState(false);
  const [remove, setRemove] = useState<string | null>(null);
  const [confirmFull, setConfirmFull] = useState(confirmFullAccessOnOpen);
  const tabs = ['mode', 'allow', 'ask', 'deny'] as const;
  useTextInput((input, key) => {
    if (key.eventType === 'release') return;
    if (key.ctrl && input === 'x') {
      client.revokeToolGrants();
      return;
    }
    if (!adding && !remove && !confirmFull && (key.tab || key.leftArrow || key.rightArrow))
      setTab(t => tabs[(tabs.indexOf(t) + (key.shift || key.leftArrow ? 3 : 1)) % 4]!);
  });
  if (confirmFull)
    return (
      <PickerDialog
        title="Enable Full Access?"
        {...size}
        message={task.message}
        items={[
          {id: 'cancel', label: 'Cancel'},
          {id: 'confirm', label: 'Enable Full Access'},
        ]}
        onSelect={item => {
          if (item.id === 'confirm')
            void task.run(() => {
              client.setPermissionPreset('full-access');
              setConfirmFull(false);
            });
          else setConfirmFull(false);
        }}
      >
        <TextLine>{FULL_ACCESS_WARNING}</TextLine>
      </PickerDialog>
    );
  if (adding && tab !== 'mode')
    return (
      <Dialog title={`Add ${tab} rule`} {...size} message={task.message}>
        <TextEntry
          label="Bash(cmd:*) / Read(glob) / Edit(glob) / Network(cmd) / Unsandboxed(cmd) / WebFetch(domain:x) / Tool(name)"
          onSubmit={rule =>
            void task.run(() => {
              client.addPermissionRule(tab, rule);
              setAdding(false);
            })
          }
        />
      </Dialog>
    );
  if (remove && tab !== 'mode')
    return (
      <PickerDialog
        title={`Remove ${tab} rule`}
        {...size}
        items={[
          {id: 'cancel', label: 'Keep rule'},
          {id: 'remove', label: `Remove ${remove}`},
        ]}
        onSelect={item =>
          void task.run(() => {
            if (item.id === 'remove') client.removePermissionRule(tab, remove);
            setRemove(null);
          })
        }
        message={task.message}
      />
    );
  const modes: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];
  const items =
    tab === 'mode'
      ? [
          ...PERMISSION_PRESETS.map(p => ({
            id: p.id,
            label: `${client.permissionPreset() === p.id ? '● ' : ''}${p.label}`,
            description: p.description,
          })),
          ...modes.map(mode => ({id: `mode:${mode}`, label: mode, description: PERMISSION_MODE_HINTS[mode]})),
        ]
      : [
          {id: 'add', label: `+ Add ${tab} rule`},
          ...client.permissionRules()[tab].map(rule => ({id: rule, label: rule})),
        ];
  return (
    <PickerDialog
      key={tab}
      title="Permissions"
      {...size}
      message={task.message}
      items={items}
      onSelect={item =>
        void task.run(() => {
          if (tab !== 'mode') {
            if (item.id === 'add') setAdding(true);
            else setRemove(item.id);
          } else if (item.id === 'full-access') setConfirmFull(true);
          else if (item.id.startsWith('mode:')) client.setPermissionMode(item.id.slice(5) as PermissionMode);
          else client.setPermissionPreset(item.id as 'auto' | 'read-only');
        })
      }
    >
      <TextLine>{`[${tab}] · ${client.permissionPreset()} · ${client.sandboxMode()} · ${client.permissionMode()}`}</TextLine>
      <TextLine>{`Session grants: ${client.listToolGrants().length} · Ctrl+X revoke`}</TextLine>
      <KeyHint keys="Tab / ← →" label="Mode · Allow · Ask · Deny; select a rule to remove" />
    </PickerDialog>
  );
}
