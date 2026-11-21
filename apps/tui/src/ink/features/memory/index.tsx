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
  type DialogProps,
} from '../picker';
export function MemoryDialog(props: DialogProps) {
  const client = useFutrynClient();
  const {refresh} = useDialogRefresh();
  const task = useDialogTask();
  const size = useDialogSize(props);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const entries = client.memories();
  const entry = entries.find(e => e.name === selected);
  if (detail !== null)
    return (
      <Dialog title={`Memory · ${selected}`} {...size} message={task.message}>
        <Detail text={detail} visibleRows={size.visibleRows} onBack={() => setDetail(null)} />
        <TextLine>Enter back · ↑↓ scroll · Esc close</TextLine>
      </Dialog>
    );
  if (entry && deleting)
    return (
      <PickerDialog
        title="Delete memory?"
        {...size}
        message={task.message}
        items={[
          {id: 'cancel', label: 'Keep memory'},
          {id: 'delete', label: `Delete ${entry.name}`},
        ]}
        onSelect={item =>
          void task.run(async signal => {
            if (item.id === 'delete') {
              const result = await client.deleteMemory(entry.name);
              if (signal.aborted) return;
              task.setMessage(result.content);
              if (result.status !== 'ok') return;
            }
            setSelected(null);
            setDeleting(false);
            refresh();
          })
        }
      />
    );
  if (entry)
    return (
      <PickerDialog
        title={entry.name}
        {...size}
        message={task.message}
        items={[
          {id: 'read', label: 'Read memory'},
          {id: 'delete', label: 'Delete memory'},
          {id: 'back', label: 'Back to memories'},
        ]}
        onSelect={item => {
          if (item.id === 'delete') setDeleting(true);
          else if (item.id === 'back') setSelected(null);
          else
            void task.run(async signal => {
              const result = await client.readMemory(entry.name);
              if (signal.aborted) return;
              if (result.status !== 'ok') {
                task.setMessage(result.content);
                return;
              }
              setDetail(result.content);
              refresh();
            });
        }}
      >
        <TextLine>{`${entry.type} · ${entry.description} · ${entry.usage_count} lần dùng${entry.last_usage ? ` · ${entry.last_usage}` : ''}${entry.unused ? ' · lâu không dùng — cân nhắc xoá' : ''}`}</TextLine>
      </PickerDialog>
    );
  return (
    <PickerDialog
      title="Memory"
      {...size}
      message={task.message || (!client.memoryDirectory() ? 'Memories disabled.' : '')}
      items={[
        {id: '__open', label: 'Open memory folder'},
        ...entries.map(e => ({
          id: e.name,
          label: `${e.name}${e.unused ? ' · lâu không dùng — cân nhắc xoá' : ''}`,
          description: `${e.type} · ${e.description} · ${e.usage_count} lần dùng${e.last_usage ? ` · ${e.last_usage}` : ''}`,
        })),
      ]}
      onSelect={item => {
        if (item.id === '__open') void task.run(() => client.openMemoryDirectory());
        else setSelected(item.id);
      }}
    />
  );
}
