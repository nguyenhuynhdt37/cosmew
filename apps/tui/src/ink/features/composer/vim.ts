import {graphemes, textWidth} from '../../../input/text';
import {replaceRange, type PasteState} from '../paste';
import {spanText, visualRows} from './logic';

type Mode = 'INSERT' | 'NORMAL' | 'VISUAL' | 'VISUAL LINE';
type Effect = 'submit' | 'help' | 'history' | 'older' | 'newer' | 'undo' | 'redo';
type Operator = 'd' | 'c' | 'y';
type Register = {text: string; linewise: boolean};
type Find = {key: string; char: string};
type Command = (state: VimState, draft: PasteState, count: number, width: number) => VimResult;
type Repeat = {command: Command; count: number; insert?: InsertEdit};
type InsertEdit = {left: number; right: number; text: string};
type Pending =
  | {kind: 'operator'; op: Operator; count: number; typed: boolean}
  | {kind: 'object' | 'find' | 'g'; key: string; op?: Operator; count: number}
  | {kind: 'replace' | 'indent'; key: string; count: number};

export interface VimState {
  mode: Mode;
  count: number;
  pending?: Pending;
  anchor?: number;
  column?: number;
  register?: Register;
  find?: Find;
  repeat?: Repeat;
  insert?: {base: PasteState; repeat?: Repeat};
}

interface VimResult {
  state: VimState;
  draft: PasteState;
  effect?: Effect;
}

export const createVimState = (): VimState => ({mode: 'INSERT', count: 0});
const isVisual = (state: VimState) => state.mode === 'VISUAL' || state.mode === 'VISUAL LINE';
const idle = (state: VimState): VimState => ({...state, count: 0, pending: undefined});
const move = (draft: PasteState, cursor: number): PasteState => ({...draft, cursor, selectionAnchor: undefined});
const cap = (count: number) => Math.min(count, 10_000);

function cells(draft: PasteState) {
  const {value, pastes} = draft;
  const result: {index: number; segment: string}[] = [];
  let from = 0;
  for (const paste of pastes) {
    for (const {index, segment} of graphemes(value.slice(from, paste.start)))
      result.push({index: from + index, segment});
    result.push({index: paste.start, segment: value.slice(paste.start, paste.end)});
    from = paste.end;
  }
  for (const g of graphemes(value.slice(from))) result.push({index: from + g.index, segment: g.segment});
  return result;
}

const lineStart = (value: string, at: number) => (at === 0 ? 0 : value.lastIndexOf('\n', at - 1) + 1);
const lineEnd = (value: string, at: number) => {
  const end = value.indexOf('\n', at);
  return end < 0 ? value.length : end;
};
const firstNonblank = (value: string, at: number) => {
  const start = lineStart(value, at);
  return start + (value.slice(start, lineEnd(value, at)).match(/^[ \t]*/)?.[0].length ?? 0);
};

function buffer(draft: PasteState) {
  const chars = cells(draft);
  const {value} = draft;
  const offsets = [...chars.map(g => g.index), value.length];
  const indexAt = (at: number) => {
    let left = 0;
    let right = offsets.length - 1;
    while (left < right) {
      const mid = Math.ceil((left + right) / 2);
      if (offsets[mid]! <= at) left = mid;
      else right = mid - 1;
    }
    return left;
  };
  const offsetAt = (index: number) => offsets[Math.max(0, Math.min(index, chars.length))]!;
  const step = (at: number, n: number) => offsetAt(indexAt(at) + n);
  const normal = (at: number) => {
    const start = lineStart(value, at);
    return at > start && at === lineEnd(value, at) ? step(at, -1) : offsetAt(indexAt(at));
  };
  return {chars, indexAt, offsetAt, step, normal};
}
type Buffer = ReturnType<typeof buffer>;

function updated(state: VimState, draft: PasteState): VimResult {
  const buf = buffer(draft);
  if (state.mode === 'INSERT') {
    // An edit can merge neighboring graphemes (for example, a ZWJ or combining mark).
    const index = buf.indexAt(draft.cursor);
    const boundary = buf.offsetAt(index);
    return {state, draft: move(draft, boundary === draft.cursor ? boundary : buf.offsetAt(index + 1))};
  }
  const cursor = buf.normal(draft.cursor);
  if (!isVisual(state)) return {state, draft: move(draft, cursor)};
  const anchor = buf.normal(state.anchor ?? cursor);
  const from = Math.min(anchor, cursor);
  const linewise = state.mode === 'VISUAL LINE';
  return {
    state: {...state, anchor},
    draft: {
      ...draft,
      // The caret is kept at the active character. The view uses vimSelection for the inclusive range.
      cursor,
      selectionAnchor: linewise ? lineStart(draft.value, from) : from,
    },
  };
}

export function vimSelection(state: VimState, draft: PasteState): [number, number] | undefined {
  if (!isVisual(state)) return undefined;
  const anchor = state.anchor ?? draft.cursor;
  const from = Math.min(anchor, draft.cursor);
  const to = Math.max(anchor, draft.cursor);
  return state.mode === 'VISUAL LINE'
    ? [lineStart(draft.value, from), lineEnd(draft.value, to)]
    : [from, buffer(draft).step(to, 1)];
}

const wordClass = (text: string, big: boolean) =>
  /^\s+$/u.test(text) ? 0 : big || /^[\p{L}\p{N}\p{M}_]/u.test(text) ? 1 : 2;

function word(buf: Buffer, at: number, key: string, count: number) {
  const kind = key.toLowerCase();
  const classify = (index: number) => wordClass(buf.chars[index]!.segment, key !== kind);
  let i = buf.indexAt(at);
  for (let n = 0; n < count; n++) {
    if (kind === 'b') {
      if (i === 0) break;
      i--;
      while (i > 0 && classify(i) === 0) i--;
      while (i > 0 && classify(i - 1) === classify(i)) i--;
    } else if (kind === 'w') {
      if (i >= buf.chars.length) break;
      const start = classify(i);
      while (i < buf.chars.length && classify(i) === start) i++;
      while (i < buf.chars.length && classify(i) === 0) i++;
    } else {
      if (i + 1 >= buf.chars.length) break;
      i++;
      while (i + 1 < buf.chars.length && classify(i) === 0) i++;
      while (i + 1 < buf.chars.length && classify(i + 1) === classify(i)) i++;
    }
  }
  return buf.offsetAt(i);
}

const PAIRS: Readonly<Record<string, string>> = {'(': ')', '[': ']', '{': '}', '<': '>'};
const OBJECTS: Readonly<Record<string, string>> = {b: '(', B: '{', ')': '(', ']': '[', '}': '{', '>': '<'};
const isObject = (key: string) => ['w', 'W', '"', "'", '`'].includes(key) || key in PAIRS || key in OBJECTS;

function motion(draft: PasteState, buf: Buffer, key: string, count: number, column: number | undefined, width: number) {
  const {value, cursor} = draft;
  const start = lineStart(value, cursor);
  const end = lineEnd(value, cursor);
  switch (key) {
    case '0':
      return start;
    case '^':
      return firstNonblank(value, cursor);
    case '$': {
      let at = end;
      for (let n = 1; n < count && at < value.length; n++) at = lineEnd(value, at + 1);
      return at;
    }
    case 'h':
      return Math.max(start, buf.step(cursor, -count));
    case 'l':
      return Math.min(end, buf.step(cursor, count));
    case ' ':
      return buf.step(cursor, count);
    case 'backspace':
      return buf.step(cursor, -count);
    case 'w':
    case 'W':
    case 'b':
    case 'B':
    case 'e':
    case 'E':
      return word(buf, cursor, key, count);
    case 'gg':
    case 'G': {
      if (key === 'G' && !count) return value.lastIndexOf('\n') + 1;
      let at = 0;
      for (let n = 1; n < count; n++) {
        const end = lineEnd(value, at);
        if (end === value.length) break;
        at = end + 1;
      }
      return at;
    }
    case 'j':
    case 'k':
    case 'gj':
    case 'gk': {
      const down = key.endsWith('j');
      const rows = key.length === 2 ? visualRows(value, width) : visualRows(value, Infinity);
      const row = rows.findLastIndex(r => r.start <= cursor);
      const target = rows[Math.max(0, Math.min(rows.length - 1, row + (down ? count : -count)))];
      if (!target || target === rows[row]) return cursor;
      const goal = column ?? textWidth(value.slice(rows[row]!.start, cursor));
      let at = target.start;
      let used = 0;
      for (const {segment} of graphemes(target.text)) {
        used += textWidth(segment);
        if (used > goal) break;
        at += segment.length;
      }
      if (at === target.start + target.text.length && at > target.start) at = buf.step(at, -1);
      return at;
    }
    case '%': {
      const i = buf.indexAt(cursor);
      const char = buf.chars[i]?.segment ?? '';
      const open = PAIRS[char] ? char : OBJECTS[char];
      const close = open && PAIRS[open];
      if (!open || !close) return cursor;
      const direction = char === open ? 1 : -1;
      let depth = 0;
      for (let j = i; j >= 0 && j < buf.chars.length; j += direction) {
        const current = buf.chars[j]?.segment;
        if (current === char) depth++;
        else if (current === (direction > 0 ? close : open) && --depth === 0) return buf.offsetAt(j);
      }
      return cursor;
    }
    default:
      return cursor;
  }
}
const MOTIONS = new Set([
  'h',
  'j',
  'k',
  'l',
  'w',
  'b',
  'e',
  'W',
  'B',
  'E',
  '0',
  '^',
  '$',
  'gg',
  'G',
  'gj',
  'gk',
  '%',
  ' ',
  'backspace',
]);
const isVertical = (key: string) => ['j', 'k', 'gj', 'gk'].includes(key);

function findChar(draft: PasteState, buf: Buffer, find: Find, count: number, repeated = false) {
  const backwards = find.key === find.key.toUpperCase();
  const till = find.key.toLowerCase() === 't';
  const direction = backwards ? -1 : 1;
  const start = buf.indexAt(draft.cursor);
  let i = start + direction * (repeated && till ? 2 : 1);
  for (; i >= 0 && i < buf.chars.length; i += direction) {
    const char = buf.chars[i]!.segment;
    if (char === '\n') break;
    if (char === find.char && --count === 0) return buf.offsetAt(i - (till ? direction : 0));
  }
  return undefined;
}

function objectSpan(
  draft: PasteState,
  buf: Buffer,
  key: string,
  around: boolean,
  count: number,
): [number, number] | undefined {
  const i = buf.indexAt(draft.cursor);
  const {chars, offsetAt} = buf;
  if (key === 'w' || key === 'W') {
    if (!chars[i]) return;
    const classify = (at: number) => wordClass(chars[at]!.segment, key === 'W');
    let start = i;
    let end = i + 1;
    while (start > 0 && chars[start - 1]?.segment !== '\n' && classify(start - 1) === classify(i)) start--;
    while (end < chars.length && chars[end]?.segment !== '\n' && classify(end) === classify(i)) end++;
    for (let n = 1; n < count && end < chars.length; n++) {
      while (end < chars.length && classify(end) === 0) end++;
      if (end === chars.length) break;
      const next = classify(end++);
      while (end < chars.length && classify(end) === next) end++;
    }
    if (around) {
      const before = end;
      while (end < chars.length && chars[end]?.segment !== '\n' && classify(end) === 0) end++;
      if (before === end) while (start > 0 && chars[start - 1]?.segment !== '\n' && classify(start - 1) === 0) start--;
      if (classify(i) === 0) {
        if (end < chars.length && chars[end]?.segment !== '\n') {
          const next = classify(end++);
          while (end < chars.length && classify(end) === next) end++;
        }
      }
    }
    return [offsetAt(start), offsetAt(end)];
  }
  const open = OBJECTS[key] ?? key;
  const close = PAIRS[open];
  const matches: [number, number][] = [];
  const stack: number[] = [];
  let quoted: number | undefined;
  let escaped = false;
  for (const [at, {segment}] of chars.entries()) {
    if (close) {
      if (segment === open) stack.push(at);
      if (segment === close && stack.length) matches.push([stack.pop()!, at]);
    } else {
      if (segment === open && !escaped) {
        if (quoted === undefined) quoted = at;
        else {
          matches.push([quoted, at]);
          quoted = undefined;
        }
      }
      escaped = segment === '\\' && !escaped;
    }
  }
  const pair =
    matches.filter(([a, b]) => a <= i && i <= b)[count - 1] ?? (!close ? matches.find(([a]) => a > i) : undefined);
  if (pair) return [offsetAt(pair[0] + (around ? 0 : 1)), offsetAt(pair[1] + (around ? 1 : 0))];
}

function insertMode(state: VimState, draft: PasteState): VimResult {
  return updated({...idle(state), mode: 'INSERT', anchor: undefined, insert: {base: draft}}, draft);
}

function operate(
  state: VimState,
  draft: PasteState,
  op: Operator,
  from: number,
  to: number,
  linewise = false,
): VimResult {
  const normal = {...idle(state), mode: 'NORMAL' as const, anchor: undefined, column: undefined};
  if (from === to && !linewise) return op === 'c' ? insertMode(normal, draft) : updated(normal, draft);
  let text = spanText(draft, from, to);
  if (linewise && !text.endsWith('\n')) text += '\n';
  const next = {...normal, register: {text, linewise}};
  if (op === 'y') return updated(next, move(draft, from));
  let start = from;
  if (linewise && op === 'd' && to === draft.value.length && from > 0 && (from === to || draft.value[to - 1] !== '\n'))
    start--;
  const replacement = linewise && op === 'c' && to < draft.value.length ? '\n' : '';
  const changed = move(replaceRange(draft, start, to, replacement), start);
  if (op === 'c') return insertMode(next, changed);
  return updated(next, linewise ? move(changed, firstNonblank(changed.value, start)) : changed);
}

function lineRange(value: string, a: number, b: number): [number, number] {
  const end = lineEnd(value, Math.max(a, b));
  return [lineStart(value, Math.min(a, b)), Math.min(value.length, end + 1)];
}

function repeatedLine(value: string, from: number, count: number): [number, number] {
  let last = from;
  for (let n = 1; n < count; n++) {
    const end = lineEnd(value, last);
    if (end === value.length) break;
    last = end + 1;
  }
  return lineRange(value, from, last);
}

function operatorCommand(op: Operator, key: string, find?: Find, object?: string): Command {
  return (state, draft, count, width) => {
    const {value, cursor} = draft;
    const buf = buffer(draft);
    if (object) {
      const span = objectSpan(draft, buf, object, key === 'a', count);
      return span ? operate(state, draft, op, ...span) : {state, draft};
    }
    if (key === op) return operate(state, draft, op, ...repeatedLine(value, cursor, count), true);
    const target = find ? findChar(draft, buf, find, count) : motion(draft, buf, key, count, state.column, width);
    if (target === undefined) return {state, draft};
    if (['j', 'k', 'gg', 'G'].includes(key))
      return operate(state, draft, op, ...lineRange(value, cursor, target), true);
    if (target === cursor && key !== 'e' && key !== 'E') return {state, draft};
    const inclusive = (find && target >= cursor) || key === 'e' || key === 'E' || key === '%';
    let end = inclusive ? buf.step(Math.max(cursor, target), 1) : Math.max(cursor, target);
    if ((key === 'w' || key === 'W') && target > cursor) {
      if (op === 'c' && !/^\s/u.test(value.slice(cursor)))
        end = buf.step(word(buf, cursor, key === 'w' ? 'e' : 'E', count), 1);
      else if (lineStart(value, target) === target) end = lineEnd(value, Math.max(cursor, target - 1));
    }
    return operate(state, draft, op, Math.min(cursor, target), end);
  };
}

function execute(
  state: VimState,
  draft: PasteState,
  command: Command,
  count: number,
  width: number,
  record = true,
): VimResult {
  const next = command({...idle(state), column: undefined}, draft, count, width);
  if (!record) return next;
  const repeat = {command, count};
  if (next.state.mode === 'INSERT' && next.state.insert)
    return {...next, state: {...next.state, insert: {...next.state.insert, repeat}}};
  if (next.draft.value !== draft.value || next.draft.pastes !== draft.pastes)
    return {...next, state: {...next.state, repeat}};
  return next;
}

function changeText(draft: PasteState, from: number, to: number, text: string, cursor = from) {
  return move(replaceRange(draft, from, to, text), cursor);
}

function insertEdit(base: PasteState, draft: PasteState): InsertEdit | undefined {
  if (base.value === draft.value && base.pastes === draft.pastes) return;
  const before = buffer(base);
  const after = buffer(draft);
  const caret = before.indexAt(base.cursor);
  let start = 0;
  while (start < caret && before.chars[start]?.segment === after.chars[start]?.segment) start++;
  let end = before.chars.length;
  let newEnd = after.chars.length;
  while (end > caret && newEnd > start && before.chars[end - 1]?.segment === after.chars[newEnd - 1]?.segment) {
    end--;
    newEnd--;
  }
  if (end === start && newEnd === start) return;
  return {
    left: caret - start,
    right: end - caret,
    text: spanText(draft, after.offsetAt(start), after.offsetAt(newEnd)),
  };
}

function leaveInsert(state: VimState, draft: PasteState): VimResult {
  const {insert} = state;
  const edit = insert && insertEdit(insert.base, draft);
  const repeat = insert?.repeat ?? {command: insertMode, count: 1};
  const cursor =
    draft.cursor > lineStart(draft.value, draft.cursor) ? buffer(draft).step(draft.cursor, -1) : draft.cursor;
  return updated(
    {
      ...idle(state),
      mode: 'NORMAL',
      insert: undefined,
      column: undefined,
      repeat: edit ? {...repeat, insert: edit} : (insert?.repeat ?? state.repeat),
    },
    move(draft, cursor),
  );
}

function insertAt(key: string): Command {
  return (state, draft) => {
    const {value, cursor} = draft;
    const end = lineEnd(value, cursor);
    const at =
      key === 'a'
        ? Math.min(end, buffer(draft).step(cursor, 1))
        : key === 'A'
          ? end
          : key === 'I'
            ? firstNonblank(value, cursor)
            : key === 'O'
              ? lineStart(value, cursor)
              : key === 'o'
                ? end
                : cursor;
    const next =
      key === 'o' || key === 'O' ? changeText(draft, at, at, '\n', key === 'o' ? at + 1 : at) : move(draft, at);
    return insertMode(state, next);
  };
}

function put(register: Register, after: boolean): Command {
  return (state, draft, count) => {
    const {value, cursor} = draft;
    // Bound repeated insertion so a large register cannot multiply into an unbounded draft.
    const text = register.text.repeat(Math.min(count, Math.max(1, Math.floor(1_000_000 / register.text.length))));
    if (register.linewise) {
      const end = lineEnd(value, cursor);
      const start = after ? Math.min(value.length, end + 1) : lineStart(value, cursor);
      if (!value) return updated(state, changeText(draft, 0, 0, text.slice(0, -1)));
      if (after && end === value.length)
        return updated(state, changeText(draft, start, start, '\n' + text.slice(0, -1), start + 1));
      return updated(state, changeText(draft, start, start, text));
    }
    const start = after ? Math.min(lineEnd(value, cursor), buffer(draft).step(cursor, 1)) : cursor;
    const next = replaceRange(draft, start, start, text);
    return updated(state, move(next, buffer(next).step(next.cursor, -1)));
  };
}

function joinLines(state: VimState, draft: PasteState, count: number): VimResult {
  const {value, cursor} = draft;
  let start = lineEnd(value, cursor);
  const at = start;
  if (start === value.length) return {state, draft};
  let next = draft;
  for (let n = 1; n < Math.max(2, count) && start < next.value.length; n++) {
    const following = firstNonblank(next.value, start + 1);
    const last = next.value[start - 1] ?? '';
    const text =
      following === lineEnd(next.value, start + 1) || !last || /\s/u.test(last) || next.value[following] === ')'
        ? ''
        : ' ';
    next = changeText(next, start, following, text, at);
    start = lineEnd(next.value, start);
  }
  return updated(state, next);
}
const toggleCase = (text: string) => (text === text.toUpperCase() ? text.toLowerCase() : text.toUpperCase());

function indent(dir: string, lines: number): Command {
  return (state, draft) => {
    const [start, end] = repeatedLine(draft.value, draft.cursor, lines);
    let next = draft;
    // Edit each line separately so collapsed paste entries elsewhere keep their metadata.
    const starts: number[] = [];
    for (let at = start; at < end; at = lineEnd(draft.value, at) + 1) starts.push(at);
    for (const at of starts.reverse()) {
      if (dir === '>') next = replaceRange(next, at, at, '  ');
      else
        next = replaceRange(next, at, at + (next.value.slice(at, at + 2).match(/^(?: {1,2}|\t)/)?.[0].length ?? 0), '');
    }
    return updated(state, move(next, firstNonblank(next.value, start)));
  };
}

function visualApply(state: VimState, draft: PasteState, key: string, char?: string): Command {
  const [from, to] = vimSelection(state, draft)!;
  const linewise = state.mode === 'VISUAL LINE' || ['X', 'D', 'C', 'S', 'R', 'Y'].includes(key);
  const length = buffer(draft).indexAt(to) - buffer(draft).indexAt(from);
  const lines = draft.value.slice(from, to).split('\n').length;
  return (normal, current, count, width) => {
    const at = current.cursor;
    const buf = buffer(current);
    const [a, b] = linewise ? repeatedLine(current.value, at, lines) : [at, buf.step(at, length)];
    if ('dcysxXDCSRY'.includes(key)) {
      const op = key === 'y' || key === 'Y' ? 'y' : 'csCSR'.includes(key) ? 'c' : 'd';
      return operate(normal, current, op, a, b, linewise);
    }
    if (key === 'J') return joinLines(normal, current, lines);
    if (key === '<' || key === '>') return indent(key, lines)(normal, current, count, width);
    if (key === 'p' || key === 'P') {
      if (!state.register) return {state: normal, draft: current};
      const next = operate(normal, current, 'd', a, b, linewise);
      if (linewise) {
        const step = at >= next.draft.value.length;
        return put(state.register, step)(next.state, next.draft, 1, width);
      }
      return updated(next.state, changeText(current, a, b, state.register.text));
    }
    const transform =
      key === 'u'
        ? (s: string) => s.toLowerCase()
        : key === 'U'
          ? (s: string) => s.toUpperCase()
          : key === '~'
            ? toggleCase
            : () => char ?? '';
    let next = current;
    for (const {index, segment} of buf.chars.slice(buf.indexAt(a), buf.indexAt(b)).reverse()) {
      if (segment !== '\n' && !current.pastes.some(p => p.start === index))
        next = replaceRange(next, index, index + segment.length, transform(segment));
    }
    return updated(normal, move(next, at));
  };
}

export function stepVim(input: VimState, draft: PasteState, key: string, width = 74): VimResult {
  const {mode, pending, count} = input;
  const visual = isVisual(input);
  if (key === 'escape') {
    if (mode === 'INSERT') return leaveInsert(input, draft);
    return updated({...idle(input), mode: 'NORMAL', anchor: undefined}, draft);
  }
  if (key === 'enter' && !visual) return {state: idle(input), draft, effect: 'submit'};
  if (mode === 'INSERT') {
    const state = input.insert ? input : {...input, insert: {base: draft}};
    return updated(state, replaceRange(draft, draft.cursor, draft.cursor, key));
  }
  const state = idle(input);
  const amount = count || 1;
  const normal = {...state, mode: 'NORMAL' as const, anchor: undefined};
  const buf = buffer(draft);
  const apply = (command: Command, n = amount, record = true) => execute(state, draft, command, n, width, record);
  const select = (command: Command) => {
    const [from] = vimSelection(input, draft)!;
    const at = input.mode === 'VISUAL LINE' ? from : Math.min(input.anchor ?? draft.cursor, draft.cursor);
    return execute(normal, move(draft, at), command, 1, width);
  };
  const advance = (moveKey: string, n: number) => {
    const row =
      moveKey.length === 2 && isVertical(moveKey)
        ? (visualRows(draft.value, width).findLast(row => row.start <= draft.cursor)?.start ?? 0)
        : lineStart(draft.value, draft.cursor);
    const column = isVertical(moveKey)
      ? (state.column ?? textWidth(draft.value.slice(row, draft.cursor)))
      : moveKey === '$'
        ? Infinity
        : undefined;
    const target = motion(draft, buf, moveKey, n, column, width);
    const snapped = buf.offsetAt(buf.indexAt(target));
    return updated({...state, column}, move(draft, snapped));
  };

  if (pending?.kind === 'object') {
    if (!isObject(key)) return {state, draft};
    if (pending.op) return apply(operatorCommand(pending.op, pending.key, undefined, key), pending.count);
    const span = objectSpan(draft, buf, key, pending.key === 'a', pending.count);
    return span ? updated({...state, anchor: span[0]}, move(draft, buf.step(span[1], -1))) : {state, draft};
  }
  if (pending?.kind === 'find') {
    if (graphemes(key).length !== 1 || key === '\n') return {state, draft};
    const find = {key: pending.key, char: key};
    const found = {...state, find};
    if (pending.op) return execute(found, draft, operatorCommand(pending.op, pending.key, find), pending.count, width);
    return updated(
      {...found, column: undefined},
      move(draft, findChar(draft, buf, find, pending.count) ?? draft.cursor),
    );
  }
  if (pending?.kind === 'replace') {
    if (graphemes(key).length !== 1 || key === '\n') return {state, draft};
    if (visual) return select(visualApply(input, draft, 'r', key));
    return apply((current, value, n) => {
      const bufferView = buffer(value);
      const end = bufferView.step(value.cursor, n);
      if (end > lineEnd(value.value, value.cursor) || bufferView.indexAt(end) - bufferView.indexAt(value.cursor) !== n)
        return {state: current, draft: value};
      const text = key.repeat(n);
      return updated(current, changeText(value, value.cursor, end, text, value.cursor + text.length - key.length));
    }, pending.count);
  }
  if (pending?.kind === 'indent') return key === pending.key ? apply(indent(key, pending.count)) : {state, draft};
  if (pending?.kind === 'g') {
    if (!['g', 'j', 'k'].includes(key)) return {state, draft};
    const moveKey = 'g' + key;
    return pending.op ? apply(operatorCommand(pending.op, moveKey), pending.count) : advance(moveKey, pending.count);
  }
  if (/^[0-9]$/.test(key) && (count || key !== '0'))
    return {state: {...input, count: cap(count * 10 + Number(key))}, draft};
  const op = pending?.kind === 'operator' ? pending.op : undefined;
  const total = pending?.kind === 'operator' ? cap(pending.count * amount) : amount;
  if (key === 'g') return {state: {...state, pending: {kind: 'g', key, op, count: total}}, draft};
  if (['f', 'F', 't', 'T'].includes(key))
    return {state: {...state, pending: {kind: 'find', key, op, count: total}}, draft};
  if ((op || visual) && (key === 'a' || key === 'i'))
    return {state: {...state, pending: {kind: 'object', key, op, count: total}}, draft};
  if (key === ';' || key === ',') {
    if (op || !state.find) return {state, draft};
    const flip: Record<string, string> = {f: 'F', F: 'f', t: 'T', T: 't'};
    const find = key === ';' ? state.find : {...state.find, key: flip[state.find.key]!};
    return updated(state, move(draft, findChar(draft, buf, find, amount, true) ?? draft.cursor));
  }
  const motionCount = key === 'G' && !(count || (pending?.kind === 'operator' && pending.typed)) ? 0 : total;
  if (key === '%' && (count || (pending?.kind === 'operator' && pending.typed))) return {state, draft};
  if (op) return key === op || MOTIONS.has(key) ? apply(operatorCommand(op, key), motionCount) : {state, draft};
  if (MOTIONS.has(key) || (visual && key === 'enter')) {
    if (!visual && !count && (key === 'k' || key === 'j')) {
      const edge =
        key === 'k'
          ? lineStart(draft.value, draft.cursor) === 0
          : lineEnd(draft.value, draft.cursor) === draft.value.length;
      if (edge) return {state, draft, effect: key === 'k' ? 'older' : 'newer'};
    }
    return advance(key === 'enter' ? 'j' : key, motionCount);
  }

  if (key === 'v' || key === 'V') {
    const target = key === 'v' ? 'VISUAL' : 'VISUAL LINE';
    return updated(target === mode ? normal : {...state, mode: target, anchor: state.anchor ?? draft.cursor}, draft);
  }
  if (key === 'r') return {state: {...state, pending: {kind: 'replace', key, count: amount}}, draft};
  if (visual) {
    if (key === 'o') return updated({...state, anchor: draft.cursor}, move(draft, state.anchor ?? draft.cursor));
    if (['d', 'c', 'y', 'x', 'X', 's', 'D', 'C', 'S', 'R', 'Y', '~', 'u', 'U', 'p', 'P', 'J', '>', '<'].includes(key))
      return select(visualApply(input, draft, key));
    return {state, draft};
  }
  if (key === 'd' || key === 'c' || key === 'y')
    return {state: {...state, pending: {kind: 'operator', op: key, count: amount, typed: !!count}}, draft};
  if (['i', 'a', 'I', 'A', 'o', 'O'].includes(key)) return apply(insertAt(key));
  if (key === '>' || key === '<') return {state: {...state, pending: {kind: 'indent', key, count: amount}}, draft};
  if (key === 'J') return apply(joinLines);
  if (key === 'p' || key === 'P')
    return apply((current, value, n, columns) =>
      current.register?.text
        ? put(current.register, key === 'p')(current, value, n, columns)
        : {state: current, draft: value},
    );
  if (key === 'S' || key === 'Y' || key === 'D' || key === 'C') {
    const op = key.toLowerCase() as Operator;
    return apply(
      operatorCommand(key === 'S' ? 'c' : op, key === 'S' ? 'c' : key === 'Y' ? 'y' : '$'),
      key === 'D' || key === 'C' ? 1 : amount,
    );
  }
  if (key === 'x' || key === 'X' || key === 's' || key === '~')
    return apply((current, value, n) => {
      const {cursor} = value;
      const view = buffer(value);
      const from = key === 'X' ? Math.max(lineStart(value.value, cursor), view.step(cursor, -n)) : cursor;
      const to = key === 'X' ? cursor : Math.min(lineEnd(value.value, cursor), view.step(cursor, n));
      if (key !== '~') return operate(current, value, key === 's' ? 'c' : 'd', from, to);
      let next = value;
      for (const {index, segment} of view.chars.slice(view.indexAt(from), view.indexAt(to)).reverse()) {
        if (!value.pastes.some(p => p.start === index))
          next = replaceRange(next, index, index + segment.length, toggleCase(segment));
      }
      return updated(current, move(next, buffer(next).step(from, n)));
    });
  const effect =
    key === 'u' ? 'undo' : key === 'ctrl+r' ? 'redo' : key === '?' ? 'help' : key === '/' ? 'history' : undefined;
  if (effect) return {state, draft, effect};
  if (key === '.' && state.repeat) {
    const repeat = state.repeat;
    let next = apply(repeat.command, count || repeat.count, false);
    if (next.state.mode === 'INSERT') {
      if (repeat.insert) {
        const {left, right, text} = repeat.insert;
        const cursor = next.draft.cursor;
        const view = buffer(next.draft);
        next = {...next, draft: replaceRange(next.draft, view.step(cursor, -left), view.step(cursor, right), text)};
      }
      next = leaveInsert(next.state, next.draft);
    }
    return {...next, state: {...next.state, repeat}};
  }
  return {state, draft};
}

/** Composer-owned insertion and undo still use PasteState and its metadata. */
export function reconcileVim(state: VimState, previous: PasteState, next: PasteState): VimResult {
  const tracked =
    state.mode === 'INSERT' && !state.insert && previous.value !== next.value
      ? {...state, insert: {base: previous}}
      : state;
  if (tracked.mode === 'INSERT' && previous.value === next.value) return {state: tracked, draft: next};
  return updated(tracked, next);
}
