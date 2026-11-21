/** @jsxImportSource react */
import {useEffect, useRef, useState} from 'react';
import {useFutrynClient, useKeybindings} from '../../hooks';
import {useBindingLabel} from '../../hooks/keymap';
import {useTerminalSize} from '../../hooks/use-terminal-size';
import {TextLine} from '../../ui';
import {Dialog, PickerDialog, useDialogSize, useDialogRefresh, useDialogTask, type DialogProps} from '../picker';
import {TaskOutput} from './output';
import {sessionTasks, taskStatusLabel} from './tasks';
import {AgentConversation, type AgentPresentation} from './conversation';
import {useOverlay} from '../../core';

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
  const overlay = useOverlay();
  const presentations = useRef(new Map<string, AgentPresentation>());
  const size = useDialogSize(props);
  const {refresh} = useDialogRefresh();
  const task = useDialogTask();
  const {rows} = useTerminalSize();
  const stopKey = useBindingLabel('Footer', 'footer:close');
  const backKey = useBindingLabel('Select', 'select:cancel');
  const followKey = useBindingLabel('Select', 'select:last');
  const tasks = sessionTasks(client);
  const [selected, setSelected] = useState<string | null>(() => props.initialTaskId ?? null);
  const [cursor, setCursor] = useState(() =>
    Math.max(
      0,
      tasks.findIndex(task => task.id === props.initialTaskId),
    ),
  );
  useEffect(() => client.onBackgroundTaskEvent(() => refresh()), [client, refresh]);
  const current = tasks.find(item => item.id === selected);
  const highlighted = tasks[Math.min(cursor, Math.max(0, tasks.length - 1))];
  const back = () => {
    if (props.initialTaskId) overlay.close();
    else setSelected(null);
  };
  const agents = tasks.filter(item => item.kind === 'agent');
  const switchAgent = (delta: number) => {
    if (agents.length < 2) return;
    const index = agents.findIndex(item => item.id === selected);
    setSelected(agents[(index + delta + agents.length) % agents.length]!.id);
  };
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
        back();
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
        onBack={back}
        backLabel={props.initialTaskId ? 'Main chat' : 'Task list'}
        onSwitch={switchAgent}
        agentPosition={`${agents.findIndex(item => item.id === current.id) + 1}/${agents.length}`}
        presentation={presentations.current.get(current.id)}
        onPresentation={value => {
          const cache = presentations.current;
          cache.delete(current.id);
          cache.set(current.id, value);
          if (cache.size > 32) cache.delete(cache.keys().next().value!);
        }}
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
          onBack={back}
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
              label: `${item.waitingForPermission ? '◷' : marks[item.status]} ${item.kind}${item.foreground ? ' · foreground' : ''} · ${taskStatusLabel(item)} · ${item.description} [${item.id}]`,
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
