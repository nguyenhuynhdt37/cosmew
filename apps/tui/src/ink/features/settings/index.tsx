/** @jsxImportSource react */
import {useEffect, useState} from 'react';
import {useFutrynClient, useTextInput} from '../../hooks';
import {useTheme} from '../../theme';
import {TextLine} from '../../ui';
import {PickerDialog, useDialogRefresh, useDialogTask, usePicker, type DialogProps} from '../picker';
import {configurationRows, SETTINGS_SECTIONS, clampStep, type SettingsSection, type ConfigurationAction} from './logic';
export {configurationRows, SETTINGS_SECTIONS, settingsRows, clampStep} from './logic';
export interface SettingsDialogProps extends DialogProps {
  onNavigate: (action: ConfigurationAction) => void;
  isStreaming?: boolean;
  initialSection?: SettingsSection;
  onSectionChange?: (section: SettingsSection) => void;
}
export function useSettings() {
  const router = usePicker();
  return {
    ...router,
    openSettings: (props: SettingsDialogProps) => router.open('settings', <SettingsDialog {...props} />),
  };
}
export function SettingsDialog({
  onNavigate,
  isStreaming = false,
  initialSection = 'General',
  onSectionChange,
  ...props
}: SettingsDialogProps) {
  const client = useFutrynClient();
  const {engine, mode} = useTheme();
  const {refresh} = useDialogRefresh();
  const task = useDialogTask();
  const [section, setSection] = useState<SettingsSection>(initialSection);
  useEffect(() => {
    onSectionChange?.(section);
  }, [section, onSectionChange]);
  const [scope, setScope] = useState<'global' | 'project'>('global');
  useTextInput((input, key) => {
    if (key.eventType === 'release') return;
    if (key.ctrl && input === 'g') setScope(s => (s === 'global' ? 'project' : 'global'));
    else if (key.tab)
      setSection(
        s =>
          SETTINGS_SECTIONS[
            (SETTINGS_SECTIONS.indexOf(s) + (key.shift ? SETTINGS_SECTIONS.length - 1 : 1)) % SETTINGS_SECTIONS.length
          ]!,
      );
  });
  const rows = configurationRows(client, section, engine.getActiveAppearance(), mode);
  const activate = (index: number) =>
    void task.run(async () => {
      const row = rows[index];
      if (!row) return;
      if (row.disabled) {
        task.setMessage(row.disabled);
        return;
      }
      const action = row.action;
      if (!action) return;
      if (isStreaming && !action.startsWith('appearance-')) {
        task.setMessage('Wait for the active turn before changing agent settings.');
        return;
      }
      if (action === 'mode') client.cycleMode();
      else if (action.startsWith('budget-')) {
        const choices = {
          'budget-steps': {key: 'maxSteps', values: [undefined, 8, 16, 32, 64]},
          'budget-calls': {key: 'maxToolCalls', values: [undefined, 16, 32, 64, 128]},
          'budget-tokens': {key: 'maxTokens', values: [undefined, 10000, 50000, 100000]},
          'budget-time': {key: 'maxDurationMs', values: [undefined, 60000, 300000, 900000]},
          'budget-cost': {key: 'maxCostUSD', values: [undefined, 1, 5, 10, 50]},
        } as const;
        const preset = choices[action as keyof typeof choices];
        const budget = {...client.turnBudget()};
        const at = (preset.values as readonly (number | undefined)[]).indexOf(budget[preset.key]);
        const value = preset.values[(at + 1) % preset.values.length];
        if (value === undefined) delete budget[preset.key];
        else budget[preset.key] = value;
        client.setDefaultTurnBudget(budget);
      } else if (action.startsWith('appearance-')) {
        const app = engine.getActiveAppearance();
        const a = app.animations;
        switch (Number(action.slice(11))) {
          case 0: {
            const values = ['auto', 'dark', 'light'];
            await engine.setTheme(values[(values.indexOf(app.theme) + 1) % values.length]!, scope);
            break;
          }
          case 1: {
            const values = ['dark', 'light', 'system'] as const;
            await engine.setMode(values[(values.indexOf(app.mode) + 1) % 3]!, scope);
            break;
          }
          case 3:
            await engine.updateAnimation({enabled: !a.enabled}, scope);
            break;
          case 4:
            await engine.updateAnimation({motion: a.motion === 'smooth' ? 'grid' : 'smooth'}, scope);
            break;
          case 5:
            await engine.updateAnimation({speed: a.speed >= 16 ? 0.1 : clampStep(a.speed, 0.25, 0.1, 16)}, scope);
            break;
          case 6:
            await engine.updateAnimation({cellSize: (a.cellSize % 4) + 1}, scope);
            break;
          case 7:
            await engine.updateAnimation({veil: a.veil >= 0.95 ? 0 : clampStep(a.veil, 0.05, 0, 0.95)}, scope);
            break;
          case 8:
            await engine.updateAnimation({reducedMotion: !a.reducedMotion}, scope);
            break;
          case 9:
            await engine.updateAnimation({pauseUnfocused: !a.pauseUnfocused}, scope);
            break;
          case 10:
            await engine.updateAnimation({reactiveEffects: !a.reactiveEffects}, scope);
            break;
          case 11:
            await engine.updateAppearance({syntaxHighlighting: !app.syntaxHighlighting}, scope);
            break;
          case 12:
            await engine.updateAppearance({sidebar: !app.sidebar}, scope);
            break;
        }
      } else onNavigate(action);
      refresh();
    });
  return (
    <PickerDialog
      key={section}
      title={`Settings · ${section}`}
      {...props}
      message={task.message}
      items={rows.map((r, index) => ({
        id: String(index),
        label: `${r.label}: ${r.value}`,
        description: `${r.source ?? ''}${r.disabled ? ` · ${r.disabled}` : ''}`,
      }))}
      onSelect={item => activate(Number(item.id))}
    >
      <TextLine>{`${SETTINGS_SECTIONS.join(' · ')}\nTab section · Ctrl+G appearance scope: ${scope}`}</TextLine>
    </PickerDialog>
  );
}
