/** @jsxImportSource react */
import {useState} from 'react';
import {useMouseTarget} from '../../hooks/use-terminal-wheel';
import {Box, Text} from 'ink';
import {useFutrynClient, useKeybindings, useTextInput} from '../../hooks';
import {useOverlay} from '../../core';
import {useTheme} from '../../theme';
import {Markdown, OptionList, Panel, Rule, TextLine, safeText, useUiTheme} from '../../ui';
import {useDialogRefresh, useDialogSize, useDialogTask, type DialogProps} from '../picker';

/** The host cancels the active turn on Escape; closing a view never grants permission. */
export function PlanApprovalDialog({
  onCancel,
  onEdit,
  editorLabel = '$EDITOR',
  ...props
}: DialogProps & {onCancel: () => void; onEdit?: (text: string) => Promise<string | undefined>; editorLabel?: string}) {
  const client = useFutrynClient();
  const router = useOverlay();
  const task = useDialogTask();
  const size = useDialogSize(props);
  const {color} = useTheme();
  const ui = useUiTheme();
  useDialogRefresh();
  const proposal = client.pendingPlanApproval();
  const [cursor, setCursor] = useState(0);
  const [feedback, setFeedback] = useState('');
  const [offset, setOffset] = useState(0);
  const planMouseRef = useMouseTarget(event => {
    if ('direction' in event)
      setOffset(n =>
        Math.max(0, Math.min(Math.max(0, (proposal?.plan.split('\n').length ?? 1) - 1), n + event.direction)),
      );
  }, !task.busy);
  const submit = (choice = cursor, approveWithFeedback = false) => {
    if (!proposal || task.busy) return;
    if (choice === 2 && !feedback.trim()) {
      setCursor(2);
      task.setMessage('Tell Cosmew what to change.');
      return;
    }
    void task.run(() => {
      // Resolve only the live proposal rendered here; a replacement cannot inherit a stale click.
      if (client.pendingPlanApproval()?.id !== proposal.id) return;
      client.resolvePlanApproval(
        choice === 0
          ? 'acceptEdits'
          : choice === 1
            ? 'manual'
            : approveWithFeedback
              ? {mode: 'acceptEdits', feedback}
              : {feedback},
      );
      router.close();
    });
  };
  const cancel = () => {
    onCancel();
    router.close();
  };
  useKeybindings({
    Chat: {
      'chat:externalEditor': () => {
        if (!proposal || task.busy) return;
        if (!onEdit) {
          task.setMessage('External editor is unavailable in this host.');
          return;
        }
        void task.run(async () => {
          const text = await onEdit(proposal.plan);
          if (text === undefined || text === proposal.plan) return;
          client.editPlanProposal(text, {id: proposal.id, expectedRevision: proposal.revision ?? 1});
          task.setMessage('Plan updated. Review before approving.');
        });
      },
    },
    Confirmation: {
      'confirm:previous': () => setCursor(c => Math.max(0, c - 1)),
      'confirm:next': () => setCursor(c => Math.min(2, c + 1)),
      'confirm:yes': () => submit(),
      'confirm:no': cancel,
      'confirm:amend': () => setCursor(c => (c === 2 ? 1 : 2)),
      'confirm:cycleMode': () => {
        if (cursor === 2) submit(2, true);
        else submit(0);
      },
    },
    Select: {
      'select:pageDown': () =>
        setOffset(n => Math.min(Math.max(0, (proposal?.plan.split('\n').length ?? 1) - 1), n + size.visibleRows)),
      'select:pageUp': () => setOffset(n => Math.max(0, n - size.visibleRows)),
    },
  });
  useTextInput((input, key) => {
    if (
      key.eventType === 'release' ||
      key.ctrl ||
      key.meta ||
      key.escape ||
      key.return ||
      key.tab ||
      key.upArrow ||
      key.downArrow ||
      key.leftArrow ||
      key.rightArrow
    )
      return;
    if (cursor !== 2) {
      if (/^[123]$/.test(input)) submit(Number(input) - 1);
      return;
    }
    if (key.backspace || key.delete) setFeedback(s => Array.from(s).slice(0, -1).join(''));
    else if (input) setFeedback(s => (s + safeText(input).replace(/\n/g, ' ')).slice(0, 4000));
  });
  const muted = color('foregroundMuted');
  return (
    <Panel width={size.width} padding={1}>
      <Rule width={size.width - 2} glyph="─" color={ui.color('selected')} />
      <Text bold color={ui.color('rule')}>
        Ready to code?
      </Text>
      <TextLine>Here is Cosmew's plan:</TextLine>
      <Rule width={size.width - 2} glyph="╌" color={ui.color('planDivider')} />
      <Box ref={planMouseRef} flexDirection="column" maxHeight={size.visibleRows} overflow="hidden">
        <Markdown
          text={proposal?.plan.split('\n').slice(offset).join('\n') ?? 'No plan waiting.'}
          width={size.width - 2}
        />
      </Box>
      <Rule width={size.width - 2} glyph="─" color={ui.color('selected')} />
      <TextLine>Would you like to proceed?</TextLine>
      <OptionList
        width={size.width - 2}
        cursor={cursor}
        onCursorChange={setCursor}
        isActive={!task.busy}
        items={[
          {id: 'acceptEdits', label: 'Yes, and accept edits automatically'},
          {id: 'manual', label: 'Yes, manually approve edits'},
          {id: 'feedback', label: 'Tell Cosmew what to change'},
        ]}
      />
      {cursor === 2 ? <TextLine>{`Feedback: ${feedback}▏`}</TextLine> : null}
      {cursor === 2 ? (
        <TextLine color={muted}>Enter to request changes · Shift+Tab to approve with feedback</TextLine>
      ) : null}
      {task.message ? <TextLine color={color('warning')}>{task.message}</TextLine> : null}
      <TextLine color={muted}>
        {`ctrl+g to edit in ${editorLabel} · ${proposal?.path ?? 'Plan artifact unavailable in this host'}`}
      </TextLine>
      <TextLine color={muted}>Enter to select · PgUp/PgDn plan · Esc to cancel</TextLine>
    </Panel>
  );
}
