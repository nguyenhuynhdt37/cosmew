import type { ThemeTokens } from '@futryn/contracts';
import type { RenderedBoxLine } from '../../ui';

export function renderReportOverlay(options: { title: string; rows: string[]; width: number; height: number; offset: number; details?: boolean; footer?: string; tokens: ThemeTokens }): { lines: RenderedBoxLine[]; offset: number } {
  const { title, rows, width, height, tokens } = options;
  const w = Math.max(1, width - 4); const wrapped: string[] = [];
  for (const row of rows) {
    let rest = row;
    while (rest.length > w) {
      const space = rest.lastIndexOf(' ', w); const at = space > w / 2 ? space : w;
      wrapped.push(rest.slice(0, at)); rest = rest.slice(at).trimStart();
    }
    wrapped.push(rest);
  }
  const room = Math.max(1, height - 4); const offset = Math.min(Math.max(0, options.offset), Math.max(0, wrapped.length - room));
  const line = (text: string, fg = tokens.foreground, bold = false): RenderedBoxLine => ({ spans: [{ text: ('  ' + text).slice(0, width).padEnd(width), fg, bg: tokens.overlayBackground, bold }] });
  const body = wrapped.slice(offset, offset + room).map(text => {
    const pair = /^(.{1,16}?) {2,}(.+)$/.exec(text);
    if (pair) return { spans: [
      { text: '  ' + pair[1]!.padEnd(16), fg: tokens.foregroundMuted, bg: tokens.overlayBackground },
      { text: pair[2]!.padEnd(Math.max(0, width - 18)), fg: tokens.foreground, bg: tokens.overlayBackground },
    ] };
    return line(text, /^[A-Z][A-Z &/·-]+$/.test(text) ? tokens.accent : tokens.foreground, /^[A-Z][A-Z &/·-]+$/.test(text));
  });
  const scroll = wrapped.length > room ? (width < 40 ? '↑↓ · ' : '↑↓ Scroll · ') : '';
  const footer = options.footer ?? `${scroll}D ${options.details ? 'Summary' : 'Details'} · Esc${width >= 40 ? ' Close' : ''}`;
  const lines = [line(title, tokens.accent, true), line(''), ...body, line(footer, tokens.foregroundSubtle)].slice(0, height);
  return { lines, offset };
}
