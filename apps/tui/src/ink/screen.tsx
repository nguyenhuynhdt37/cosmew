/** @jsxImportSource react */
import {useCallback, useLayoutEffect, useRef, useState, type ReactNode} from 'react';
import {Box, Text, measureElement, type DOMElement} from 'ink';
import {useTerminalSize} from './hooks/use-terminal-size';
import {useUiTheme} from './ui/ui-theme';

/** Terminal rows of the output stream; the fullscreen layout is used only when it is a positive number. */
export function useLiveRows(override?: number): number | undefined {
  const terminal = useTerminalSize();
  const rows = terminal.rows || override;
  return rows && Number.isFinite(rows) && rows > 0 ? Math.floor(rows) : undefined;
}

export interface Scrollback {
  /** Rows scrolled up from the bottom; 0 = following new output. */
  back: number;
  maxBack: number;
  atBottom: boolean;
  /** Rows of the viewport; existing PgUp/PgDn move half a viewport. */
  viewRows: number;
  pageUp(): void;
  halfPageUp(): void;
  halfPageDown(): void;
  /** Scroll to the very top / put the given content row at the top of the viewport. */
  toTop(): void;
  showRow(row: number): void;
  /** Content row currently at the top of the viewport. */
  topRow: number;
  pageDown(): void;
  /** One or more rows toward the top (positive) or the bottom (negative). */
  scrollBy(rows: number): void;
  toBottom(): void;
  viewport: React.RefObject<DOMElement | null>;
  content: React.RefObject<DOMElement | null>;
}
/**
 * Scroll position of the fullscreen viewport. The content is bottom-anchored by flexbox, so following the end needs
 * no measurement; only paging back and holding the position while output grows read the measured heights.
 */
export function useScrollback(onReachTop?: () => void): Scrollback {
  const viewport = useRef<DOMElement>(null);
  const content = useRef<DOMElement>(null);
  const [back, setBack] = useState(0);
  const [size, setSize] = useState({view: 0, content: 0});
  const previous = useRef(0);
  useLayoutEffect(() => {
    if (!viewport.current || !content.current) return;
    const view = measureElement(viewport.current).height;
    const height = measureElement(content.current).height;
    const grew = height - previous.current;
    previous.current = height;
    const max = Math.max(0, height - view);
    // New output never moves a reader who scrolled away from the bottom.
    setBack(current => {
      if (current <= 0) return 0;
      return Math.min(max, current + Math.max(0, grew));
    });
    setSize(old => (old.view === view && old.content === height ? old : {view, content: height}));
  });
  const maxBack = Math.max(0, size.content - size.view);
  const page = Math.max(1, Math.floor(size.view / 2));
  const pageUp = useCallback(() => {
    setBack(current => Math.min(maxBack, current + page));
    if (back + page >= maxBack) onReachTop?.();
  }, [maxBack, page, back, onReachTop]);
  const pageDown = useCallback(() => setBack(current => Math.max(0, current - page)), [page]);
  const scrollBy = useCallback(
    (rows: number) => setBack(current => Math.max(0, Math.min(maxBack, current + rows))),
    [maxBack],
  );
  const halfPageUp = useCallback(() => scrollBy(Math.max(1, Math.floor(size.view / 2))), [scrollBy, size.view]);
  const halfPageDown = useCallback(() => scrollBy(-Math.max(1, Math.floor(size.view / 2))), [scrollBy, size.view]);
  const toBottom = useCallback(() => setBack(0), []);
  const toTop = useCallback(() => setBack(maxBack), [maxBack]);
  const showRow = useCallback(
    (row: number) => setBack(Math.max(0, Math.min(maxBack, size.content - size.view - Math.max(0, row)))),
    [maxBack, size.content, size.view],
  );
  return {
    back: Math.min(back, maxBack),
    maxBack,
    atBottom: back <= 0,
    viewRows: size.view,
    pageUp,
    halfPageUp,
    halfPageDown,
    toTop,
    showRow,
    topRow: Math.max(0, size.content - size.view - Math.min(back, maxBack)),
    pageDown,
    scrollBy,
    toBottom,
    viewport,
    content,
  };
}

/**
 * The scrolling middle of the fullscreen screen: content sticks to the top while it fits and to the bottom when it
 * overflows (the filler absorbs spare room), and the head is clipped. Scrolling shifts the content down.
 */
export function ScrollViewport({scroll, children}: {scroll: Scrollback; children: ReactNode}) {
  const ui = useUiTheme();
  return (
    <Box flexGrow={1} flexShrink={1} minHeight={1} flexDirection="column" overflow="hidden">
      <Box
        ref={scroll.viewport}
        flexGrow={1}
        flexShrink={1}
        minHeight={0}
        overflow="hidden"
        flexDirection="column"
        justifyContent="flex-end"
        contentOffsetY={-scroll.back}
      >
        <Box ref={scroll.content} flexDirection="column" flexShrink={0}>
          {children}
        </Box>
        <Box flexGrow={1} flexShrink={1} />
      </Box>
      {scroll.atBottom ? null : (
        <Box position="absolute" bottom={0} left={0} width="100%" justifyContent="center">
          <Text inverse color={ui.color('dim')}>
            {' Jump to bottom · fn+↓ to scroll '}
          </Text>
        </Box>
      )}
    </Box>
  );
}
