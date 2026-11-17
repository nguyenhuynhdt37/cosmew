import {createRequire} from 'node:module';
import type {ShellAnalysis, ShellInput} from '@futryn/security';

/**
 * Bash parsing with tree-sitter (ADR 0040), as Codex does (`shell-command/src/bash.rs`, pinned
 * 090be4df, tree-sitter-bash): extract the statically known words of every command node so each
 * sub-command of `a && b | c`, a substitution or a control-flow body is classified on its own.
 *
 * The WASM runtime (`web-tree-sitter`) and grammar (`tree-sitter-bash.wasm`) are loaded once from
 * this package's own dependencies, never from the workspace. If loading fails every command is
 * "unverified" (fail closed): it prompts instead of running silently.
 */

type Node = {
  type: string;
  isNamed: boolean;
  text: string;
  startIndex: number;
  endIndex: number;
  parent: Node | null;
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

/** True once the parser is loaded; analysis before that is null (unverified). */
export function shellParserReady(): boolean {
  return parser !== null;
}

/** Longest script handed to the parser; a longer one is unverified. */
const MAX_SCRIPT_CHARS = 64 * 1024;
/** Redirections inside a command node: their targets do not change which program runs. */
const REDIRECTS = new Set(['file_redirect', 'heredoc_redirect', 'herestring_redirect']);
const DYNAMIC = new Set(['command_substitution', 'process_substitution']);

/**
 * Codex `is_literal_word_or_number`: a word that can still undergo expansion or escape removal is
 * not proof of the runtime argv.
 */
function literalWord(node: Node): string | null {
  if (node.namedChildren.length) return null;
  const word = node.text;
  if (word.startsWith('=') || /[{}*?[\]\\~^#$`]/.test(word)) return null;
  return word;
}

function doubleQuoted(node: Node): string | null {
  if (node.namedChildren.some(part => part?.type !== 'string_content')) return null;
  const raw = node.text;
  if (!raw.startsWith('"') || !raw.endsWith('"') || raw.length < 2) return null;
  const inner = raw.slice(1, -1);
  if (/\\[$`"\\\n]/.test(inner)) return null;
  return inner;
}

/** Codex `parse_literal_shell_word`. */
function literal(node: Node): string | null {
  switch (node.type) {
    case 'word':
    case 'number':
      return literalWord(node);
    case 'string':
      return doubleQuoted(node);
    case 'raw_string':
      return node.text.length >= 2 && node.text.startsWith("'") && node.text.endsWith("'")
        ? node.text.slice(1, -1)
        : null;
    case 'concatenation': {
      let out = '';
      for (const part of node.namedChildren) {
        const text = part ? literal(part) : null;
        if (text === null) return null;
        out += text;
      }
      return out || null;
    }
    default:
      return null;
  }
}

const same = (a: Node, b: Node) => a.startIndex === b.startIndex && a.endIndex === b.endIndex && a.type === b.type;
const INPUT_OPERATORS = new Set(['<', '<&', '<>', '<&-']);

/**
 * Where a command's stdin comes from (W1 security review): a heredoc (literal when its delimiter is
 * quoted or its body has no expansion), a herestring (literal when the word is), an input file
 * redirect, or an earlier command of a pipeline. Redirects on an enclosing statement count for
 * every command inside it, which over-approximates and so fails closed.
 */
function commandInputs(command: Node): ShellInput[] {
  const inputs: ShellInput[] = [];
  const scan = (redirect: Node) => {
    if (redirect.type === 'herestring_redirect') {
      const word = redirect.namedChildren.find(c => c !== null) ?? null;
      const body = word ? literal(word) : null;
      inputs.push({kind: 'herestring', ...(body !== null ? {body} : {})});
    } else if (redirect.type === 'heredoc_redirect') {
      const start = redirect.namedChildren.find(c => c?.type === 'heredoc_start');
      const body = redirect.namedChildren.find(c => c?.type === 'heredoc_body');
      const quoted = !!start && /['"\\]/.test(start.text);
      const text = body ? body.text : '';
      inputs.push({kind: 'heredoc', ...(quoted || (body && !body.namedChildren.length) || !body ? {body: text} : {})});
    } else if (
      redirect.type === 'file_redirect' &&
      redirect.children.some(c => c && !c.isNamed && INPUT_OPERATORS.has(c.type))
    )
      inputs.push({kind: 'file'});
  };
  const scanStatement = (statement: Node | null, body: Node) => {
    if (statement?.type !== 'redirected_statement') return;
    for (const child of statement.namedChildren)
      if (child && !same(child, body) && REDIRECTS.has(child.type)) scan(child);
  };
  for (const child of command.namedChildren) if (child && REDIRECTS.has(child.type)) scan(child);
  let holder: Node = command;
  scanStatement(command.parent, command);
  if (command.parent?.type === 'redirected_statement') holder = command.parent;
  const pipeline = holder.parent;
  if (pipeline?.type === 'pipeline') {
    const first = pipeline.namedChildren.find(c => c !== null);
    if (first && !same(first, holder)) inputs.push({kind: 'pipe'});
    scanStatement(pipeline.parent, pipeline);
  }
  return inputs;
}

/**
 * Analyze one script. Returns null when the parser is not loaded. A parse error yields no
 * commands and `uncertain`, as Codex refuses to read words from an error tree.
 */
export function analyzeShell(script: string): ShellAnalysis | null {
  if (!parser) return null;
  if (script.length > MAX_SCRIPT_CHARS || script.includes('\u0000')) return {commands: [], uncertain: true};
  const tree = parser.parse(script);
  if (!tree) return {commands: [], uncertain: true};
  try {
    const root = tree.rootNode;
    if (root.hasError) return {commands: [], uncertain: true};
    const commands: {start: number; words: string[]; inputs?: ShellInput[]}[] = [];
    let uncertain = false;
    const stack: Node[] = [root];
    while (stack.length) {
      const node = stack.pop()!;
      if (DYNAMIC.has(node.type)) uncertain = true;
      if (node.type === 'command') {
        const words: string[] = [];
        let named = false;
        for (const child of node.namedChildren) {
          if (!child) continue;
          if (child.type === 'command_name') {
            const inner = child.namedChild(0);
            const name = inner ? literal(inner) : null;
            // `$cmd -rf x`, `"$(which rm)"`: the program cannot be known statically.
            if (name === null) {
              uncertain = true;
              break;
            }
            words.push(name);
            named = true;
          } else if (named) {
            const word = literal(child);
            if (word !== null) words.push(word);
            // A word whose runtime value is not its spelling (`$(echo -rf)`, `"$F"`, `-r${X}f`)
            // could be anything, so the command is unverifiable; it is never silently dropped.
            else if (!REDIRECTS.has(child.type)) uncertain = true;
          }
        }
        if (named) {
          const program = words[0]!.split('/').at(-1);
          if (program === 'eval') uncertain = true;
          const inputs = commandInputs(node);
          commands.push({start: node.startIndex, words, ...(inputs.length ? {inputs} : {})});
        }
      }
      for (const child of node.namedChildren) if (child) stack.push(child);
    }
    commands.sort((a, b) => a.start - b.start);
    return {commands: commands.map(c => c.words), inputs: commands.map(c => c.inputs), uncertain};
  } finally {
    tree.delete();
  }
}
