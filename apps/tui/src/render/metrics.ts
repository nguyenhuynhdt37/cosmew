/** Horizontal split of the terminal between the chat column and the optional sidebar. */
export interface ScreenMetrics {
  cols: number;
  rows: number;
  showSidebar: boolean;
  sidebarWidth: number;
  /** Width of the area left of the sidebar. */
  mainWidth: number;
  /** Width and left edge of the centered content column (wallpaper stays outside it). */
  colWidth: number;
  colLeft: number;
}

const SIDEBAR_MIN_COLS = 100;
const SIDEBAR_WIDTH = 30;

export function screenMetrics(cols: number, rows: number, sidebarEnabled: boolean): ScreenMetrics {
  const showSidebar = cols >= SIDEBAR_MIN_COLS && sidebarEnabled;
  const sidebarWidth = showSidebar ? SIDEBAR_WIDTH : 0;
  const mainWidth = Math.max(20, cols - sidebarWidth);
  // Use the full main width, leaving one cell at each edge when wide enough so borders do not touch the terminal.
  const colWidth = mainWidth >= 40 ? mainWidth - 2 : mainWidth;
  const colLeft = mainWidth >= 40 ? 1 : 0;
  return {cols, rows, showSidebar, sidebarWidth, mainWidth, colWidth, colLeft};
}
