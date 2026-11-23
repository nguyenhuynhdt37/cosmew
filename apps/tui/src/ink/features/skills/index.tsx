/** @jsxImportSource react */
import {useMemo, useState} from 'react';
import {SKILL_VISIBILITIES, type SkillMetadata, type SkillVisibility} from '@cosmew/contracts';
import {useFutrynClient} from '../../hooks';
import {TextLine} from '../../ui';
import {PickerDialog, useDialogRefresh, useDialogSize, type DialogProps} from '../picker';

const sources = ['project', 'user', 'system'] as const;
const groups = {project: 'Project', user: 'Personal', system: 'Built-in'};
const visibilityLabels: Record<SkillVisibility, string> = {
  on: 'on',
  'name-only': 'name-only',
  'user-invocable-only': 'user-only',
  off: 'off',
};

export function SkillsDialog({
  onChange,
  ...props
}: DialogProps & {onChange(changes: Record<string, SkillVisibility>): void}) {
  const client = useFutrynClient();
  const {revision} = useDialogRefresh();
  const {skills, errors, warnings} = useMemo(() => client.skills(), [client, revision]);
  const [changes, setChanges] = useState<Record<string, SkillVisibility>>({});
  const [sortByTokens, setSortByTokens] = useState(false);
  const size = useDialogSize(props);
  const tokens = (skill: SkillMetadata) => Math.ceil(Buffer.byteLength(skill.description) / 3);

  const toggle = (skill: SkillMetadata) => {
    if (skill.disableModelInvocation) return;
    const initial = skill.visibility ?? 'on';
    const current = Object.hasOwn(changes, skill.name) ? changes[skill.name]! : initial;
    const next = SKILL_VISIBILITIES[(SKILL_VISIBILITIES.indexOf(current) + 1) % SKILL_VISIBILITIES.length]!;
    const updated = {...changes};
    if (next === initial) delete updated[skill.name];
    else updated[skill.name] = next;
    setChanges(updated);
    onChange(updated);
  };

  return (
    <PickerDialog
      title="Skills"
      width={size.width}
      visibleRows={Math.max(1, size.visibleRows - sources.length)}
      showSearch
      placeholder="Filter by name, description or source…"
      hint="↑/↓ navigate · Space/Enter change visibility · t sort · Esc save"
      onTextKey={(key, query, item) => {
        if (key === 't' && !query) {
          setSortByTokens(value => !value);
          return true;
        }
        if (key === ' ' && item) {
          toggle(item.skill);
          return true;
        }
        return false;
      }}
      items={sources.flatMap(source =>
        skills
          .filter(skill => skill.source === source)
          .sort((a, b) => (sortByTokens ? tokens(b) - tokens(a) : 0) || a.name.localeCompare(b.name))
          .map(skill => {
            const visibility = Object.hasOwn(changes, skill.name)
              ? changes[skill.name]!
              : (skill.visibility ?? (skill.disableModelInvocation ? 'user-invocable-only' : 'on'));
            return {
              id: skill.name,
              label: `/${skill.name} [${visibilityLabels[visibility]}${skill.disableModelInvocation ? ' · locked' : ''}]`,
              description: `${sortByTokens ? `~${tokens(skill)} tokens · ` : ''}${skill.description}`,
              keywords: `${skill.source} ${skill.shortPath}`,
              group: groups[source],
              skill,
            };
          }),
      )}
      onSelect={item => toggle(item.skill)}
    >
      {[...errors, ...warnings].slice(0, 3).map((diagnostic, index) => (
        <TextLine key={index}>{`${diagnostic.code}${diagnostic.path ? ` · ${diagnostic.path}` : ''}`}</TextLine>
      ))}
    </PickerDialog>
  );
}
