/** @jsxImportSource react */
import {useState} from 'react';
import {useFutrynClient, useTextInput, useKeymap} from '../../hooks';
import {useOverlay} from '../../core';
import {TextLine} from '../../ui';
import {Dialog, PickerDialog, TextEntry, useDialogRefresh, useDialogTask, usePicker, type DialogProps} from '../picker';
export interface ModelsDialogProps extends DialogProps {
  accountId?: string;
  onChanged?: () => void;
  isStreaming?: boolean;
}
export function useModels() {
  const client = useFutrynClient();
  useDialogRefresh();
  const router = usePicker();
  return {
    ...router,
    models: client.cachedModels(),
    openModels: (props: ModelsDialogProps = {}) => router.open('models', <ModelsDialog {...props} />),
    openEffort: (props: ModelsDialogProps = {}) => router.open('effort', <EffortDialog {...props} />),
  };
}
export function ModelsDialog({accountId, onChanged, isStreaming = false, ...props}: ModelsDialogProps) {
  const client = useFutrynClient();
  const router = useOverlay();
  useDialogRefresh();
  const task = useDialogTask();
  const [account, setAccount] = useState(accountId);
  const [manual, setManual] = useState(false);
  const [model, setModel] = useState<string | null>(null);
  const models = client.cachedModels(account);
  const chosen = models.find(m => m.id === model);
  const select = (id: string, effort?: string) =>
    void task.run(async signal => {
      if (isStreaming) {
        task.setMessage('Cancel the active response before changing model.');
        return;
      }
      if (account && account !== client.status().activeAccount?.id)
        await client.switchAccount(account, true, id, signal);
      else client.selectModel(id);
      if (signal.aborted) return;
      if (effort) client.setReasoningEffort(effort);
      onChanged?.();
      router.close();
    });
  useKeymap(
    {
      history: () =>
        void task.run(async signal => {
          await client.discoverModels({accountId: account, signal});
        }),
    },
    {isActive: !manual && !model},
  );
  useTextInput((input, key) => {
    if (key.eventType === 'release') return;
    if (manual || model || task.busy) return;
    if (key.ctrl && input === 'a') setManual(true);
    if (key.tab && !accountId) {
      const accounts = client.listAccounts().filter(a => a.status !== 'logged-out');
      const index = accounts.findIndex(a => a.id === (account ?? client.status().activeAccount?.id));
      setAccount(accounts[(index + (key.shift ? accounts.length - 1 : 1)) % accounts.length]?.id);
    }
  });
  if (manual)
    return (
      <Dialog title="Manual model ID" {...props} message={task.message}>
        <TextEntry
          label="Model"
          maxLength={200}
          onSubmit={value =>
            void task.run(() => {
              if (isStreaming) {
                task.setMessage('Cancel the active response first.');
                return;
              }
              const added = client.addManualModel(value.trim(), account);
              setModel(added.id);
              setManual(false);
            })
          }
        />
      </Dialog>
    );
  if (chosen)
    return (
      <PickerDialog
        title={`Model · ${chosen.id}`}
        {...props}
        message={task.message}
        items={[
          {id: 'default', label: 'Auto · provider default'},
          ...(chosen.reasoningEfforts ?? []).map(id => ({id, label: id})),
          {id: 'back', label: 'Back to models'},
        ]}
        onSelect={item => (item.id === 'back' ? setModel(null) : select(chosen.id, item.id))}
      />
    );
  return (
    <PickerDialog
      key={account ?? 'active'}
      title="Model / Reasoning effort"
      {...props}
      message={task.busy ? 'Discovering models…' : task.message}
      items={models.map(m => ({
        id: m.id,
        keywords: m.name,
        label: `${m.id === client.status().selection?.modelId ? '● ' : ''}${m.id}`,
        description: `${m.reasoningEfforts?.join(' · ') || 'Provider default effort'}`,
      }))}
      onSelect={item => setModel(item.id)}
    >
      <TextLine>{`${client.listAccounts().find(a => a.id === (account ?? client.status().activeAccount?.id))?.alias ?? 'No account'} · Ctrl+R discover · Ctrl+A manual · Tab account`}</TextLine>
    </PickerDialog>
  );
}
export function EffortDialog({onChanged, isStreaming = false, ...props}: ModelsDialogProps) {
  const client = useFutrynClient();
  useDialogRefresh();
  const status = client.status();
  const router = useOverlay();
  const task = useDialogTask();
  return (
    <PickerDialog
      title="Reasoning effort"
      {...props}
      message={task.message}
      items={[
        {id: 'default', label: 'Auto · provider default'},
        ...(status.activeModel?.reasoningEfforts ?? []).map(id => ({id, label: id})),
      ]}
      onSelect={item =>
        void task.run(() => {
          if (isStreaming) {
            task.setMessage('Cancel the active response first.');
            return;
          }
          client.setReasoningEffort(item.id);
          onChanged?.();
          router.close();
        })
      }
    />
  );
}
