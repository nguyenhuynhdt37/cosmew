import type { BorderStyle, ThemeTokens } from '@futryn/contracts';
import { getBorderGlyphs } from '../theme/theme';
import type { RenderedBoxLine, StyledSpan } from './types';

export interface ModalOptions {
  width: number;
  height: number;
  tokens: ThemeTokens;
  borderStyle: BorderStyle;
  /** Lower bound for the inner width; narrow terminals still get a usable box. */
  minInner?: number;
  /** Frame color; defaults to the focused border token. Warning dialogs override it. */
  borderColor?: string;
  /** Title colors; defaults to accent text on the dialog surface. */
  titleStyle?: { fg: string; bg?: string };
}

export interface RowStyle { fg?: string; bg?: string; bold?: boolean }

/**
 * Builder for a bordered dialog: title bar, body rows, filler and footer bar.
 * Every overlay uses it so frame, padding and clipping behave identically.
 */
export class Modal {
  readonly lines: RenderedBoxLine[] = [];
  readonly innerWidth: number;
  readonly height: number;
  readonly tokens: ThemeTokens;
  /** Background of the dialog surface. */
  readonly bg: string;
  private readonly glyphs: ReturnType<typeof getBorderGlyphs>;
  private readonly border: string;
  private readonly titleStyle: { fg: string; bg?: string };

  constructor(options: ModalOptions) {
    this.innerWidth = Math.max(options.minInner ?? 24, options.width - 2);
    this.height = options.height;
    this.tokens = options.tokens;
    this.bg = options.tokens.overlayBackground;
    this.glyphs = getBorderGlyphs(options.borderStyle);
    this.border = options.borderColor ?? options.tokens.borderFocused;
    this.titleStyle = options.titleStyle ?? { fg: options.tokens.accent };
  }

  private edge(): StyledSpan { return { text: this.glyphs.vertical, fg: this.border, bg: this.bg }; }

  /** Title on the left, hint on the right, joined by the horizontal rule. */
  top(title: string, rightMeta = ''): this {
    const { tokens, glyphs, bg, innerWidth, border } = this;
    this.lines.push({ spans: [
      { text: glyphs.topLeft, fg: border, bg },
      { text: title, fg: this.titleStyle.fg, bg: this.titleStyle.bg ?? bg, bold: true },
      { text: glyphs.horizontal.repeat(Math.max(0, innerWidth - title.length - rightMeta.length)), fg: border, bg },
      { text: rightMeta.slice(0, Math.max(0, innerWidth - title.length)), fg: tokens.foregroundMuted, bg },
      { text: glyphs.topRight, fg: border, bg },
    ] });
    return this;
  }

  /** A full-width row from arbitrary spans (caller is responsible for total width). */
  spans(spans: StyledSpan[]): this {
    this.lines.push({ spans: [this.edge(), ...spans, this.edge()] });
    return this;
  }

  /** A single-style row clipped and padded to the inner width. */
  text(text: string, style: RowStyle = {}): this {
    return this.spans([{
      text: text.slice(0, this.innerWidth).padEnd(this.innerWidth, ' '),
      fg: style.fg ?? this.tokens.foreground,
      bg: style.bg ?? this.bg,
      bold: style.bold,
    }]);
  }

  /** Elevated input row (search box, hex field…). */
  input(text: string, bold?: boolean): this {
    return this.text(text, { bg: this.tokens.backgroundElevated, bold });
  }

  blank(): this { return this.text(''); }

  /** Pad with empty rows until only the footer row remains. */
  fill(): this { return this.fillTo(this.height - 1); }

  /** Pad with empty rows until the dialog holds `count` rows (footer excluded). */
  fillTo(count: number): this {
    while (this.lines.length < count) this.blank();
    return this;
  }

  bottom(footer: string): this {
    const { tokens, glyphs, bg, innerWidth, border } = this;
    this.lines.push({ spans: [
      { text: glyphs.bottomLeft, fg: border, bg },
      { text: footer.slice(0, innerWidth), fg: tokens.foregroundSubtle, bg },
      { text: glyphs.horizontal.repeat(Math.max(0, innerWidth - footer.length)), fg: border, bg },
      { text: glyphs.bottomRight, fg: border, bg },
    ] });
    return this;
  }
}
