/** @jsxImportSource react */
import {useState} from 'react';
import {Box} from 'ink';
import {useKeybindings} from '../../hooks';
import {useBindingLabel} from '../../hooks/keymap';
import {useMouseTarget} from '../../hooks/use-terminal-wheel';
import {safeText, TextLine, wrapText} from '../../ui';

/** A bounded live tail. Manual scrolling pauses follow; reaching the end resumes it. */
export function TaskOutput({
  text,
  width,
  visibleRows,
  onBack,
}: {
  text: string;
  width: number;
  visibleRows: number;
  onBack(): void;
}) {
  const lines = wrapText(safeText(text.slice(-8192)) || '(No output yet)', width);
  const count = Math.max(1, visibleRows);
  const max = Math.max(0, lines.length - count);
  const [offset, setOffset] = useState<number | null>(null);
  const start = offset === null ? max : Math.min(offset, max);
  const move = (delta: number) => {
    const next = Math.max(0, Math.min(max, start + delta));
    setOffset(next === max ? null : next);
  };
  const top = () => setOffset(max ? 0 : null);
  const bottom = () => setOffset(null);
  const page = Math.max(1, Math.floor(count / 2));
  useKeybindings({
    Select: {
      'select:previous': () => move(-1),
      'select:next': () => move(1),
      'select:pageUp': () => move(-page),
      'select:pageDown': () => move(page),
      'select:first': top,
      'select:last': bottom,
      'select:accept': onBack,
      'select:cancel': onBack,
    },
    Scroll: {
      'scroll:lineUp': () => move(-1),
      'scroll:lineDown': () => move(1),
      'scroll:pageUp': () => move(-page),
      'scroll:pageDown': () => move(page),
      'scroll:top': top,
      'scroll:bottom': bottom,
    },
  });
  const mouseRef = useMouseTarget(event => {
    if ('direction' in event) move(event.direction);
  });
  const followKey = useBindingLabel('Select', 'select:last');
  return (
    <>
      <Box ref={mouseRef} flexDirection="column" width={width} minWidth={0}>
        {lines.slice(start, start + count).map((line, index) => (
          <TextLine key={index} width={width} wrap="truncate-end">
            {line || ' '}
          </TextLine>
        ))}
      </Box>
      <TextLine width={width} wrap="truncate-end">
        {`${start + 1}–${Math.min(lines.length, start + count)}/${lines.length} · ${offset === null ? 'following' : `${followKey} follow`}`}
      </TextLine>
    </>
  );
}
