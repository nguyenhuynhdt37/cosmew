/** @jsxImportSource react */
import {memo} from 'react';
import {Box, Text} from 'ink';
import {useTheme} from '../../theme';
import {CodeBlock, DiffView, useUiTheme} from '../../ui';

/** Sample change drawn in the preview so every theme is judged on real diff colours. */
const SAMPLE: readonly {sign: ' ' | '-' | '+'; text: string}[] = [
  {sign: ' ', text: ' function greet() {'},
  {sign: '-', text: '  console.log("Hello, World!");'},
  {sign: '+', text: '  console.log("Hello, Cosmew!");'},
  {sign: ' ', text: ' }'},
];
export const SAMPLE_DIFF = '@@ -1,3 +1,3 @@\n' + SAMPLE.map(row => row.sign + row.text).join('\n');

/**
 * Renders under a ThemePreviewScope: every colour comes from the scoped context, never from the engine's
 * active theme, so moving the picker cursor repaints only this box.
 */
export const ThemePreview = memo(function ThemePreview({
  width,
  compact,
  maxLines,
}: {
  width: number;
  compact: boolean;
  /** Short terminals: keep only the first lines, most telling first (status colours right after the title). */
  maxLines?: number;
}) {
  const {engine, manifest, color} = useTheme();
  const ui = useUiTheme();
  const muted = color('foregroundMuted');
  const colors = engine.colorCapability;
  const lines = [
    <Text key="title" bold color={color('markdownHeading')} wrap="truncate-end">
      {`Preview · ${manifest.name}`}
    </Text>,
    <Text key="status" wrap="truncate-end" color={muted}>
      <Text color={color('success')}>✓ Done</Text> · <Text color={color('warning')}>! Warning</Text> ·{' '}
      <Text color={color('error')}>× Error</Text> · <Text color={color('info')}>i Info</Text>
    </Text>,
    <Text key="prompt" wrap="truncate-end" backgroundColor={ui.color('userMessage')} color={color('foreground')}>
      {'❯ fix the greeting'}
    </Text>,
    <Text key="update" wrap="truncate-end" color={color('foreground')}>
      <Text color={ui.color('toolSuccess')}>⏺ </Text>
      <Text bold>Update</Text>(<Text color={ui.color('path')}>src/app.ts</Text>)
    </Text>,
    compact ? null : <DiffView key="diff" diff={SAMPLE_DIFF} width={width} language="javascript" />,
    <Text key="markdown" wrap="truncate-end">
      <Text bold color={color('markdownHeading')}>
        # Release notes
      </Text>
      <Text color={muted}> · </Text>
      <Text color={color('markdownCode')}>`theme`</Text>
    </Text>,
    <Text key="config" wrap="truncate-end" color={muted}>
      <Text color={ui.color('command')}>/config</Text> · <Text color={ui.color('bashMode')}>Bash</Text> ·{' '}
      <Text color={ui.color('thinking')}>✻ Thinking</Text>
    </Text>,
    <CodeBlock
      key="code"
      code={'echo "$HOME" # shell'}
      language="bash"
      label={false}
      width={width}
      foreground={color('foreground')}
    />,
    compact ? null : (
      <Text key="colors" wrap="truncate-end">
        <Text color={muted}>Terminal colors </Text>
        <Text color={colors === 'none' ? muted : ui.color('command')}>
          {colors === 'none' ? 'Off' : colors === 'truecolor' ? 'Truecolor' : `${colors} colors`}
        </Text>
      </Text>
    ),
  ].filter(line => line !== null);
  return (
    <Box flexDirection="column" width={width} minWidth={0} backgroundColor={color('background')}>
      {maxLines === undefined ? lines : lines.slice(0, Math.max(1, maxLines))}
    </Box>
  );
});
