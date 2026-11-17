import {expect, test} from 'bun:test';
import {current, parseObservationResult, type Observation} from '../process-fixtures/observe';

test('independent process observations never turn ps errors, signals or stderr into absence', () => {
  for (const result of [
    {status: null, stdout: '', stderr: '', error: new Error('timeout')},
    {status: null, stdout: '', stderr: '', signal: 'SIGTERM'},
    {status: 1, stdout: '', stderr: 'permission denied'},
    {status: 0, stdout: '', stderr: 'warning'},
    {status: 2, stdout: '', stderr: ''},
  ])
    expect(() => parseObservationResult(result, true)).toThrow('Independent ps observation failed');
  expect(() => parseObservationResult({status: 0, stdout: 'not a ps observation', stderr: ''}, true)).toThrow(
    'Independent ps observation failed',
  );
  expect(parseObservationResult({status: 0, stdout: '\n  \n', stderr: ''}, true)).toEqual([]);
  expect(parseObservationResult({status: 1, stdout: '', stderr: ''}, true)).toEqual([]);
  expect(() => parseObservationResult({status: 1, stdout: '', stderr: ''})).toThrow();
});

test('single-PID observations preserve start-time/command identity and reject invalid PID selectors', () => {
  const row = `  ${process.pid} 1 1 S Tue Nov 17 12:34:56 2026 command`;
  const parsed = parseObservationResult({status: 0, stdout: row, stderr: ''});
  expect(parsed).toHaveLength(1);
  expect(parsed[0]!.pid).toBe(process.pid);
  expect(parsed[0]!.started).toBe('Tue Nov 17 12:34:56 2026');
  expect(current({...parsed[0]!, started: 'Mon Nov 16 12:34:56 2026'})).toBeUndefined();
  expect(() => current({...parsed[0]!, pid: 0} as Observation)).toThrow('Invalid observed PID');
});
