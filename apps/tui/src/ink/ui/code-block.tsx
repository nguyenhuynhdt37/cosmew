/** @jsxImportSource react */
import {Box, Text} from 'ink';
import {useMemo} from 'react';
import {DEFAULT_THEME, highlight, supportsLanguage, type Theme} from 'cli-highlight';
import {fgHex} from '../../theme/theme';
import {useTheme} from '../theme';
import {safeText} from './text-line';
export interface CodeBlockProps {
  code: string;
  language?: string;
  lineNumbers?: boolean;
  width?: number;
  /** Show the language name above the code (default); Markdown answers omit it, as the reference does. */
  label?: boolean;
}
export function CodeBlock({code, language, lineNumbers = false, width, label = true}: CodeBlockProps) {
  const theme = useTheme();
  const source = safeText(code).slice(0, 262144);
  const lang = safeText(language ?? '').split(/\s/)[0] ?? '';
  const rendered = useMemo(() => {
    if (!theme.colors || !theme.syntaxHighlighting || !lang || !supportsLanguage(lang)) return source;
    const style: Theme = Object.fromEntries(Object.keys(DEFAULT_THEME).map(key => [key, (text: string) => text]));
    const paint = (color: string) => (text: string) => `${fgHex(color, theme.engine.colorCapability)}${text}\x1b[39m`;
    style.keyword = paint(theme.tokens.syntaxKeyword);
    style.string = paint(theme.tokens.syntaxString);
    style.comment = paint(theme.tokens.syntaxComment);
    style.title = paint(theme.tokens.syntaxFunction);
    style.number = paint(theme.tokens.markdownCode);
    try {
      return highlight(source, {language: lang, ignoreIllegals: true, theme: style});
    } catch {
      return source;
    }
  }, [source, lang, theme.colors, theme.syntaxHighlighting, theme.tokens, theme.engine]);
  const lines = rendered.split('\n');
  const digits = String(lines.length).length;
  return (
    <Box flexDirection="column" width={width} minWidth={0}>
      {lang && label ? <Text color={theme.color('foregroundMuted')}>{lang}</Text> : null}
      {lines.map((line, index) => (
        <Box key={index} minWidth={0}>
          {lineNumbers ? (
            <Text color={theme.color('foregroundSubtle')}>{String(index + 1).padStart(digits)} │ </Text>
          ) : null}
          <Box minWidth={0} flexShrink={1}>
            <Text wrap="wrap">{line || ' '}</Text>
          </Box>
        </Box>
      ))}
      {code.length > 262144 ? <Text>… code truncated at 262144 characters</Text> : null}
    </Box>
  );
}
