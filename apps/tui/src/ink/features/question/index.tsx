/** @jsxImportSource react */
import {useEffect, useState} from 'react';
import type {PendingQuestion} from '@futryn/contracts';
import {useFutrynClient, useTextInput} from '../../hooks';
import {useOverlay} from '../../core';
import {TextLine, ListPicker, KeyHint} from '../../ui';
import {
  Dialog,
  TextEntry,
  useDialogRefresh,
  useDialogSize,
  useDialogTask,
  usePicker,
  type DialogProps,
} from '../picker';
import {stateFor, choose, collect, answersFor} from './logic';
export {stateFor, choose, collect, answersFor} from './logic';
export interface QuestionDialogProps extends DialogProps {
  questionId?: string;
}
export function useQuestion() {
  const client = useFutrynClient();
  useDialogRefresh();
  const router = usePicker();
  return {
    ...router,
    pending: client.listPendingQuestions(),
    openQuestion: (props: QuestionDialogProps = {}) => router.open('question', <QuestionDialog {...props} />),
  };
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
export function QuestionRequestDialog({request, ...props}: DialogProps & {request: PendingQuestion}) {
  const client = useFutrynClient();
  const router = useOverlay();
  const task = useDialogTask();
  const size = useDialogSize(props);
  const [state, setState] = useState(() => stateFor(request));
  const [other, setOther] = useState(false);
  useEffect(
    () => () => {
      if (client.listPendingQuestions().some(q => q.questionId === request.questionId))
        client.dismissQuestion(request.questionId);
    },
    [client, request.questionId],
  );
  const question = request.questions[state.tab]!;
  const answer = state.answers[state.tab]!;
  const update = (next: typeof answer) =>
    setState(s => ({...s, answers: s.answers.map((a, i) => (i === s.tab ? next : a))}));
  const submit = () =>
    void task.run(() => {
      const result = collect(request, state);
      if (!result.ok) {
        setState(s => ({...s, tab: result.missing}));
        task.setMessage('Answer every question, or Esc to dismiss.');
        return;
      }
      client.answerQuestion(request.questionId, result.answers);
      if (!client.listPendingQuestions().length) router.close();
    });
  useTextInput((_input, key) => {
    if (key.eventType === 'release' || key.ctrl || key.meta) return;
    if (!other && (key.tab || key.leftArrow || key.rightArrow))
      setState(s => ({
        ...s,
        tab: (s.tab + (key.shift || key.leftArrow ? request.questions.length - 1 : 1)) % request.questions.length,
      }));
  });
  const items = [
    ...question.options.map((option, i) => ({
      id: String(i),
      label: `${answer.chosen.includes(i) ? '✓ ' : ''}${option.label}`,
      description: option.description,
    })),
    {id: 'other', label: 'Nhập câu trả lời tự do'},
    {id: 'submit', label: 'Submit all answers'},
  ];
  return (
    <Dialog title={`Question · ${question.header}`} {...size} message={task.message}>
      <TextLine>
        {request.questions
          .map(
            (q, i) => `${i === state.tab ? '› ' : ''}${answersFor(q, state.answers[i]!).length ? '✓ ' : ''}${q.header}`,
          )
          .join(' · ')}
      </TextLine>
      <TextLine bold>{question.question}</TextLine>
      {question.multiple ? <TextLine>Multiple choices · Enter toggles an option.</TextLine> : null}
      {answer.other ? <TextLine>{`Free text: ${answer.other}`}</TextLine> : null}
      {other ? (
        <TextEntry
          key={state.tab}
          label="Câu trả lời"
          initialValue={answer.other}
          maxLength={2000}
          onSubmit={value => {
            update({...answer, other: value, chosen: question.multiple ? answer.chosen : []});
            setOther(false);
          }}
        />
      ) : (
        <ListPicker
          key={state.tab}
          items={items}
          visibleRows={size.visibleRows}
          onSelect={item => {
            if (item.id === 'other') setOther(true);
            else if (item.id === 'submit') submit();
            else update(choose(question, answer, Number(item.id)));
          }}
        />
      )}
      <KeyHint keys="Tab / ← →" label="question · Esc dismiss" />
    </Dialog>
  );
}
