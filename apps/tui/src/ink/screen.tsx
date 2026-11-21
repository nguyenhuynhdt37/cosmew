/** @jsxImportSource react */
import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
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
export function useScrollback(): Scrollback {
  const viewport = useRef<DOMElement>(null);
  const content = useRef<DOMElement>(null);
  const [back, setBack] = useState(0);
  const [size, setSize] = useState({view: 0, content: 0});
  const previous = useRef(size);
  useLayoutEffect(() => {
    if (!viewport.current || !content.current) return;
    const view = measureElement(viewport.current).height;
    const height = measureElement(content.current).height;
    if (previous.current.view === view && previous.current.content === height) return;
    const grew = height - previous.current.content;
    previous.current = {view, content: height};
    const max = Math.max(0, height - view);
    // New output never moves a reader who scrolled away from the bottom.
    setBack(current => {
      if (current <= 0) return 0;
      return Math.min(max, current + Math.max(0, grew));
    });
    setSize(previous.current);
  });
  const maxBack = Math.max(0, size.content - size.view);
  const page = Math.max(1, Math.floor(size.view / 2));
  const pageUp = useCallback(() => {
    setBack(current => Math.min(maxBack, current + page));
  }, [maxBack, page]);
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

/** Only descendants that window their own rows subscribe to scroll coordinates. */
const ScrollCoordinates = createContext<Pick<Scrollback, 'topRow' | 'viewRows' | 'content'> | null>(null);

/** Row of a measured descendant within the scroll content box. */
export function rowWithin(element: DOMElement, root: DOMElement): number {
  let top = 0;
  for (let node: DOMElement | undefined = element; node && node !== root; node = node.parentNode)
    top += node.yogaNode?.getComputedTop() ?? 0;
  return top;
}

/** Reserve the height of prewrapped rows while rendering only those near the main viewport. */
export function WindowedRows({count, children}: {count: number; children(start: number, end: number): ReactNode}) {
  const scroll = useContext(ScrollCoordinates);
  const ref = useRef<DOMElement>(null);
  const [top, setTop] = useState(0);
  useLayoutEffect(() => {
    if (ref.current && scroll?.content.current) {
      const actual = rowWithin(ref.current, scroll.content.current);
      if (actual !== top) setTop(actual);
    }
  });
  const first = scroll ? Math.max(0, Math.min(count, scroll.topRow - top - 4)) : 0;
  const end = scroll ? Math.max(first, Math.min(count, scroll.topRow + scroll.viewRows - top + 4)) : count;
  return (
    <Box ref={ref} flexDirection="column" minWidth={0}>
      {first > 0 ? <Box height={first} flexShrink={0} /> : null}
      {end > first ? children(first, end) : null}
      {end < count ? <Box height={count - end} flexShrink={0} /> : null}
    </Box>
  );
}

/**
 * The scrolling middle of the fullscreen screen: content sticks to the top while it fits and to the bottom when it
 * overflows (the filler absorbs spare room), and the head is clipped. Scrolling shifts the content down.
 */
export function ScrollViewport({scroll, children}: {scroll: Scrollback; children: ReactNode}) {
  const ui = useUiTheme();
  const {topRow, viewRows, content} = scroll;
  const coordinates = useMemo(() => ({topRow, viewRows, content}), [topRow, viewRows, content]);
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
          <ScrollCoordinates.Provider value={coordinates}>{children}</ScrollCoordinates.Provider>
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
