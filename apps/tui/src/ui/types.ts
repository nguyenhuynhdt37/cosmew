/** Rendering primitives shared by every feature module. */
export interface StyledSpan {
  text: string;
  fg: string;
  bg?: string;
  bold?: boolean;
  italic?: boolean;
}

export interface RenderedBoxLine {
  spans: StyledSpan[];
  disclosure?: {itemId: string; key: string};
}
