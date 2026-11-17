import type {OverlayFeature, ThemeFrame, TuiHost} from '../../core/feature';
import {choose, collect, stateFor} from './logic';
import {createQuestionDialogState, type QuestionDialogState} from './types';
import {renderQuestionOverlay} from './view';

/**
 * `request_user_input` dialog (ADR 0042). Esc dismisses (the model is told and continues);
 * Enter submits once every question has an answer. Answers are text; nothing here grants a
 * permission.
 */
export class QuestionFeature implements OverlayFeature {
  readonly overlays = ['question'] as const;
  private state: QuestionDialogState = createQuestionDialogState();

  constructor(private readonly host: TuiHost) {}

  private request() {
    const pending = this.host.client.listPendingQuestions();
    const current = pending.find(q => q.questionId === this.state.questionId) ?? pending[0];
    if (current && current.questionId !== this.state.questionId) this.state = stateFor(current);
    return current;
  }

  open(): void {
    this.state = createQuestionDialogState();
    this.request();
  }

  layout(_overlay: 'question', cols: number, rows: number) {
    return {width: Math.min(cols - 2, 84), height: Math.min(rows - 2, 22), backdrop: true};
  }

  render(_overlay: 'question', size: {width: number; height: number}, theme: ThemeFrame) {
    return renderQuestionOverlay({
      ...size,
      request: this.request(),
      state: this.state,
      tokens: theme.tokens,
      borderStyle: theme.borderStyle,
    });
  }

  handleKey(_overlay: 'question', key: string): void {
    const {host} = this;
    const request = this.request();
    if (!request) {
      host.closeOverlay();
      return;
    }
    const state = this.state;
    const question = request.questions[state.tab]!;
    const answer = state.answers[state.tab]!;
    const update = (next: typeof answer) => {
      const answers = [...state.answers];
      answers[state.tab] = next;
      this.state = {...state, answers, error: undefined};
    };
    const onOther = answer.cursor === question.options.length;
    if (key === 'Escape') {
      host.client.dismissQuestion(request.questionId);
      host.setBanner('Question dismissed; the model continues without an answer.');
      this.state = createQuestionDialogState();
      if (!host.client.listPendingQuestions().length) host.closeOverlay();
      return;
    }
    if (key === 'ArrowLeft' || key === 'ArrowRight' || key === 'Tab' || key === 'Shift+Tab') {
      const step = key === 'ArrowLeft' || key === 'Shift+Tab' ? -1 : 1;
      const count = request.questions.length;
      this.state = {...state, tab: (state.tab + step + count) % count, error: undefined};
      return;
    }
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      const rows = question.options.length + 1;
      update({...answer, cursor: (answer.cursor + (key === 'ArrowDown' ? 1 : -1) + rows) % rows});
      return;
    }
    if (key === 'Enter') {
      // A single-choice question with the cursor on an option picks it before submitting.
      if (!question.multiple && !onOther && !answer.chosen.length) update(choose(question, answer, answer.cursor));
      const collected = collect(request, this.state);
      if (!collected.ok) {
        this.state = {...this.state, tab: collected.missing, error: 'Answer every question, or press Esc to dismiss.'};
        return;
      }
      try {
        host.client.answerQuestion(request.questionId, collected.answers);
      } catch {
        this.state = {...this.state, error: 'This question is no longer waiting.'};
        return;
      }
      this.state = createQuestionDialogState();
      if (!host.client.listPendingQuestions().length) host.closeOverlay();
      return;
    }
    if (onOther) {
      if (key === 'Backspace') update({...answer, other: answer.other.slice(0, -1)});
      else if (key === 'Space') update({...answer, other: answer.other + ' '});
      else if ([...key].length === 1 && answer.other.length < 2000)
        update({
          ...answer,
          other: answer.other + key,
          // Single choice: typed text replaces the chosen option.
          chosen: question.multiple ? answer.chosen : [],
        });
      return;
    }
    if (key === 'Space') {
      update(choose(question, answer, answer.cursor));
      return;
    }
    if (/^[1-9]$/.test(key)) {
      const index = Number(key) - 1;
      if (index === question.options.length) update({...answer, cursor: index});
      else update(choose(question, answer, index));
    }
  }
}
