/** @jsxImportSource react */
import {useEffect, useState} from 'react';
import {useTheme} from '../../theme';
import {useOverlay} from '../../core';
import {TextLine} from '../../ui';
import {PickerDialog, useDialogTask, usePicker, type DialogProps} from '../picker';
export function useThemes() {
  const {engine} = useTheme();
  const router = usePicker();
  return {
    ...router,
    themes: engine.listThemes('all'),
    openThemes: (props: DialogProps = {}) => router.open('themes', <ThemesDialog {...props} />),
  };
}
export function ThemesDialog(props: DialogProps) {
  const {engine, color} = useTheme();
  const router = useOverlay();
  const task = useDialogTask();
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(
    () => () => {
      if (engine.isPreviewing()) engine.cancelPreview();
    },
    [engine],
  );
  if (preview)
    return (
      <PickerDialog
        title="Theme preview"
        {...props}
        message={task.message}
        items={[
          {id: 'apply', label: 'Apply theme'},
          {id: 'back', label: 'Back · undo preview'},
        ]}
        onSelect={item =>
          void task.run(async signal => {
            if (item.id === 'back') {
              engine.cancelPreview();
              setPreview(null);
              return;
            }
            await engine.setTheme(preview);
            if (!signal.aborted) router.close();
          })
        }
      >
        <TextLine color={color('accent')}>{preview}</TextLine>
        <TextLine color={color('foreground')}>Response text · Aa 日本語 Tiếng Việt</TextLine>
        <TextLine color={color('warning')}>Permission request preview</TextLine>
        <TextLine color={color('error')}>− removed line</TextLine>
        <TextLine color={color('success')}>+ added line</TextLine>
      </PickerDialog>
    );
  return (
    <PickerDialog
      title="Themes"
      {...props}
      message={task.message}
      items={engine
        .listThemes('all')
        .map(t => ({id: t.id, label: `${t.id === engine.getCommittedAppearance().theme ? '● ' : ''}${t.name}`}))}
      onSelect={item =>
        void task.run(() => {
          engine.previewTheme(item.id);
          setPreview(item.id);
        })
      }
    />
  );
}
