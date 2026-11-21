import type {PendingQuestion, UserAnswers, UserQuestion} from '@cosmew/contracts';
import type {QuestionAnswerState, QuestionDialogState} from './types';

/** Fresh state for a newly shown request. */
export function stateFor(request: PendingQuestion): QuestionDialogState {
  return {
    questionId: request.questionId,
    tab: 0,
    answers: request.questions.map(() => ({cursor: 0, chosen: [], other: ''})),
  };
}

/** The answers one question would send now (option labels, then the free text). */
export function answersFor(question: UserQuestion, state: QuestionAnswerState): string[] {
  const labels = state.chosen.map(index => question.options[index]?.label).filter((l): l is string => !!l);
  const other = state.other.trim();
  if (!question.multiple) return other && !labels.length ? [other] : labels.slice(0, 1);
  return other ? [...labels, other] : labels;
}

/** Toggle or pick option `index` (single choice replaces the free text). */
export function choose(question: UserQuestion, state: QuestionAnswerState, index: number): QuestionAnswerState {
  if (index < 0 || index >= question.options.length) return state;
  if (question.multiple) {
    const chosen = state.chosen.includes(index) ? state.chosen.filter(i => i !== index) : [...state.chosen, index];
    return {...state, cursor: index, chosen: chosen.sort((a, b) => a - b)};
  }
  return {...state, cursor: index, chosen: [index], other: ''};
}

/** Every question answered: the payload for `answerQuestion`, else the first unanswered tab. */
export function collect(
  request: PendingQuestion,
  dialog: QuestionDialogState,
): {ok: true; answers: UserAnswers} | {ok: false; missing: number} {
  const answers: UserAnswers = {};
  for (const [index, question] of request.questions.entries()) {
    const given = answersFor(question, dialog.answers[index]!);
    if (!given.length) return {ok: false, missing: index};
    answers[question.id] = {answers: given};
  }
  return {ok: true, answers};
}
