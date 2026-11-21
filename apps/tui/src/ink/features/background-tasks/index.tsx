/** @jsxImportSource react */
import {useEffect, useState} from 'react';
import {useFutrynClient, useKeybindings} from '../../hooks';
import {TextLine} from '../../ui';
import {
  Dialog,
  PickerDialog,
  Detail,
  useDialogSize,
  useDialogRefresh,
  useDialogTask,
  type DialogProps,
} from '../picker';

const marks = {running: '●', done: '✔', failed: '✘', stopped: '■'} as const;
/** Snapshot/control only: the shell remains the sole owner of SDK turns and notifications. */
export function BackgroundTasksDialog(props: DialogProps) {
  const client = useFutrynClient();
  const size = useDialogSize(props);
  const {refresh} = useDialogRefresh();
  const task = useDialogTask();
  const [selected, setSelected] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  useEffect(() => client.onBackgroundTaskEvent(() => refresh()), [client, refresh]);
  const tasks = client.backgroundTasks();
  const current = tasks.find(item => item.id === selected);
  const highlighted = tasks[Math.min(cursor, Math.max(0, tasks.length - 1))];
  const closeTask = () => {
    const target = current ?? highlighted;
    if (!target || target.status !== 'running') return;
    void task.run(async () => {
      const stopped = await client.stopBackgroundTask(target.id);
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
  if (current)
    return (
      <Dialog title={`${current.kind} output · ${current.status}`} {...size} message={task.message}>
        <TextLine>{current.description}</TextLine>
        <TextLine>{`${current.status}${current.exitCode == null ? '' : ` · exit ${current.exitCode}`}`}</TextLine>
        <Detail
          key={current.id}
          text={current.outputTail || '(No output yet)'}
          visibleRows={size.visibleRows}
          onBack={() => setSelected(null)}
        />
        <TextLine>Enter/Esc back · ↑↓ scroll · x stop task</TextLine>
      </Dialog>
    );
  return (
    <PickerDialog
      title="Background tasks"
      {...size}
      message={task.message}
      filterable={false}
      cursor={cursor}
      onCursorChange={setCursor}
      hint="↑/↓ navigate · Enter output · x stop · Esc close"
      items={
        tasks.length
          ? tasks.map(item => ({
              id: item.id,
              label: `${marks[item.status]} ${item.kind} · ${item.status} · ${item.description}`,
            }))
          : [{id: '__refresh', label: 'No background tasks · refresh'}]
      }
      onSelect={item => {
        if (item.id === '__refresh') refresh();
        else setSelected(item.id);
      }}
    />
  );
}
