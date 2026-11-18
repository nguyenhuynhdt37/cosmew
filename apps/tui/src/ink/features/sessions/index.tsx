/** @jsxImportSource react */
import {useState} from 'react';
import {useFutrynClient, useTextInput} from '../../hooks';
import {useOverlay} from '../../core';
import {TextLine} from '../../ui';
import {PickerDialog, useDialogRefresh, useDialogTask, usePicker, type DialogProps} from '../picker';
export interface SessionsDialogProps extends DialogProps {
  onChanged?: () => void;
}
export function useSessions() {
  const client = useFutrynClient();
  useDialogRefresh();
  const router = usePicker();
  return {
    ...router,
    sessions: client.listSessions(),
    openSessions: (props: SessionsDialogProps = {}) => router.open('sessions', <SessionsDialog {...props} />),
  };
}
export function SessionsDialog({onChanged, ...props}: SessionsDialogProps) {
  const client = useFutrynClient();
  const router = useOverlay();
  const {refresh} = useDialogRefresh();
  const task = useDialogTask();
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
  return (
    <PickerDialog
      title="Sessions / Resume"
      {...props}
      message={task.message}
      items={sessions.map(s => ({
        id: s.id,
        label: `${s.id === client.status().activeSessionId ? '● ' : ''}${s.title || s.id}`,
        description: `${s.selection.modelId} · ${s.preview}`,
        keywords: s.id,
      }))}
      onSelect={item => setSelected(item.id)}
    >
      <TextLine>Ctrl+N new session · select to resume or delete</TextLine>
    </PickerDialog>
  );
}
