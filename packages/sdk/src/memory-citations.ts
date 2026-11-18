import {memoryNameSchema} from '@futryn/contracts';

const OPEN = '<oai-mem-citation>',
  CLOSE = '</oai-mem-citation>';
/** Display-only parser. Preserve code examples; never turn arbitrary paths or the index into citations. */
export function parseMemoryCitations(text: string, streaming = false): {content: string; files: string[]} {
  const files = new Set<string>();
  const kept: string[] = [];
  let fence: {char: string; length: number} | undefined;
  let citation: string[] | undefined;
  for (const line of text.split('\n')) {
    if (citation) {
      citation.push(line);
      if (line.includes(CLOSE)) {
        collect(citation.join('\n'));
        citation = undefined;
      }
      continue;
    }
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (marker) {
      if (!fence) fence = {char: marker[1]![0]!, length: marker[1]!.length};
      else if (marker[1]![0] === fence.char && marker[1]!.length >= fence.length && !marker[2]!.trim())
        fence = undefined;
      kept.push(line);
      continue;
    }
    if (!fence && line.trimStart().startsWith(OPEN)) {
      citation = [line];
      if (line.includes(CLOSE)) {
        collect(line);
        citation = undefined;
      }
      continue;
    }
    if (!fence && streaming && line.trim() && OPEN.startsWith(line.trim())) continue;
    kept.push(line);
  }
  return {content: kept.join('\n').trimEnd(), files: [...files]};
  function collect(block: string): void {
    const entries = /<citation_entries>([\s\S]*?)<\/citation_entries>/.exec(block)?.[1];
    if (!entries) return;
    for (const raw of entries.split('\n')) {
      const match = /^([a-z0-9-]+)\.md(?::([1-9]\d*)-([1-9]\d*)\|note=\[[^\r\n]*\])?$/.exec(raw.trim());
      if (!match || !memoryNameSchema.safeParse(match[1]).success) continue;
      if (match[2] && (!Number.isSafeInteger(Number(match[3])) || Number(match[2]) > Number(match[3]))) continue;
      files.add(`${match[1]}.md`);
    }
  }
}
