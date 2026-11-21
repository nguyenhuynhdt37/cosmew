import {safeText, stringCells} from '../../ui/text-line';

export interface DetailedFooterInput {
  width: number;
  toggleKey: string;
  showAllKey?: string;
  editorKey?: string;
  helpKey?: string;
  editorName?: string;
  showingAll?: boolean;
  searchActive?: boolean;
  /** Activity prefix, distinct from the transient right-hand status in B2. */
  status?: 'dialog waiting' | 'working';
  badge?: string;
  rightStatus?: string;
  virtualScroll?: boolean;
  suppressShowAll?: boolean;
  nextMatchKey?: string;
  previousMatchKey?: string;
  scrollKeys?: string;
}

const singleLine = (text: string) => safeText(text).replace(/[\r\n]/g, ' ');
function truncate(text: string, width: number): string {
  if (stringCells(text) <= width) return text;
  if (width < 1) return '';
  let clipped = '';
  for (const char of text) {
    if (stringCells(clipped + char) > width - 1) break;
    clipped += char;
  }
  return clipped + '…';
}

/** B2 (Claude Code 2.1.330): reserve two indent cells and the badge, then truncate the left. */
export function composeDetailedFooter(input: DetailedFooterInput): {left: string; right: string} {
  const {
    width,
    status,
    showingAll = false,
    searchActive = false,
    virtualScroll = true,
    suppressShowAll = false,
  } = input;
  const label = (value: string | undefined, fallback: string) => singleLine(value ?? fallback);
  const prefix = [status, 'Showing detailed transcript', `${label(input.toggleKey, 'ctrl+o')} to toggle`]
    .filter(Boolean)
    .join(' · ');
  const open = `${label(input.editorKey, 'v')} to open in ${label(input.editorName, 'editor')}`;
  const help = `${label(input.helpKey, '?')} for shortcuts`;
  const full = `${label(input.scrollKeys, '↑/↓')} to scroll · ${open} · ${help}`;
  const verbose = status ? '' : 'verbose ';
  const rightStatus = input.rightStatus ? singleLine(input.rightStatus) + ' ' : '';
  const right = rightStatus || (input.badge ? singleLine(input.badge) + ' ' : verbose);
  // Upstream's strict fit test uses the independent status or verbose, not the search badge.
  const fits = 2 + stringCells(`${prefix} · ${full}`) + stringCells(rightStatus || verbose) < width;
  const variant = searchActive
    ? `${label(input.nextMatchKey, 'n')}/${label(input.previousMatchKey, 'N')} to navigate`
    : virtualScroll
      ? fits
        ? full
        : help
      : suppressShowAll
        ? open
        : `${label(input.showAllKey, 'ctrl+e')} to ${showingAll ? 'collapse' : 'show all'}`;
  const available = Math.max(0, Math.floor(width) - 2);
  let clippedRight = truncate(right, available);
  // The terminal-edge trailing badge space is expendable when the left is truncated (40-column capture).
  if (stringCells(`${prefix} · ${variant}`) + stringCells(clippedRight) > available)
    clippedRight = clippedRight.trimEnd();
  return {
    left: truncate(`${prefix} · ${variant}`, available - stringCells(clippedRight)),
    right: clippedRight,
  };
}
