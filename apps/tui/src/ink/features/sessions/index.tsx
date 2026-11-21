/** @jsxImportSource react */
import {useState} from 'react';
import {useFutrynClient, useTextInput} from '../../hooks';
import {useOverlay} from '../../core';
import {Text} from 'ink';
import {useTheme} from '../../theme';
import {ListPicker, Panel, TextLine, useUiTheme} from '../../ui';
import {PickerDialog, useDialogRefresh, useDialogSize, useDialogTask, type DialogProps} from '../picker';
export interface SessionsDialogProps extends DialogProps {
  onChanged?: () => void;
}
export function SessionsDialog({onChanged, ...props}: SessionsDialogProps) {
  const client = useFutrynClient();
  const router = useOverlay();
  const {refresh} = useDialogRefresh();
  const task = useDialogTask();
  const size = useDialogSize(props);
  const {color} = useTheme();
  const ui = useUiTheme();
  const [selected, setSelected] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const done = () => {
    onChanged?.();
    router.close();
  };
  useTextInput((input, key) => {
    if (key.eventType === 'release') return;
    if (key.ctrl && input === 'n')
      void task.run(() => {
        client.createSession();
        done();
      });
  });
  const sessions = client.listSessions();
  const target = sessions.find(s => s.id === selected);
  if (target && deleting)
    return (
      <PickerDialog
        title="Delete session?"
        {...props}
        message={task.message}
        items={[
          {id: 'cancel', label: 'Keep session'},
          {id: 'delete', label: `Delete ${target.title || target.id}`},
        ]}
        onSelect={item =>
          void task.run(() => {
            if (item.id === 'delete') {
              if (!client.deleteSession(target.id)) {
                task.setMessage('Session was not deleted.');
                return;
              }
              onChanged?.();
            }
            setSelected(null);
            setDeleting(false);
            refresh();
          })
        }
      />
    );
  if (target)
    return (
      <PickerDialog
        title={target.title || target.id}
        {...props}
        message={task.message}
        items={[
          {id: 'resume', label: 'Resume session'},
          {id: 'delete', label: 'Delete session'},
          {id: 'back', label: 'Back to sessions'},
        ]}
        onSelect={item => {
          if (item.id === 'delete') setDeleting(true);
          else if (item.id === 'back') setSelected(null);
          else
            void task.run(() => {
              client.resumeSession(target.id);
              done();
            });
        }}
      >
        <TextLine>{target.preview}</TextLine>
      </PickerDialog>
    );
  const project = client.status().workspace.split('/').filter(Boolean).at(-1) ?? 'project';
  return (
    <Panel width={size.width}>
      <Text bold color={ui.color('rule')}>
        Resume session
      </Text>
      <ListPicker
        items={sessions.map(s => ({
          id: s.id,
          label: s.title || s.id,
          current: s.id === client.status().activeSessionId,
          description: `${s.selection.modelId} · ${s.preview}`,
          keywords: s.id,
        }))}
        heading={project}
        showSearch
        empty="No sessions in this project yet"
        visibleRows={size.visibleRows}
        hint="Ctrl+N to start a new session · ↑/↓ to navigate · Enter to resume · Esc to close"
        onSelect={item => setSelected(item.id)}
      />
      {task.message ? <TextLine color={color('warning')}>{task.message}</TextLine> : null}
    </Panel>
  );
}
