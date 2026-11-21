/** @jsxImportSource react */
import {useEffect, useState} from 'react';
import {useFutrynClient, useKeybindings} from '../../hooks';
import {useBindingLabel} from '../../hooks/keymap';
import {useTerminalSize} from '../../hooks/use-terminal-size';
import {TextLine} from '../../ui';
import {Dialog, PickerDialog, useDialogSize, useDialogRefresh, useDialogTask, type DialogProps} from '../picker';
import {TaskOutput} from './output';
import {sessionTasks} from './tasks';
import {AgentConversation} from './conversation';

const marks = {running: '●', done: '✔', failed: '✘', stopped: '■'} as const;
/** Snapshot/control only: the shell remains the sole owner of SDK turns and notifications. */
type TaskDialogProps = DialogProps & {initialTaskId?: string};
export function BackgroundTasksDialog(props: TaskDialogProps) {
  const client = useFutrynClient();
  useDialogRefresh();
  return <SessionTasks key={client.activeSession()?.id ?? 'no-session'} {...props} />;
}

function SessionTasks(props: TaskDialogProps) {
  const client = useFutrynClient();
  const size = useDialogSize(props);
  const {refresh} = useDialogRefresh();
  const task = useDialogTask();
  const {rows} = useTerminalSize();
  const stopKey = useBindingLabel('Footer', 'footer:close');
  const backKey = useBindingLabel('Select', 'select:cancel');
  const followKey = useBindingLabel('Select', 'select:last');
  const tasks = sessionTasks(client);
  const [selected, setSelected] = useState<string | null>(null);
  const [cursor, setCursor] = useState(() =>
    Math.max(
      0,
      tasks.findIndex(task => task.id === props.initialTaskId),
    ),
  );
  useEffect(() => client.onBackgroundTaskEvent(() => refresh()), [client, refresh]);
  const current = tasks.find(item => item.id === selected);
  const highlighted = tasks[Math.min(cursor, Math.max(0, tasks.length - 1))];
  const closeTask = () => {
    const target = current ?? highlighted;
    if (!target || target.status !== 'running') return;
    void task.run(async () => {
      const stopped = target.foreground ? client.stopSubagent(target.id) : await client.stopBackgroundTask(target.id);
      task.setMessage(stopped ? 'Stopping task…' : 'Task is no longer running.');
      refresh();
    });
  };
  useKeybindings({
    Select: {
      'select:cancel': () => {
        if (!selected) return false;
        setSelected(null);
      },
    },
    Footer: {
      'footer:close': closeTask,
      'footer:stop': closeTask,
    },
  });
  if (current?.kind === 'agent')
    return (
      <AgentConversation
        key={current.id}
        task={current}
        width={size.width}
        onBack={() => setSelected(null)}
        onStop={closeTask}
        message={task.message}
      />
    );
  if (current)
    return (
      <Dialog title={`${current.kind} output · ${current.status}`} {...size} message={task.message}>
        <TextLine width={size.width - 2} wrap="truncate-end">
          {current.description}
        </TextLine>
        <TextLine>{`${current.status}${current.exitCode == null ? '' : ` · exit ${current.exitCode}`}`}</TextLine>
        <TaskOutput
          key={current.id}
          text={current.outputTail}
          width={Math.max(1, size.width - 2)}
          visibleRows={Math.max(1, Math.min(size.visibleRows, (rows || 24) - 9))}
          onBack={() => setSelected(null)}
        />
        <TextLine>{`↑/↓ scroll · ${followKey} follow`}</TextLine>
        <TextLine>{`${backKey}/Enter back${current.status === 'running' ? ` · ${stopKey} stop` : ''}`}</TextLine>
      </Dialog>
    );
  return (
    <PickerDialog
      title="Background tasks & agents"
      {...size}
      message={task.message}
      filterable={false}
      cursor={cursor}
      onCursorChange={setCursor}
      hint={`↑/↓ navigate · Enter output · ${stopKey} stop · ${backKey} close`}
      items={
        tasks.length
          ? tasks.map(item => ({
              id: item.id,
              label: `${marks[item.status]} ${item.kind}${item.foreground ? ' · foreground' : ''} · ${item.status} · ${item.description}`,
            }))
          : [{id: '__refresh', label: 'No background tasks'}]
      }
      onSelect={item => {
        if (item.id === '__refresh') refresh();
        else setSelected(item.id);
      }}
    />
  );
}
