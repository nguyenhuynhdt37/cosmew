/** Deliberately small YAML frontmatter subset: scalar strings, booleans, | and > blocks. */
export const SKILL_FILE_BYTES = 65536;
export const SKILL_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
export interface SkillDocument {
  name: string;
  description: string;
  disableModelInvocation: boolean;
  argumentHint?: string;
  body: string;
}
const invalid = (): never => {
  throw new Error('INVALID_SKILL_FRONTMATTER');
};
function scalar(value: string): string | boolean | number | null {
  if (value.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      return typeof parsed === 'string' ? parsed : invalid();
    } catch {
      return invalid();
    }
  }
  if (value.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(value)) return invalid();
    return value.slice(1, -1).replaceAll("''", "'");
  }
  const plain = value.replace(/\s+#.*$/, '').trim();
  if (/^(true|false)$/i.test(plain)) return plain.toLowerCase() === 'true';
  if (/^(null|~)$/i.test(plain)) return null;
  if (/^[+-]?\d+(\.\d+)?$/.test(plain)) return Number(plain);
  if (!plain || plain.startsWith('#') || /^[\[\]{}&*!>|]/.test(plain) || /:\s/.test(plain)) return invalid();
  return plain;
}
export function parseSkillDocument(content: string): SkillDocument {
  if (Buffer.byteLength(content) > SKILL_FILE_BYTES || content.includes('\0')) return invalid();
  const normalized = content.replace(/^\uFEFF/, '').replaceAll('\r\n', '\n');
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized);
  if (!match) return invalid();
  const lines = match[1]!.split('\n'),
    fields = new Map<string, unknown>();
  const keys = new Set(['name', 'description', 'disable-model-invocation', 'argument-hint']);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const entry = /^([a-zA-Z][\w-]*):(?:\s+(.*))?$/.exec(line);
    if (!entry) return invalid();
    const key = entry[1]!,
      value = entry[2]?.trim() ?? '';
    const continuation: string[] = [];
    while (i + 1 < lines.length && (/^\s/.test(lines[i + 1]!) || !lines[i + 1]!.trim())) continuation.push(lines[++i]!);
    // Unknown keys (including allowed-tools) have no semantics and cannot grant anything.
    if (!keys.has(key)) continue;
    if (fields.has(key)) return invalid();
    if (/^[|>][-+]?$/.test(value)) {
      if (!continuation.length) return invalid();
      const indent = Math.min(...continuation.filter(s => s.trim()).map(s => s.length - s.trimStart().length));
      const text = continuation.map(s => s.slice(indent)).join(value[0] === '>' ? ' ' : '\n');
      fields.set(key, value.endsWith('-') ? text.trimEnd() : text.trimEnd() + '\n');
    } else {
      if (continuation.some(s => s.trim())) return invalid();
      fields.set(key, scalar(value));
    }
  }
  const name = fields.get('name'),
    description = fields.get('description'),
    disabled = fields.get('disable-model-invocation'),
    hint = fields.get('argument-hint');
  if (
    typeof name !== 'string' ||
    !SKILL_NAME.test(name) ||
    typeof description !== 'string' ||
    !description.trim() ||
    description.length > 1024 ||
    (disabled !== undefined && typeof disabled !== 'boolean') ||
    (hint !== undefined && typeof hint !== 'string')
  )
    return invalid();
  return {
    name,
    description: description.trim(),
    disableModelInvocation: disabled === true,
    ...(typeof hint === 'string' ? {argumentHint: hint} : {}),
    body: normalized.slice(match[0].length),
  };
}
