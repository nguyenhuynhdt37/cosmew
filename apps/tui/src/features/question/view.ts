import type {BorderStyle, PendingQuestion, ThemeTokens} from '@futryn/contracts';
import {Modal, type RenderedBoxLine} from '../../ui';
import type {QuestionDialogState} from './types';

/** The question dialog: one tab per question header, options with descriptions, "Other" text row. */
export function renderQuestionOverlay(options: {
  width: number;
  height: number;
  request: PendingQuestion | undefined;
  state: QuestionDialogState;
  tokens: ThemeTokens;
  borderStyle: BorderStyle;
}): RenderedBoxLine[] {
  const {width, height, request, state, tokens, borderStyle} = options;
  const modal = new Modal({width, height, minInner: 1, tokens, borderStyle});
  modal.top(' Question ');
  if (!request) {
    modal.text(' No question is waiting.', {fg: tokens.foregroundMuted});
    return modal.fill().bottom(' Esc close ').lines;
  }
  const tabs = request.questions
    .map((q, i) => {
      const answered = (state.answers[i]?.chosen.length ?? 0) > 0 || !!state.answers[i]?.other.trim();
      return `${i === state.tab ? '[' : ' '}${answered ? '✓ ' : ''}${q.header}${i === state.tab ? ']' : ' '}`;
    })
    .join(' ');
  if (request.questions.length > 1) modal.text(' ' + tabs, {fg: tokens.foregroundMuted});
  const question = request.questions[state.tab]!;
  const answer = state.answers[state.tab]!;
  const wrapWidth = Math.max(1, modal.innerWidth - 2);
  for (let i = 0; i < question.question.length; i += wrapWidth)
    modal.text(' ' + question.question.slice(i, i + wrapWidth), {bold: true});
  if (question.multiple) modal.text(' Choose any (Space toggles).', {fg: tokens.foregroundSubtle});
  modal.blank();
  question.options.forEach((option, index) => {
    const selected = answer.chosen.includes(index);
    const mark = question.multiple ? (selected ? '[x]' : '[ ]') : selected ? '(•)' : '( )';
    const cursor = answer.cursor === index ? '›' : ' ';
    modal.text(`${cursor} ${index + 1}. ${mark} ${option.label}`, {
      fg: answer.cursor === index ? tokens.accent : tokens.foreground,
      bold: answer.cursor === index,
    });
    if (option.description) modal.text(`        ${option.description}`, {fg: tokens.foregroundSubtle});
  });
  const otherIndex = question.options.length;
  const onOther = answer.cursor === otherIndex;
  modal.text(`${onOther ? '›' : ' '} ${otherIndex + 1}. Other: ${answer.other}${onOther ? '▏' : ''}`, {
    fg: onOther ? tokens.accent : tokens.foreground,
    bold: onOther,
  });
  if (state.error) modal.text(' ' + state.error, {fg: tokens.warning});
  return modal
    .fill()
    .bottom(' ↑↓ move · 1-9 pick · Space toggle · ←→ question · type for Other · Enter submit · Esc dismiss ').lines;
}
