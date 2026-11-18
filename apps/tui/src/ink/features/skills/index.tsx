/** @jsxImportSource react */
import {useState} from 'react';
import {useFutrynClient} from '../../hooks';
import {TextLine} from '../../ui';
import {PickerDialog, useDialogRefresh, usePicker, type DialogProps} from '../picker';
export interface SkillsDialogProps extends DialogProps {
  onInvoke?: (command: string) => void;
}
export function useSkills() {
  const client = useFutrynClient();
  useDialogRefresh();
  const router = usePicker();
  return {
    ...router,
    report: client.skills(),
    openSkills: (props: SkillsDialogProps = {}) => router.open('skills', <SkillsDialog {...props} />),
  };
}
export function SkillsDialog({onInvoke, ...props}: SkillsDialogProps) {
  const client = useFutrynClient();
  const router = usePicker();
  useDialogRefresh();
  const [selected, setSelected] = useState<string | null>(null);
  const report = client.skills();
  const skill = report.skills.find(s => s.name === selected);
  if (skill)
    return (
      <PickerDialog
        title={`Skill · ${skill.name}`}
        {...props}
        items={[
          {
            id: 'invoke',
            label: `/${skill.name}${skill.argumentHint ? ` ${skill.argumentHint}` : ''}`,
            disabled: !onInvoke,
          },
          {id: 'back', label: 'Back to skills'},
        ]}
        onSelect={item => {
          if (item.id === 'back') setSelected(null);
          else {
            router.close();
            onInvoke?.(`/${skill.name}`);
          }
        }}
      >
        <TextLine>{skill.description}</TextLine>
        <TextLine>{`${skill.source} · ${skill.shortPath} · ${skill.disableModelInvocation ? 'Explicit invocation only' : 'Model invocation allowed'}`}</TextLine>
      </PickerDialog>
    );
  return (
    <PickerDialog
      title="Skills"
      {...props}
      items={report.skills.map(s => ({
        id: s.name,
        label: `/${s.name}`,
        description: `${s.description} · ${s.source} · ${s.shortPath}`,
        keywords: s.name,
      }))}
      onSelect={item => setSelected(item.id)}
    >
      {[...report.errors, ...report.warnings].map((d, i) => (
        <TextLine key={i}>{`${d.code}${d.path ? ` · ${d.path}` : ''}`}</TextLine>
      ))}
    </PickerDialog>
  );
}
