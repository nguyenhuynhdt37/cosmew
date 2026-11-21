import {expect, test} from 'bun:test';
import {scriptEnvironment} from '../../scripts/environment';

test('script opt-ins prefer canonical variables and only read legacy fallbacks', () => {
  const env = {COSMEW_VERIFY_KEYRING: '', FUTRYN_VERIFY_KEYRING: '1', HANNES_VERIFY_KEYRING: '2'};
  const original = {...env};
  expect(scriptEnvironment('VERIFY_KEYRING', env)).toBe('');
  expect(env).toEqual(original);
  expect(scriptEnvironment('VERIFY_KEYRING', {FUTRYN_VERIFY_KEYRING: '1', HANNES_VERIFY_KEYRING: '2'})).toBe('1');
  expect(scriptEnvironment('VERIFY_KEYRING', {HANNES_VERIFY_KEYRING: '2'})).toBe('2');
  expect(scriptEnvironment('VERIFY_KEYRING', {})).toBeUndefined();
});
