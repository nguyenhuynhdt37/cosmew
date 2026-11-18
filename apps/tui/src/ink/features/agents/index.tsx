/** @jsxImportSource react */
import {useState} from 'react';
import {useFutrynClient} from '../../hooks';
import {TextLine} from '../../ui';
import {
  Dialog,
  PickerDialog,
  Detail,
  useDialogSize,
  useDialogRefresh,
  useDialogTask,
  usePicker,
  type DialogProps,
} from '../picker';
import {transcriptLines, typeRow, childRow} from './logic';
export {transcriptLines, typeRow, childRow, formatDuration, tokenTotal} from './logic';
export function useAgents() {
  const client = useFutrynClient();
  useDialogRefresh();
  const router = usePicker();
  return {
    ...router,
    types: client.agentTypes(),
    children: client.subagents(),
    openAgents: (props: DialogProps = {}) => router.open('agents', <AgentsDialog {...props} />),
  };
}
export function AgentsDialog(props: DialogProps) {
  const client = useFutrynClient();
  const {refresh} = useDialogRefresh();
  const task = useDialogTask();
  const size = useDialogSize(props);
  const [selected, setSelected] = useState<string | null>(null);
  const [transcript, setTranscript] = useState(false);
  const report = client.agentTypes();
  const children = client.subagents();
  const child = selected ? (client.inspectSubagent(selected) ?? children.find(c => c.id === selected)) : undefined;
  if (child && transcript)
    return (
      <Dialog title={`Agent transcript · ${child.id}`} {...size}>
        <Detail
          text={transcriptLines(child).join('\n')}
          visibleRows={size.visibleRows}
          onBack={() => setTranscript(false)}
        />
        <TextLine>Enter back · ↑↓ scroll · Esc close</TextLine>
      </Dialog>
    );
  if (child)
    return (
      <PickerDialog
        title={`Agent · ${child.id}`}
        {...size}
        message={task.message}
        items={[
          {id: 'transcript', label: 'View transcript'},
          {id: 'stop', label: 'Stop agent', disabled: child.status !== 'running'},
          {id: 'back', label: 'Back to agents'},
        ]}
        onSelect={item => {
          if (item.id === 'back') setSelected(null);
          else if (item.id === 'transcript') setTranscript(true);
          else
            void task.run(() => {
              task.setMessage(client.stopSubagent(child.id) ? 'Stopping agent…' : 'Agent is not running.');
              refresh();
            });
        }}
      >
        <TextLine>{childRow(child, false)}</TextLine>
      </PickerDialog>
    );
  return (
    <PickerDialog
      title="Agents · types & children"
      {...size}
      message={task.message}
      items={[
        {id: '__refresh', label: 'Refresh'},
        ...report.types.map(t => ({id: `type:${t.name}`, label: typeRow(t)})),
        ...children.map(c => ({id: c.id, label: childRow(c, false)})),
      ]}
      onSelect={item => {
        if (item.id === '__refresh') refresh();
        else if (item.id.startsWith('type:')) {
          const type = report.types.find(t => `type:${t.name}` === item.id);
          task.setMessage(type ? typeRow(type) : 'Agent type no longer available.');
        } else setSelected(item.id);
      }}
    >
      {[...report.errors, ...report.warnings].map((d, i) => (
        <TextLine key={i}>{d.code}</TextLine>
      ))}
    </PickerDialog>
  );
}
