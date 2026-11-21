/** @jsxImportSource react */
import {Box, Text, type TextProps} from 'ink';
import {Fragment, memo, useMemo, type ReactNode} from 'react';
import type {ThemeTokenKey} from '@cosmew/contracts';
import {Lexer, type Token, type Tokens} from 'marked';
import {WindowedRows} from '../screen';
import {useTheme} from '../theme';
import {DiffView} from './diff';
import {CodeBlock} from './code-block';
import {safeText, stringCells, TextLine, wrapRuns, type WrapRun} from './text-line';
import {renderCache} from './render-cache';
export interface MarkdownProps {
  text: string;
  width?: number;
  tone?: 'thinking';
}
function decode(text: string): string {
  return text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, entity: string) => {
    const named: Record<string, string> = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'"};
    if (named[entity]) return named[entity];
    const code = entity.startsWith('#x') ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}
type InlineStyle = Pick<TextProps, 'bold' | 'italic' | 'strikethrough' | 'underline'> & {colorToken?: ThemeTokenKey};

function inlineRuns(tokens: Token[], style?: InlineStyle, depth = 0): WrapRun<InlineStyle>[] {
  if (depth > 24) return [{text: '…', style}];
  return tokens.flatMap(token => {
    const nested = (tone = style) =>
      'tokens' in token && token.tokens
        ? inlineRuns(token.tokens, tone, depth + 1)
        : [{text: safeText(decode('text' in token ? token.text : token.raw)), style: tone}];
    switch (token.type) {
      case 'strong':
        return nested({...style, bold: true});
      case 'em':
        return nested({...style, italic: true});
      case 'del':
        return nested({...style, strikethrough: true});
      case 'codespan':
        return nested({...style, colorToken: 'markdownCode'});
      case 'link': {
        const link = {...style, underline: true, colorToken: 'info'} as const;
        return [...nested(link), {text: ` (${safeText(token.href)})`, style: link}];
      }
      case 'image':
        return [
          {text: `[image: ${safeText(token.text)}] (${safeText(token.href)})`, style: {...style, colorToken: 'info'}},
        ];
      case 'br':
        return [{text: '\n', style}];
      default:
        return nested();
    }
  });
}

function Inline({tokens, width}: {tokens: Token[]; width?: number}) {
  const {color} = useTheme();
  const lines = useMemo(() => {
    const runs = inlineRuns(tokens);
    return width === undefined ? [runs] : wrapRuns(runs, width);
  }, [tokens, width]);
  return lines.map((line, row) => (
    <Fragment key={row}>
      {row ? '\n' : null}
      {line.map(({text, style}, index) => {
        const {colorToken, ...modifiers} = style ?? {};
        return (
          <Text key={index} {...modifiers} color={colorToken ? color(colorToken) : undefined}>
            {text}
          </Text>
        );
      })}
    </Fragment>
  ));
}
function Blocks({
  tokens,
  width,
  depth = 0,
  explicitSpacing = false,
  tone,
}: {
  tokens: (Token | null)[];
  width: number;
  depth?: number;
  explicitSpacing?: boolean;
  tone?: MarkdownProps['tone'];
}) {
  const {color} = useTheme();
  const prose = color(tone === 'thinking' ? 'foregroundMuted' : 'foreground');
  if (depth > 24) return <Text>…</Text>;
  const inline = (token: Tokens.Paragraph | Tokens.Heading | Tokens.Text): ReactNode => (
    <Inline tokens={token.tokens ?? Lexer.lexInline(token.text)} width={width} />
  );
  const last = tokens.findLastIndex(token => token !== null && token.type !== 'space');
  return (
    <Box flexDirection="column" minWidth={0}>
      {tokens.map((token, index) => {
        if (token === null) return <Box key={index} height={1} flexShrink={0} />;
        let content: ReactNode;
        switch (token.type) {
          case 'space':
            return null;
          case 'heading':
            content = (
              <Text bold color={color('markdownHeading')}>
                {inline(token as Tokens.Heading)}
              </Text>
            );
            break;
          case 'paragraph':
          case 'text':
            content = <Text color={prose}>{inline(token as Tokens.Paragraph)}</Text>;
            break;
          case 'code':
            content =
              token.lang === 'diff' || token.lang === 'patch' ? (
                <DiffView diff={token.text} width={width ?? 80} showHunks />
              ) : (
                <CodeBlock code={token.text} language={token.lang} width={width} label={false} foreground={prose} />
              );
            break;
          case 'blockquote':
            content = (
              <Box
                borderStyle="single"
                borderLeft
                borderTop={false}
                borderRight={false}
                borderBottom={false}
                borderColor={color('border')}
                paddingLeft={1}
              >
                <Blocks tokens={token.tokens ?? []} width={Math.max(1, width - 2)} depth={depth + 1} tone={tone} />
              </Box>
            );
            break;
          case 'list': {
            const list = token as Tokens.List;
            const start = Number(list.start || 1);
            const markerWidth = String(start + list.items.length - 1).length;
            content = (
              <Box flexDirection="column">
                {list.items.map((item, at) => {
                  const marker = list.ordered ? `${String(start + at).padStart(markerWidth)}. ` : '- ';
                  const prefix = item.task ? `${marker}[${item.checked ? 'x' : ' '}] ` : marker;
                  return (
                    <Box key={at}>
                      <Box flexShrink={0}>
                        <Text color={color(item.task && item.checked ? 'success' : 'info')}>{prefix}</Text>
                      </Box>
                      <Box flexGrow={1} flexShrink={1} minWidth={0}>
                        <Blocks
                          tokens={item.tokens}
                          width={Math.max(1, width - stringCells(prefix))}
                          depth={depth + 1}
                          tone={tone}
                        />
                      </Box>
                    </Box>
                  );
                })}
              </Box>
            );
            break;
          }
          case 'table': {
            const table = token as Tokens.Table;
            if (width < table.header.length * 8) {
              content = (
                <Box flexDirection="column">
                  {table.rows.map((cells, at) => (
                    <Box key={at} flexDirection="column" marginBottom={1}>
                      {cells.map((cell, col) => (
                        <Text key={col} color={prose}>
                          <Text bold color={color('markdownHeading')}>
                            {safeText(decode(table.header[col]?.text ?? ''))}
                          </Text>
                          : <Inline tokens={cell.tokens} />
                        </Text>
                      ))}
                    </Box>
                  ))}
                </Box>
              );
              break;
            }
            const cellWidth = Math.max(1, Math.floor(width / table.header.length) - 1);
            const row = (cells: Tokens.TableCell[], bold: boolean, key: number) => (
              <Box key={key}>
                {cells.map((cell, at) => (
                  <Box key={at} width={cellWidth} marginRight={1} minWidth={0}>
                    <Text bold={bold} color={bold ? color('markdownHeading') : prose}>
                      <Inline tokens={cell.tokens} width={cellWidth} />
                    </Text>
                  </Box>
                ))}
              </Box>
            );
            content = (
              <Box flexDirection="column">
                {row(table.header, true, -1)}
                <Text color={color('border')}>
                  {'─'.repeat(Math.max(1, Math.min(width, (cellWidth + 1) * table.header.length - 1)))}
                </Text>
                {table.rows.map((cells, at) => row(cells, false, at))}
              </Box>
            );
            break;
          }
          case 'hr':
            content = <Text color={color('border')}>{'─'.repeat(width)}</Text>;
            break;
          default:
            content = <TextLine color={prose}>{decode(token.raw)}</TextLine>;
        }
        return (
          <Box
            key={index}
            flexDirection="column"
            marginBottom={explicitSpacing || token.type === 'text' || index === last ? 0 : 1}
            minWidth={0}
          >
            {content}
          </Box>
        );
      })}
    </Box>
  );
}
/**
 * Common long Markdown answers consist of short paragraphs, headings and single-line code fences.
 * Each supported block is known to consume one Ink row. Fall back to the regular layout for blocks
 * whose exact height depends on wrapping, nested structure or a multi-line code renderer.
 */
function singleLineBlocks(tokens: Token[], width: number): (Token | null)[] | undefined {
  const blocks = tokens.filter(token => token.type !== 'space');
  if (blocks.length < 48) return;
  const rows: (Token | null)[] = [];
  for (let index = 0; index < blocks.length; index++) {
    const token = blocks[index]!;
    if (token.type === 'code') {
      if (
        !token.text ||
        /[\t\n]/.test(token.text) ||
        ['diff', 'patch'].includes(token.lang ?? '') ||
        stringCells(token.text) > width
      )
        return;
    } else if (
      !['text', 'heading', 'paragraph'].includes(token.type) ||
      /[\n&<>\[]/.test(token.raw.trim()) ||
      !token.raw.trim() ||
      stringCells(token.raw.trim()) > width
    )
      return;
    rows.push(token);
    if (index < blocks.length - 1 && token.type !== 'text') rows.push(null);
  }
  return rows;
}
const markdownTokens = renderCache<string, Token[]>(32);
export const Markdown = memo(function Markdown({text, width = 80, tone}: MarkdownProps) {
  const tokens = useMemo(() => {
    const source = safeText(text.slice(0, 262144));
    return markdownTokens(source, () => {
      try {
        return Lexer.lex(source, {gfm: true});
      } catch {
        return [{type: 'text', raw: source, text: source}];
      }
    });
  }, [text]);
  const columns = Math.max(1, Math.floor(width));
  const rows = useMemo(() => singleLineBlocks(tokens, columns), [tokens, columns]);
  return (
    <Box width={columns} flexDirection="column" minWidth={0}>
      {rows ? (
        <WindowedRows count={rows.length}>
          {(first, end) => <Blocks tokens={rows.slice(first, end)} width={columns} explicitSpacing tone={tone} />}
        </WindowedRows>
      ) : (
        <Blocks tokens={tokens} width={columns} tone={tone} />
      )}
      {text.length > 262144 ? <Text>… Markdown truncated at 262144 characters</Text> : null}
    </Box>
  );
});
