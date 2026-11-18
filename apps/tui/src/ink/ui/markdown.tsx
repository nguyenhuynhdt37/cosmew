/** @jsxImportSource react */
import {Box, Text} from 'ink';
import {useMemo, type ReactNode} from 'react';
import {Lexer, type Token, type Tokens} from 'marked';
import {useTheme} from '../theme';
import {CodeBlock} from './code-block';
import {safeText, TextLine} from './text-line';
export interface MarkdownProps {
  text: string;
  width?: number;
}
function decode(text: string): string {
  return text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, entity: string) => {
    const named: Record<string, string> = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'"};
    if (named[entity]) return named[entity];
    const code = entity.startsWith('#x') ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}
function Inline({tokens, depth = 0}: {tokens: Token[]; depth?: number}) {
  const {color} = useTheme();
  if (depth > 24) return <Text>…</Text>;
  return (
    <>
      {tokens.map((token, index) => {
        const children =
          'tokens' in token && token.tokens ? (
            <Inline tokens={token.tokens} depth={depth + 1} />
          ) : (
            safeText(decode('text' in token ? token.text : token.raw))
          );
        switch (token.type) {
          case 'strong':
            return (
              <Text key={index} bold>
                {children}
              </Text>
            );
          case 'em':
            return (
              <Text key={index} italic>
                {children}
              </Text>
            );
          case 'del':
            return (
              <Text key={index} strikethrough>
                {children}
              </Text>
            );
          case 'codespan':
            return (
              <Text key={index} color={color('markdownCode')}>
                {safeText(decode(token.text))}
              </Text>
            );
          case 'link':
            return (
              <Text key={index} underline color={color('accent')}>
                {children} ({safeText(token.href)})
              </Text>
            );
          case 'image':
            return (
              <Text key={index}>
                [image: {safeText(token.text)}] ({safeText(token.href)})
              </Text>
            );
          case 'br':
            return <Text key={index}>{'\n'}</Text>;
          default:
            return <Text key={index}>{children}</Text>;
        }
      })}
    </>
  );
}
function Blocks({tokens, width, depth = 0}: {tokens: Token[]; width: number; depth?: number}) {
  const {color} = useTheme();
  if (depth > 24) return <Text>…</Text>;
  const inline = (token: Tokens.Paragraph | Tokens.Heading | Tokens.Text): ReactNode => (
    <Inline tokens={token.tokens ?? Lexer.lexInline(token.text)} />
  );
  return (
    <Box flexDirection="column" minWidth={0}>
      {tokens.map((token, index) => {
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
            content = <Text>{inline(token as Tokens.Paragraph)}</Text>;
            break;
          case 'code':
            content = <CodeBlock code={token.text} language={token.lang} width={width} />;
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
                <Blocks tokens={token.tokens ?? []} width={Math.max(1, width - 2)} depth={depth + 1} />
              </Box>
            );
            break;
          case 'list': {
            const list = token as Tokens.List;
            content = (
              <Box flexDirection="column">
                {list.items.map((item, at) => (
                  <Box key={at}>
                    <Text>
                      {list.ordered ? `${Number(list.start) + at}. ` : '• '}
                      {item.task ? `[${item.checked ? 'x' : ' '}] ` : ''}
                    </Text>
                    <Box flexGrow={1} flexShrink={1} minWidth={0}>
                      <Blocks tokens={item.tokens} width={Math.max(1, width - 3)} depth={depth + 1} />
                    </Box>
                  </Box>
                ))}
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
                        <Text key={col}>
                          <Text bold>{safeText(decode(table.header[col]?.text ?? ''))}</Text>:{' '}
                          <Inline tokens={cell.tokens} />
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
                    <Text bold={bold}>
                      <Inline tokens={cell.tokens} />
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
            content = <TextLine>{decode(token.raw)}</TextLine>;
        }
        return (
          <Box key={index} flexDirection="column" marginBottom={token.type === 'text' ? 0 : 1} minWidth={0}>
            {content}
          </Box>
        );
      })}
    </Box>
  );
}
export function Markdown({text, width = 80}: MarkdownProps) {
  const tokens = useMemo(() => {
    const source = safeText(text).slice(0, 262144);
    try {
      return Lexer.lex(source, {gfm: true});
    } catch {
      return [{type: 'text', raw: source, text: source}] as Token[];
    }
  }, [text]);
  const columns = Math.max(1, Math.floor(width));
  return (
    <Box width={columns} flexDirection="column" minWidth={0}>
      <Blocks tokens={tokens} width={columns} />
      {text.length > 262144 ? <Text>… Markdown truncated at 262144 characters</Text> : null}
    </Box>
  );
}
