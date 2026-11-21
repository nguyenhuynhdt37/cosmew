/** Per-question selection in the question dialog (ADR 0042). */
export interface QuestionAnswerState {
  /** Row under the cursor; `options.length` is the free-form "Other" row. */
  cursor: number;
  /** Chosen option indexes (one at most unless the question allows several). */
  chosen: number[];
  /** Free text of the "Other" row; chosen when non-empty. */
  other: string;
}

export interface QuestionDialogState {
  questionId: string | null;
  /** Question tab in view. */
  tab: number;
  answers: QuestionAnswerState[];
  error?: string;
}
