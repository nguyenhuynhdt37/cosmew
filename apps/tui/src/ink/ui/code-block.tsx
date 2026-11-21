/** @jsxImportSource react */
import {Box, Text} from 'ink';
import {memo, useMemo} from 'react';
import {DEFAULT_THEME, highlight, supportsLanguage, type Theme} from 'cli-highlight';
import {fgHex} from '../../theme/theme';
import {useTheme} from '../theme';
import {renderCache} from './render-cache';
import {safeText} from './text-line';
export interface CodeBlockProps {
  code: string;
  language?: string;
  lineNumbers?: boolean;
  width?: number;
  foreground?: string;
  /** Show the language name above the code (default); Markdown answers omit it, as the reference does. */
  label?: boolean;
}
export const CodeBlock = memo(function CodeBlock({
  code,
  language,
  lineNumbers = false,
  width,
  foreground,
  label = true,
}: CodeBlockProps) {
  const theme = useTheme();
  const source = useMemo(() => safeText(code.slice(0, 262144)), [code]);
  const lang = safeText(language ?? '').split(/\s/)[0] ?? '';
  const lexer = lang.toLowerCase();
  const rendered = useHighlightedCode(source, ['sh', 'zsh', 'shell'].includes(lexer) ? 'bash' : lexer);
  const lines = useMemo(() => rendered.split('\n'), [rendered]);
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
            <Text wrap="wrap" color={foreground}>
              {line || ' '}
            </Text>
          </Box>
        </Box>
      ))}
      {code.length > 262144 ? <Text>… code truncated at 262144 characters</Text> : null}
    </Box>
  );
});

const highlights = renderCache<string, string>(128);

/** Shared bounded highlighter; callers only invoke it for visible source rows. */
export function useHighlightedCode(source: string, lang: string) {
  const theme = useTheme();
  return useMemo(() => {
    if (!theme.colors || !theme.syntaxHighlighting || !lang || !supportsLanguage(lang)) return source;
    const key = JSON.stringify([
      lang,
      theme.engine.colorCapability,
      theme.tokens.syntaxKeyword,
      theme.tokens.syntaxString,
      theme.tokens.syntaxComment,
      theme.tokens.syntaxFunction,
      theme.tokens.info,
      source,
    ]);
    return highlights(key, () => {
      const style: Theme = Object.fromEntries(Object.keys(DEFAULT_THEME).map(key => [key, (text: string) => text]));
      const reset = '\x1b[39m';
      const paint = (color: string) => {
        const start = fgHex(color, theme.engine.colorCapability);
        // Resume the enclosing token after nested spans and after CodeBlock splits its rows.
        return (text: string) =>
          `${start}${text.replaceAll(reset, reset + start).replaceAll('\n', `${reset}\n${start}`)}${reset}`;
      };
      style.keyword = paint(theme.tokens.syntaxKeyword);
      style.literal = paint(theme.tokens.syntaxKeyword);
      style.variable = paint(theme.tokens.syntaxKeyword);
      style.string = paint(theme.tokens.syntaxString);
      style.comment = paint(theme.tokens.syntaxComment);
      style.built_in = paint(theme.tokens.syntaxFunction);
      style.attr = paint(theme.tokens.syntaxFunction);
      style.attribute = paint(theme.tokens.syntaxFunction);
      style.section = paint(theme.tokens.syntaxFunction);
      style.title = paint(theme.tokens.syntaxFunction);
      style.number = paint(theme.tokens.info);
      try {
        return highlight(source, {language: lang, ignoreIllegals: true, theme: style});
      } catch {
        return source;
      }
    });
  }, [source, lang, theme.colors, theme.syntaxHighlighting, theme.tokens, theme.engine.colorCapability]);
}
