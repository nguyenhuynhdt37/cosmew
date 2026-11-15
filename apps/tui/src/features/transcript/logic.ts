import type { ThemeTokens } from '@hannes/contracts';
import type { StyledSpan } from '../../ui';

const CODE_KEYWORDS = new Set([
  'import',
  'export',
  'from',
  'const',
  'let',
  'var',
  'function',
  'async',
  'await',
  'return',
  'if',
  'else',
  'for',
  'while',
  'switch',
  'case',
  'break',
  'continue',
  'class',
  'interface',
  'type',
  'true',
  'false',
  'null',
  'undefined',
  'new',
  'try',
  'catch',
  'throw',
  'def',
  'fn',
  'pub',
  'struct',
]);

export function highlightCodeLine(
  line: string,
  tokens: ThemeTokens,
  bg: string,
  syntaxHighlighting = true,
): StyledSpan[] {
  if (!syntaxHighlighting) {
    return [{ text: line, fg: tokens.markdownCode, bg }];
  }
  const trimmed = line.trimStart();
  if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('--')) {
    return [{ text: line, fg: tokens.syntaxComment, bg }];
  }

  const spans: StyledSpan[] = [];
  const tokenRegex = /(".*?"|'.*?'|`.*?`|\b[A-Za-z_][A-Za-z0-9_]*\b(?=\s*\()|\b[A-Za-z_][A-Za-z0-9_]*\b)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = tokenRegex.exec(line)) !== null) {
    if (match.index > lastIndex) {
      spans.push({
        text: line.slice(lastIndex, match.index),
        fg: tokens.foreground,
        bg,
      });
    }
    const word = match[0];
    if (word.startsWith('"') || word.startsWith("'") || word.startsWith('`')) {
      spans.push({ text: word, fg: tokens.syntaxString, bg });
    } else if (CODE_KEYWORDS.has(word)) {
      spans.push({ text: word, fg: tokens.syntaxKeyword, bg, bold: true });
    } else if (line[match.index + word.length] === '(') {
      spans.push({ text: word, fg: tokens.syntaxFunction, bg });
    } else {
      spans.push({ text: word, fg: tokens.foreground, bg });
    }
    lastIndex = match.index + word.length;
  }

  if (lastIndex < line.length) {
    spans.push({ text: line.slice(lastIndex), fg: tokens.foreground, bg });
  }
  return spans.length > 0 ? spans : [{ text: line, fg: tokens.foreground, bg }];
}

export function wrapTextToWidth(text: string, maxWidth: number): string[] {
  const safeMax = Math.max(8, maxWidth);
  const rawLines = text.split('\n');
  const out: string[] = [];

  for (const raw of rawLines) {
    if (raw.length <= safeMax) {
      out.push(raw);
      continue;
    }
    let remaining = raw;
    while (remaining.length > safeMax) {
      let splitAt = remaining.lastIndexOf(' ', safeMax);
      if (splitAt <= Math.floor(safeMax * 0.35)) {
        splitAt = safeMax;
      }
      out.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt).trimStart();
    }
    if (remaining.length > 0) {
      out.push(remaining);
    }
  }
  return out.length > 0 ? out : [''];
}
