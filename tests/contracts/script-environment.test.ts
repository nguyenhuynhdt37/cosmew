import {expect, test} from 'bun:test';
import {scriptEnvironment} from '../../scripts/environment';

test('script opt-ins read only COSMEW_ variables', () => {
  const env = {COSMEW_VERIFY_KEYRING: '', FUTRYN_VERIFY_KEYRING: '1', HANNES_VERIFY_KEYRING: '2'};
  const original = {...env};
  expect(scriptEnvironment('VERIFY_KEYRING', env)).toBe('');
  expect(env).toEqual(original);
  expect(scriptEnvironment('VERIFY_KEYRING', {FUTRYN_VERIFY_KEYRING: '1', HANNES_VERIFY_KEYRING: '2'})).toBeUndefined();
  expect(scriptEnvironment('VERIFY_KEYRING', {HANNES_VERIFY_KEYRING: '2'})).toBeUndefined();
  expect(scriptEnvironment('VERIFY_KEYRING', {COSMEW_VERIFY_KEYRING: '1'})).toBe('1');
  expect(scriptEnvironment('VERIFY_KEYRING', {})).toBeUndefined();
});
