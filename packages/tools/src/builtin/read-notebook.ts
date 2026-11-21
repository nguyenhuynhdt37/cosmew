import {MAX_ATTACHMENT_BYTES, type Attachment} from '@cosmew/contracts';

/**
 * Jupyter notebooks for `read` (ADR 0041), as Claude Code's Read presents `.ipynb`: every cell with
 * its number and type, its source, and its text outputs; PNG/JPEG outputs become attachments.
 * Notebook JSON is untrusted data: nothing in it is executed or interpreted beyond these fields.
 */
const MAX_IMAGES = 8;

const text = (value: unknown): string =>
  Array.isArray(value)
    ? value.map(v => (typeof v === 'string' ? v : '')).join('')
    : typeof value === 'string'
      ? value
      : '';

export function renderNotebook(
  raw: string,
  path: string,
  /** Structural and secret check of an output image before it is attached (W1.5 security review). */
  acceptImage: (data: string, mime: 'image/png' | 'image/jpeg') => boolean = () => true,
): {ok: true; text: string; attachments: Attachment[]} | {ok: false} {
  let notebook: {cells?: unknown};
  try {
    notebook = JSON.parse(raw) as {cells?: unknown};
  } catch {
    return {ok: false};
  }
  if (!notebook || typeof notebook !== 'object' || !Array.isArray(notebook.cells)) return {ok: false};
  const lines: string[] = [];
  const attachments: Attachment[] = [];
  let attachedBytes = 0;
  notebook.cells.forEach((value, index) => {
    const cell = (value && typeof value === 'object' ? value : {}) as {
      cell_type?: unknown;
      source?: unknown;
      outputs?: unknown;
      execution_count?: unknown;
    };
    const type = typeof cell.cell_type === 'string' ? cell.cell_type : 'unknown';
    const count = typeof cell.execution_count === 'number' ? ` (execution ${cell.execution_count})` : '';
    lines.push(`[${index + 1}] ${type}${count}`);
    lines.push(...text(cell.source).replace(/\n$/, '').split('\n'));
    for (const output of Array.isArray(cell.outputs) ? cell.outputs : []) {
      const out = (output && typeof output === 'object' ? output : {}) as {
        output_type?: unknown;
        text?: unknown;
        data?: Record<string, unknown>;
        ename?: unknown;
        evalue?: unknown;
      };
      if (out.output_type === 'stream') lines.push(...prefixed(text(out.text)));
      else if (out.output_type === 'error')
        lines.push(...prefixed(`${String(out.ename ?? 'Error')}: ${String(out.evalue ?? '')}`));
      else if (out.data && typeof out.data === 'object') {
        const image = (['image/png', 'image/jpeg'] as const).find(mime => typeof out.data![mime] === 'string');
        if (image) {
          const data = text(out.data[image]).replace(/\s+/g, '');
          const bytes = Math.floor((data.length * 3) / 4);
          if (
            attachments.length < MAX_IMAGES &&
            attachedBytes + bytes <= MAX_ATTACHMENT_BYTES &&
            /^[A-Za-z0-9+/]*={0,2}$/.test(data) &&
            acceptImage(data, image)
          ) {
            attachedBytes += bytes;
            attachments.push({mime: image, data, name: `${path}#cell-${index + 1}-output-${attachments.length + 1}`});
            lines.push(`  [output image ${image} attached]`);
          } else lines.push(`  [output image ${image} omitted: attachment limit, invalid image or secret]`);
        } else if (out.data['text/plain'] !== undefined) lines.push(...prefixed(text(out.data['text/plain'])));
      }
    }
    lines.push('');
  });
  return {ok: true, text: lines.join('\n'), attachments};
}

const prefixed = (value: string) =>
  value
    .replace(/\n$/, '')
    .split('\n')
    .map(line => `  ${line}`);
