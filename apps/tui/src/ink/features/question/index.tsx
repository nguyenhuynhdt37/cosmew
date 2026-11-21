/** @jsxImportSource react */
import {useEffect, useState} from 'react';
import {Box, Text} from 'ink';
import type {PendingQuestion} from '@cosmew/contracts';
import {useFutrynClient, useKeybindings, useKeymap, useTextInput} from '../../hooks';
import {useOverlay} from '../../core';
import {useTheme} from '../../theme';
import {OptionList, Panel, PanelTabs, Rule, TextLine, safeText, type OptionItem} from '../../ui';
import {Dialog, useDialogRefresh, useDialogSize, useDialogTask, type DialogProps} from '../picker';
import {stateFor, choose, collect, answersFor} from './logic';
export {stateFor, choose, collect, answersFor} from './logic';
export interface QuestionDialogProps extends DialogProps {
  questionId?: string;
}
export function QuestionDialog(props: QuestionDialogProps) {
  const client = useFutrynClient();
  useDialogRefresh();
  const request = client.listPendingQuestions().find(q => !props.questionId || q.questionId === props.questionId);
  return request ? (
    <QuestionRequestDialog key={request.questionId} {...props} request={request} />
  ) : (
    <Dialog title="Question" {...props}>
      <TextLine>No question waiting.</TextLine>
    </Dialog>
  );
}
const SUBMIT = 'Submit';
export function QuestionRequestDialog({request, ...props}: DialogProps & {request: PendingQuestion}) {
  const client = useFutrynClient();
  const router = useOverlay();
  const task = useDialogTask();
  const size = useDialogSize(props);
  const {color} = useTheme();
  const [state, setState] = useState(() => stateFor(request));
  const [cursors, setCursors] = useState<number[]>(() => request.questions.map(() => 0));
  const [review, setReview] = useState(false);
  const several = request.questions.length > 1;
  useEffect(
    () => () => {
      if (client.listPendingQuestions().some(q => q.questionId === request.questionId))
        client.dismissQuestion(request.questionId);
    },
    [client, request.questionId],
  );
  const question = request.questions[state.tab]!;
  const answer = state.answers[state.tab]!;
  const cursor = cursors[state.tab] ?? 0;
  const setCursor = (value: number) => setCursors(all => all.map((c, i) => (i === state.tab ? value : c)));
  const otherRow = question.options.length;
  const doneRow = question.multiple ? otherRow + 1 : -1;
  const rowCount = otherRow + 1 + (question.multiple ? 1 : 0);
  const chatRow = rowCount;
  const update = (next: typeof answer) =>
    setState(s => ({...s, answers: s.answers.map((a, i) => (i === s.tab ? next : a))}));
  const submit = () =>
    void task.run(() => {
      const result = collect(request, state);
      if (!result.ok) {
        setState(s => ({...s, tab: result.missing}));
        setReview(false);
        task.setMessage('Answer every question, or Esc to dismiss.');
        return;
      }
      client.answerQuestion(request.questionId, result.answers);
      if (!client.listPendingQuestions().length) router.close();
    });
  const goTo = (tab: number) => {
    setReview(tab >= request.questions.length);
    setState(s => ({...s, tab: Math.min(tab, request.questions.length - 1)}));
  };
  /** One question answered: the last (or only) one submits, otherwise move on. */
  const advance = (next: typeof answer) => {
    const answers = state.answers.map((a, i) => (i === state.tab ? next : a));
    if (!several) {
      const result = collect(request, {...state, answers});
      if (!result.ok) return;
      void task.run(() => {
        client.answerQuestion(request.questionId, result.answers);
        if (!client.listPendingQuestions().length) router.close();
      });
    } else goTo(state.tab + 1);
  };
  const activate = () => {
    if (review) return;
    if (cursor === chatRow) {
      client.dismissQuestion(request.questionId);
      if (!client.listPendingQuestions().length) router.close();
      return;
    }
    if (cursor === doneRow) return advance(answer);
    if (cursor === otherRow) {
      if (!answer.other.trim()) return;
      const next = {...answer, chosen: question.multiple ? answer.chosen : []};
      update(next);
      return question.multiple ? undefined : advance(next);
    }
    const next = choose(question, answer, cursor);
    update(next);
    if (!question.multiple) advance(next);
  };
  const rows = review ? 2 : chatRow + 1;
  const [reviewCursor, setReviewCursor] = useState(0);
  useKeymap({
    previous: () => (review ? setReviewCursor(c => (c + 1) % 2) : setCursor((cursor + rows - 1) % rows)),
    next: () => (review ? setReviewCursor(c => (c + 1) % 2) : setCursor((cursor + 1) % rows)),
    submit: () => {
      if (!review) return activate();
      if (reviewCursor === 0) submit();
      else {
        client.dismissQuestion(request.questionId);
        if (!client.listPendingQuestions().length) router.close();
      }
    },
  });
  const typing = !review && cursor === otherRow;
  // Tabs: Tab / Shift+Tab always switch question; ←/→ too, unless the free-text row is being typed into.
  const switchTab = (stroke: {key: string}, step: 1 | -1) => {
    if (!several || (typing && (stroke.key === 'left' || stroke.key === 'right'))) return false;
    const count = request.questions.length + 1;
    const at = review ? request.questions.length : state.tab;
    goTo((at + (step < 0 ? count - 1 : 1)) % count);
  };
  useKeybindings({
    Tabs: {'tabs:next': stroke => switchTab(stroke, 1), 'tabs:previous': stroke => switchTab(stroke, -1)},
  });
  useTextInput((input, key) => {
    if (key.eventType === 'release' || key.ctrl || key.meta) return;
    if (
      !typing ||
      key.escape ||
      key.return ||
      key.tab ||
      key.upArrow ||
      key.downArrow ||
      key.leftArrow ||
      key.rightArrow
    )
      return;
    if (key.backspace || key.delete) update({...answer, other: Array.from(answer.other).slice(0, -1).join('')});
    else if (input) update({...answer, other: (answer.other + safeText(input).replace(/\n/g, '')).slice(0, 2000)});
  });
  const muted = color('foregroundMuted');
  const chips = [
    ...request.questions.map((q, i) => `${answersFor(q, state.answers[i]!).length ? '☒' : '☐'} ${q.header}`),
    ...(several ? [`✔ ${SUBMIT}`] : []),
  ];
  const selectedChip = review ? chips[chips.length - 1]! : chips[state.tab]!;
  const optionItems: OptionItem[] = [
    ...question.options.map((option, i) => ({
      id: String(i),
      label: option.label,
      description: option.description,
      prefix: question.multiple ? (answer.chosen.includes(i) ? '[✔] ' : '[ ] ') : undefined,
    })),
    {
      id: 'other',
      label: answer.other ? `${answer.other}${cursor === otherRow ? '▏' : ''}` : 'Type something.',
      muted: !answer.other,
      prefix: question.multiple && answer.other ? '[✔] ' : undefined,
    },
    ...(question.multiple ? [{id: 'done', label: 'Next', numbered: false}] : []),
  ];
  return (
    <Panel width={size.width} ruleStyle="dialog" padding={0} accent={muted}>
      <PanelTabs
        tabs={chips}
        selected={selectedChip}
        onSelect={value => goTo(chips.indexOf(value))}
        isActive={!task.busy}
      />
      <Box height={1} />
      {review ? (
        <>
          <Text bold>Review your answers</Text>
          <Box height={1} />
          {request.questions.map((q, i) => (
            <TextLine
              key={q.id}
            >{`· ${q.question} → ${answersFor(q, state.answers[i]!).join(', ') || '(unanswered)'}`}</TextLine>
          ))}
          <Box height={1} />
          <OptionList
            items={[
              {id: 'submit', label: 'Submit answers'},
              {id: 'cancel', label: 'Cancel'},
            ]}
            cursor={reviewCursor}
            onCursorChange={setReviewCursor}
            isActive={!task.busy}
            width={size.width}
          />
        </>
      ) : (
        <>
          <TextLine bold>{question.question}</TextLine>
          {question.multiple ? <TextLine color={muted}>Select all that apply.</TextLine> : null}
          <Box height={1} />
          <OptionList
            items={optionItems}
            cursor={cursor}
            onCursorChange={setCursor}
            onWheel={direction => setCursor(Math.max(0, Math.min(chatRow, cursor + direction)))}
            isActive={!task.busy}
            width={size.width}
          />
          <Rule glyph="─" color={muted} width={size.width} />
          <OptionList
            items={[{id: 'chat', label: 'Chat about this'}]}
            cursor={cursor - chatRow}
            onCursorChange={() => setCursor(chatRow)}
            onWheel={direction => setCursor(Math.max(0, Math.min(chatRow, cursor + direction)))}
            isActive={!task.busy}
            start={otherRow + 2}
            width={size.width}
          />
        </>
      )}
      {task.message ? <TextLine color={color('warning')}>{task.message}</TextLine> : null}
      <Box height={1} />
      <TextLine color={muted}>
        {several
          ? 'Enter to select · ←/→ to switch questions · ↑/↓ to navigate · Esc to cancel'
          : 'Enter to select · ↑/↓ to navigate · Esc to cancel'}
      </TextLine>
    </Panel>
  );
}
