import {createRequire} from 'node:module';
import type {ShellParsers} from '@futryn/security';

/**
 * Bash parsing with tree-sitter, ported from Codex `shell-command/src/bash.rs` (openai/codex
 * 090be4df0724cdef5758e6a0934ba557af8b6bbe, read 2026-11-17). ADR 0040.
 *
 * - `parsePlainCommands` = `try_parse_word_only_commands_sequence`: an allowlist. Only plain words
 *   joined by `&&`, `||`, `;` and `|` parse; anything else (subshells, redirects, heredocs,
 *   expansions, substitutions, assignments, control flow, functions…) makes the whole script
 *   unparsed, and an unparsed script is treated as one opaque command.
 * - `parseLiteralCommands` = `parse_shell_lc_literal_commands`: the statically known words of every
 *   command node of a valid tree. It feeds only the dangerous-command heuristic and must never be
 *   used to prove a command safe.
 *
 * The WASM runtime and grammar load once from this package's own dependencies, never from the
 * workspace. A parser that cannot load parses nothing (callers fail closed).
 */

type Node = {
  type: string;
  isNamed: boolean;
  text: string;
  startIndex: number;
  namedChildren: (Node | null)[];
  children: (Node | null)[];
  namedChild(index: number): Node | null;
  hasError: boolean;
};
type Parser = {parse(source: string): {rootNode: Node; delete(): void} | null};

let parser: Parser | null = null;
let loading: Promise<boolean> | null = null;

/** Load the parser once; resolves false (and stays unavailable) when the WASM cannot be loaded. */
export function ensureShellParser(): Promise<boolean> {
  if (parser) return Promise.resolve(true);
  return (loading ??= (async () => {
    try {
      const require = createRequire(import.meta.url);
      const {Parser, Language} = (await import('web-tree-sitter')) as unknown as {
        Parser: {init(): Promise<void>; new (): Parser & {setLanguage(language: unknown): void}};
        Language: {load(path: string): Promise<unknown>};
      };
      await Parser.init();
      const language = await Language.load(require.resolve('tree-sitter-bash/tree-sitter-bash.wasm'));
      const instance = new Parser();
      instance.setLanguage(language);
      parser = instance;
      return true;
    } catch {
      return false;
    }
  })());
}

/** True once the parser is loaded. */
export function shellParserReady(): boolean {
  return parser !== null;
}

/** Longest script handed to the parser; a longer one is unparsed. */
const MAX_SCRIPT_CHARS = 64 * 1024;

function withTree<T>(script: string, use: (root: Node) => T | null): T | null {
  if (!parser || script.length > MAX_SCRIPT_CHARS) return null;
  const tree = parser.parse(script);
  if (!tree) return null;
  try {
    return use(tree.rootNode);
  } finally {
    tree.delete();
  }
}

/** Codex ALLOWED_KINDS of a word-only command sequence. */
const ALLOWED_KINDS = new Set([
  'program',
  'list',
  'pipeline',
  'command',
  'command_name',
  'word',
  'string',
  'string_content',
  'raw_string',
  'number',
  'concatenation',
]);
/** Codex ALLOWED_PUNCT_TOKENS. */
const ALLOWED_PUNCT_TOKENS = new Set(['&&', '||', ';', '|', '"', "'"]);

/** Codex `is_literal_word_or_number`. */
function isLiteralWordOrNumber(node: Node): boolean {
  if (node.type !== 'word' && node.type !== 'number') return false;
  if (node.namedChildren.length) return false;
  const word = node.text;
  return !word.startsWith('=') && !/[{}*?[\]\\~^#$`]/.test(word);
}

/** Codex `parse_double_quoted_string`. */
function parseDoubleQuoted(node: Node): string | null {
  if (node.type !== 'string') return null;
  if (node.namedChildren.some(part => part?.type !== 'string_content')) return null;
  const raw = node.text;
  if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) return null;
  const stripped = raw.slice(1, -1);
  if (/\\[$`"\\\n]/.test(stripped)) return null;
  return stripped;
}

/** Codex `parse_raw_string`. */
function parseRawString(node: Node): string | null {
  if (node.type !== 'raw_string') return null;
  const raw = node.text;
  return raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'") ? raw.slice(1, -1) : null;
}

/** Codex `parse_plain_command_from_node`. */
function plainCommand(command: Node): string[] | null {
  const words: string[] = [];
  for (const child of command.namedChildren) {
    if (!child) return null;
    switch (child.type) {
      case 'command_name': {
        const word = child.namedChild(0);
        if (!word || word.type !== 'word') return null;
        words.push(word.text);
        break;
      }
      case 'word':
      case 'number':
        words.push(child.text);
        break;
      case 'string': {
        const parsed = parseDoubleQuoted(child);
        if (parsed === null) return null;
        words.push(parsed);
        break;
      }
      case 'raw_string': {
        const parsed = parseRawString(child);
        if (parsed === null) return null;
        words.push(parsed);
        break;
      }
      case 'concatenation': {
        let joined = '';
        for (const part of child.namedChildren) {
          if (!part) return null;
          if (part.type === 'word' || part.type === 'number') joined += part.text;
          else if (part.type === 'string') {
            const parsed = parseDoubleQuoted(part);
            if (parsed === null) return null;
            joined += parsed;
          } else if (part.type === 'raw_string') {
            const parsed = parseRawString(part);
            if (parsed === null) return null;
            joined += parsed;
          } else return null;
        }
        if (!joined) return null;
        words.push(joined);
        break;
      }
      default:
        return null;
    }
  }
  return words;
}

/** Codex `try_parse_word_only_commands_sequence` on a parsed script; null = unparsed. */
export function parsePlainCommands(script: string): string[][] | null {
  return withTree(script, root => {
    if (root.hasError) return null;
    const commands: Node[] = [];
    const stack: Node[] = [root];
    while (stack.length) {
      const node = stack.pop()!;
      if (node.isNamed) {
        if (!ALLOWED_KINDS.has(node.type)) return null;
        if ((node.type === 'word' || node.type === 'number') && !isLiteralWordOrNumber(node)) return null;
        if (node.type === 'command') commands.push(node);
      } else {
        if (/[&;|]/.test(node.type) && !ALLOWED_PUNCT_TOKENS.has(node.type)) return null;
        if (!(ALLOWED_PUNCT_TOKENS.has(node.type) || node.type.trim() === '')) return null;
      }
      for (const child of node.children) if (child) stack.push(child);
    }
    commands.sort((a, b) => a.startIndex - b.startIndex);
    const out: string[][] = [];
    for (const command of commands) {
      const words = plainCommand(command);
      if (!words) return null;
      out.push(words);
    }
    return out;
  });
}

/** Codex `parse_literal_shell_word`. */
function literalWord(node: Node): string | null {
  switch (node.type) {
    case 'word':
    case 'number':
      return isLiteralWordOrNumber(node) ? node.text : null;
    case 'string':
      return parseDoubleQuoted(node);
    case 'raw_string':
      return parseRawString(node);
    case 'concatenation': {
      let joined = '';
      for (const part of node.namedChildren) {
        const text = part ? literalWord(part) : null;
        if (text === null) return null;
        joined += text;
      }
      return joined || null;
    }
    default:
      return null;
  }
}

/** Codex `parse_shell_lc_literal_commands` on a script: literal words of every command node. */
export function parseLiteralCommands(script: string): string[][] | null {
  return withTree(script, root => {
    if (root.hasError) return null;
    const commands: string[][] = [];
    const stack: Node[] = [root];
    while (stack.length) {
      const node = stack.pop()!;
      if (node.type === 'command') {
        // Codex `parse_literal_command_from_node`: dynamic words are omitted.
        const words: string[] = [];
        let named = false;
        let valid = true;
        for (const child of node.namedChildren) {
          if (!child) continue;
          if (child.type === 'command_name') {
            const inner = child.namedChild(0);
            const name = inner ? literalWord(inner) : null;
            if (name === null) {
              valid = false;
              break;
            }
            words.push(name);
            named = true;
          } else if (named) {
            const word = literalWord(child);
            if (word !== null) words.push(word);
          }
        }
        if (valid && named) commands.push(words);
      }
      for (const child of node.namedChildren) if (child) stack.push(child);
    }
    return commands;
  });
}

/** The parsers `@futryn/security` uses for command classification. */
export const shellParsers: ShellParsers = {plain: parsePlainCommands, literal: parseLiteralCommands};
