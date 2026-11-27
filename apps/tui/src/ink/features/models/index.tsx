/** @jsxImportSource react */
import {useEffect, useState} from 'react';
import {isCodingModel, type ModelInfo, type Provider} from '@cosmew/contracts';
import {useFutrynClient, useKeybindings, useTextInput, useKeymap} from '../../hooks';
import {useOverlay} from '../../core';
import {TextLine} from '../../ui';
import {Dialog, PickerDialog, TextEntry, useDialogRefresh, useDialogTask, type DialogProps} from '../picker';
function useEffortMetadata(accountId?: string, modelId?: string) {
  const client = useFutrynClient();
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let mounted = true;
    const pending = client.refreshModelMetadata({accountId, modelId});
    setLoading(!!pending);
    void pending?.finally(() => {
      if (mounted) setLoading(false);
    });
    return () => {
      mounted = false;
    };
  }, [client, accountId, modelId]);
  return loading;
}
const levelsFor = (model?: ModelInfo | null) => model?.reasoningEfforts ?? [];
function formatModelLimit(tokens: number): string {
  if (tokens >= 1_000_000) {
    if (tokens === 1_048_576 || tokens === 1_000_000) return '1M';
    if (tokens === 2_097_152 || tokens === 2_000_000) return '2M';
    const millions = tokens / 1_000_000;
    return `${Number.isInteger(millions) ? String(millions) : millions.toFixed(1).replace(/\.0$/, '')}M`;
  }
  if (tokens >= 1_000) {
    if (tokens >= 4096 && tokens % 1024 === 0 && tokens % 1000 !== 0) return `${tokens / 1024}k`;
    if (tokens % 1000 === 0) return `${tokens / 1000}k`;
    return `${Math.round(tokens / 1000)}k`;
  }
  return String(tokens);
}
export function modelLimitsLabel(model: ModelInfo, showUnknown = false): string {
  const parts: string[] = [];
  if (model.contextLimit) parts.push(`${formatModelLimit(model.contextLimit)} ctx`);
  else if (showUnknown) parts.push('context unknown');
  if (model.outputLimit) parts.push(`${formatModelLimit(model.outputLimit)} out`);
  const caps = (['tools', 'vision', 'reasoning'] as const).filter(cap => model.capabilities[cap] === 'supported');
  if (caps.length) parts.push(caps.join('/'));
  return parts.join(' · ');
}
const budgetHint = (model?: ModelInfo | null, provider?: Provider | null) =>
  (provider?.protocol === 'anthropic' ||
    provider?.protocol === 'gemini' ||
    provider?.protocol === 'vertex' ||
    provider?.protocol === 'vertex-anthropic') &&
  levelsFor(model).some(level => level !== 'none') &&
  model?.reasoningOptions?.budgetMin !== undefined &&
  !model.reasoningOptions.efforts ? (
    <TextLine wrap="truncate-end">Budget-based thinking: level sets the token budget</TextLine>
  ) : null;
const effortNotice = (model?: ModelInfo | null, provider?: Provider | null): string => {
  return model?.reasoningEfforts?.length
    ? ''
    : `No effort levels known for ${model?.id ?? 'this model'}. Using the provider default. Declare them in ~/.cosmew/config.toml ([model_providers.${provider?.id ?? '<id>'}.reasoning...]).`;
};
export interface ModelsDialogProps extends DialogProps {
  accountId?: string;
  onChanged?: () => void;
  isStreaming?: boolean;
}
export function ModelsDialog({accountId, onChanged, isStreaming = false, ...props}: ModelsDialogProps) {
  const client = useFutrynClient();
  const router = useOverlay();
  useDialogRefresh();
  const task = useDialogTask();
  const [account, setAccount] = useState(accountId);
  const [manual, setManual] = useState(false);
  const [model, setModel] = useState<string | null>(null);
  const [chosenEffort, setChosenEffort] = useState('default');
  const [showAll, setShowAll] = useState(false);
  const allModels = client.cachedModels(account);
  const selection = client.status().selection;
  const selectedId =
    selection?.accountId === (account ?? client.status().activeAccount?.id) ? selection?.modelId : undefined;
  const codingModels = allModels.filter(m => isCodingModel(m, selectedId));
  const hidden = allModels.length - codingModels.length;
  const models = showAll ? allModels : codingModels;
  const chosen = models.find(m => m.id === model);
  const provider = client
    .status()
    .providers.find(
      p =>
        p.id === client.listAccounts().find(a => a.id === (account ?? client.status().activeAccount?.id))?.providerId,
    );
  /** Highlighted model and the effort ←/→ picked for it (the list's Enter applies both). */
  const [highlight, setHighlight] = useState<string>();
  const [effortPick, setEffortPick] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const highlighted =
    models.find(m => m.id === highlight) ?? models.find(m => m.id === client.status().selection?.modelId);
  const loading = useEffortMetadata(account, chosen?.id ?? highlighted?.id);
  const stepEffort = (step: 1 | -1) => {
    const efforts = levelsFor(highlighted);
    if (!highlighted || !efforts.length) {
      setNote(effortNotice(highlighted, provider));
      return;
    }
    const at = efforts.indexOf(effortPick[highlighted.id] ?? client.status().reasoningEffort ?? '');
    const next = efforts[Math.max(0, Math.min(efforts.length - 1, (at < 0 ? efforts.length - 1 : at) + step))]!;
    setEffortPick(old => ({...old, [highlighted.id]: next}));
    setNote('');
  };
  useKeybindings(
    {
      ModelPicker: {
        'modelPicker:decreaseEffort': () => stepEffort(-1),
        'modelPicker:increaseEffort': () => stepEffort(1),
        'modelPicker:sessionOnly': () => {
          if (highlighted) select(highlighted.id, effortPick[highlighted.id], true);
        },
      },
    },
    {isActive: !manual && !model && !task.busy},
  );
  useKeybindings(
    {
      ModelPicker: {
        'modelPicker:sessionOnly': () => {
          if (chosen && chosenEffort !== 'back') select(chosen.id, chosenEffort, true);
        },
      },
    },
    {isActive: !!chosen && !task.busy},
  );
  const select = (id: string, effort?: string, sessionOnly = false) =>
    void task.run(async signal => {
      if (isStreaming) {
        task.setMessage('Cancel the active response before changing model.');
        return;
      }
      if (sessionOnly) client.selectModel(id, {accountId: account, scope: 'session'});
      else if (account && account !== client.status().activeAccount?.id)
        await client.switchAccount(account, true, id, signal);
      else client.selectModel(id);
      if (signal.aborted) return;
      if (effort) client.setReasoningEffort(effort, sessionOnly ? {scope: 'session'} : undefined);
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
        message={task.message || (loading ? 'Loading effort levels…' : effortNotice(chosen, provider))}
        items={[
          {id: 'default', label: 'Auto · provider default'},
          ...levelsFor(chosen).map(id => ({id, label: id})),
          {id: 'back', label: 'Back to models'},
        ]}
        onHighlight={item => setChosenEffort(item.id)}
        onSelect={item => (item.id === 'back' ? setModel(null) : select(chosen.id, item.id))}
      >
        {budgetHint(chosen, provider)}
      </PickerDialog>
    );
  return (
    <PickerDialog
      key={account ?? 'active'}
      title="Model / Reasoning effort"
      onTextKey={input => {
        if (input !== 'a') return false;
        setShowAll(value => !value);
        return true;
      }}
      {...props}
      message={task.busy ? 'Discovering models…' : loading ? 'Loading effort levels…' : task.message}
      items={models.map(m => {
        const limits = modelLimitsLabel(m);
        const efforts = levelsFor(m).join(' · ') || 'No effort levels known · provider default';
        return {
          id: m.id,
          keywords: m.name,
          label: m.id,
          current: m.id === client.status().selection?.modelId,
          description: limits ? `${limits} · ${efforts}` : efforts,
        };
      })}
      onHighlight={item => setHighlight(item.id)}
      onSelect={item => (effortPick[item.id] ? select(item.id, effortPick[item.id]) : setModel(item.id))}
    >
      {hidden > 0 && (
        <TextLine>{`${hidden} non-coding models ${showAll ? 'shown · press a to hide' : 'hidden · press a to show all'}`}</TextLine>
      )}
      <TextLine>{`${client.listAccounts().find(a => a.id === (account ?? client.status().activeAccount?.id))?.alias ?? 'No account'} · Ctrl+R discover · Ctrl+A manual · Tab account · s session only`}</TextLine>
      {budgetHint(highlighted, provider)}
      {highlighted && levelsFor(highlighted).length ? (
        <TextLine>{`←/→ effort: ${effortPick[highlighted.id] ?? client.status().reasoningEffort ?? 'default'}${note ? ' · ' + note : ''}`}</TextLine>
      ) : (
        <TextLine>{note || effortNotice(highlighted, provider)}</TextLine>
      )}
    </PickerDialog>
  );
}
export function EffortDialog({onChanged, isStreaming = false, ...props}: ModelsDialogProps) {
  const client = useFutrynClient();
  useDialogRefresh();
  const status = client.status();
  const loading = useEffortMetadata(status.activeAccount?.id, status.activeModel?.id);
  const router = useOverlay();
  const task = useDialogTask();
  const efforts = levelsFor(status.activeModel);
  const levels = ['default', ...efforts];
  const [slider, setSlider] = useState(() => Math.max(0, levels.indexOf(status.reasoningEffort ?? 'default')));
  const apply = (id: string, sessionOnly = false) =>
    void task.run(() => {
      if (isStreaming) {
        task.setMessage('Cancel the active response first.');
        return;
      }
      client.setReasoningEffort(id, sessionOnly ? {scope: 'session'} : undefined);
      onChanged?.();
      router.close();
    });
  // Enter saves the preference; s applies only to this session.
  useKeybindings(
    {
      EffortSlider: {
        'effort:decrease': () => setSlider(at => Math.max(0, at - 1)),
        'effort:increase': () => setSlider(at => Math.min(levels.length - 1, at + 1)),
        'effort:confirm': () => apply(levels[Math.min(slider, levels.length - 1)]!),
        'effort:sessionOnly': () => apply(levels[Math.min(slider, levels.length - 1)]!, true),
      },
    },
    {isActive: !task.busy},
  );
  return (
    <PickerDialog
      title="Reasoning effort"
      {...props}
      message={
        task.message || (loading ? 'Loading effort levels…' : effortNotice(status.activeModel, status.activeProvider))
      }
      hint={
        efforts.length
          ? '←/→ to adjust · Enter to save · s session only · Esc to cancel'
          : 'Enter to reset · s session only · Esc to cancel'
      }
      filterable={false}
      cursor={slider}
      onCursorChange={setSlider}
      items={[
        {
          id: 'default',
          label: 'Auto · provider default',
          current: !status.reasoningEffort || status.reasoningEffort === 'default',
        },
        ...efforts.map(id => ({
          id,
          label: id,
          current: status.reasoningEffort === id,
        })),
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
    >
      {budgetHint(status.activeModel, status.activeProvider)}
    </PickerDialog>
  );
}
