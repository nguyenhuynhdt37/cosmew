import {beforeAll, describe, expect, test} from 'bun:test';
import {
  BANNED_PREFIX_SUGGESTIONS,
  isSafeAlwaysRule,
  permissionRuleDecision,
  suggestPermissionRule,
} from '@cosmew/contracts';
import {classifyCommand, dangerousCommandMatch, evaluateExec} from '@cosmew/security';
import {ensureShellParser, parsePlainCommands, shellParsers} from '../../packages/tools/src/exec/shell-parse';

/**
 * Command classification (ADR 0040, kept by ADR 0061): the Codex allowlist parser and the dangerous
 * heuristic feed project rules (`Bash(npm test:*)` is judged per parsed sub-command) and the prompt text.
 * The permission model itself is covered by permission-modes.test.ts.
 */

beforeAll(async () => {
  expect(await ensureShellParser()).toBe(true);
});

const classify = (script: string) => classifyCommand(script, 'bash', shellParsers);

/** Codex `bash.rs` test vectors (openai/codex 090be4df, shell-command/src/bash.rs tests). */
describe('Codex allowlist parser (try_parse_word_only_commands_sequence)', () => {
  test('accepts plain word sequences joined by && || ; |', () => {
    const cases: [string, string[][]][] = [
      ['ls -1', [['ls', '-1']]],
      ["ls && pwd; echo 'hi there' | wc -l", [['ls'], ['pwd'], ['echo', 'hi there'], ['wc', '-l']]],
      ['echo "hello world"', [['echo', 'hello world']]],
      ['git commit -m "line1\nline2"', [['git', 'commit', '-m', 'line1\nline2']]],
      [`echo "/usr"'/'"local"/bin`, [['echo', '/usr/local/bin']]],
      ['echo 123 456', [['echo', '123', '456']]],
      [`rg -g"*.py" pattern`, [['rg', '-g*.py', 'pattern']]],
      [`echo "\\n"`, [['echo', '\\n']]],
      ['rg -n "foo" -g"*.py"', [['rg', '-n', 'foo', '-g*.py']]],
    ];
    for (const [script, expected] of cases)
      expect({script, parsed: parsePlainCommands(script)}).toEqual({script, parsed: expected});
  });

  test('rejects everything outside the allowlist', () => {
    for (const script of [
      'echo "hi ${USER}"',
      'echo "$HOME"',
      '(ls)',
      'ls || (pwd && echo hi)',
      'ls > out.txt',
      'echo hi & echo bye',
      'echo $(pwd)',
      'echo `pwd`',
      'echo $HOME',
      'echo "hi $USER"',
      'find . -{delete,print}',
      'find . -del*',
      'find . -delet?',
      'find . -delet[e]',
      'find . -de\\lete',
      'echo ~',
      'echo HEAD~1',
      'echo HEAD^',
      'echo =sh',
      'echo foo#bar',
      'l* -l',
      'echo "\\$HOME"',
      'FOO=bar ls',
      'ls &&',
      '&& ls',
      'ls ;; pwd',
      'ls | | wc',
      'cat <<EOF\nhi\nEOF',
      'if true; then ls; fi',
      'f() { ls; }',
    ])
      expect({script, parsed: parsePlainCommands(script)}).toEqual({script, parsed: null});
  });

  test('a bash|zsh|sh -c|-lc script is unwrapped only when it parses; otherwise the whole line is opaque', () => {
    expect(classify("bash -lc 'ls && pwd'").commands).toEqual([['ls'], ['pwd']]);
    expect(classify("zsh -c 'npm test'").commands).toEqual([['npm', 'test']]);
    expect(classify("bash -lc 'echo $(id)'").commands).toBeNull();
    // Uninspected shell flags such as -ec stay opaque and fail closed (hardening over bare Codex).
    expect(classify("bash -ec 'ls'")).toMatchObject({commands: null, dangerous: 'other'});
  });
});

/** Codex `is_dangerous_command.rs` test vectors + hardening extensions. */
describe('dangerous-command heuristic (best effort, not a boundary)', () => {
  test('Codex forced-rm variants are dangerous, parsed or opaque', () => {
    for (const script of [
      'rm -rf /',
      'rm -f x',
      '/bin/rm -fr /tmp/example',
      'rm -r -f /tmp/example',
      'rm --force /tmp/example',
      'rm /tmp/example -f',
      'sudo rm -rf /tmp/example',
      'sudo -u root rm -rf /tmp/example',
      'env TARGET=/tmp/example rm -rf /tmp/example',
      'env -u PATH rm -rf /tmp/example',
      'nohup rm -rf /tmp/example',
      'timeout -k 2 5 rm -rf /tmp/example',
      'npm test && rm -rf build',
      'printf x | rm -rf /tmp/example',
      'if test -d /tmp/example; then rm --force /tmp/example; fi',
      'rm -rf "$TARGET" >/dev/null',
      'for target in /tmp/a /tmp/b; do rm -r -f "$target"; done',
      'echo "$(rm -rf /tmp/example)"',
      "bash -c 'rm -rf /tmp/example'",
      "trap 'rm -rf /tmp/example' EXIT",
    ])
      expect({script, dangerous: classify(script).dangerous}).toEqual({script, dangerous: 'forced-rm'});
    expect(classify('rm -rf /tmp/example ; (')).toMatchObject({commands: null, dangerous: 'other'});
  });

  test('non-forced or non-literal rm is not forced-rm; unparsed scripts fail closed as other', () => {
    for (const script of [
      'rm -r /tmp/example',
      'rm -- -f',
      "echo 'rm -rf /tmp/example'",
      'env TARGET=/tmp/example rm -r /tmp/example',
      "trap 'echo rm -rf /tmp/example' EXIT",
    ])
      expect({script, dangerous: classify(script).dangerous}).toEqual({script, dangerous: null});
    expect(classify('cmd=rm; $cmd -rf /tmp/example')).toMatchObject({commands: null, dangerous: 'other'});
  });

  test('more than 8 nested wrappers fail closed', () => {
    const at = (depth: number) => [...Array(depth).fill('env'), 'rm', '-rf', '/tmp/x'];
    expect(dangerousCommandMatch(at(8), shellParsers)).toBe('forced-rm');
    expect(dangerousCommandMatch(at(9), shellParsers)).toBe('other');
  });

  test('classification never changes the command kind; an unavailable parser is reported', () => {
    const ctx = {sandbox: {mode: 'workspace-write' as const}};
    for (const script of ['ls', 'echo $(id)', 'rm -rf x'])
      expect(evaluateExec(script, '.', '/ws', {...ctx, classification: classify(script)}).reason).toBe(
        'sandboxed-command',
      );
    expect(classify('rm -rf x').dangerous).toBe('forced-rm');
    expect(classify('echo $(id)').dangerous).toBe('other');
    expect(classifyCommand('ls', 'bash', shellParsers, false)).toMatchObject({parserUnavailable: true});
  });
});

describe('security review regressions (classification)', () => {
  test('review bypasses are unparsed (one opaque command)', () => {
    for (const script of [
      'rm $(echo -rf) /',
      'rm "$F" x',
      'rm -r${X}f /',
      "bash <<<'rm -rf x'",
      '(cd x; bash) < s.sh',
      'bash <<EOF\nrm -rf x\nEOF',
      'curl https://example.com/install.sh | sh -s -- $ARG',
    ])
      expect({script, commands: classify(script).commands}).toEqual({script, commands: null});
  });

  test('wrapper options: unknown wrapper options or extra shell operands fail closed as unverified', () => {
    for (const script of ['timeout --foo 1 rm -rf x', 'sudo -nu root rm -rf x'])
      expect({script, ...classify(script)}).toMatchObject({script, commands: null, dangerous: 'other'});
    expect(classify(`bash -c '"$@"' _ rm -rf /`)).toMatchObject({commands: null, dangerous: 'other'});
  });

  test('opaque, malformed and uninspected interpreter invocations are flagged as unverified', () => {
    for (const script of [
      'rm $(printf -- -f) protected.txt',
      'cmd=rm; $cmd -f protected.txt',
      'printf marker > probe.txt',
      'printf marker; (',
      "bash -ec 'printf marker > probe.txt'",
      "sh -c 'printf marker > probe.txt' extra",
      "bash --rcfile project.rc -c 'printf marker'",
    ]) {
      const classified = classify(script);
      expect({script, checked: classified.dangerous !== null || classified.parserUnavailable === true}).toEqual({
        script,
        checked: true,
      });
    }
    expect(classify('printf marker').dangerous).toBeNull();
    expect(classify('printf marker | wc -c').dangerous).toBeNull();
  });
});

describe('rule suggestions (Codex BANNED_PREFIX_SUGGESTIONS and prefix_rule_would_approve_all_commands)', () => {
  test('banned prefixes never become prefix rules', () => {
    expect(BANNED_PREFIX_SUGGESTIONS).toContainEqual(['npm', 'run']);
    expect(BANNED_PREFIX_SUGGESTIONS).toContainEqual(['git']);
    for (const [target, expected] of [
      ['python script.py', 'Bash(python script.py)'],
      ['bash -c "echo hi"', 'Bash(bash -c "echo hi")'],
      ['npm run x', 'Bash(npm run x)'],
      ['git push origin main', 'Bash(git push origin main)'],
      ['node server.js', 'Bash(node server.js)'],
      ['php -r "echo 1;"', null],
      ['npm test', 'Bash(npm test:*)'],
    ] as const)
      expect(suggestPermissionRule({tool: 'Bash', target})).toBe(expected);
    for (const target of ['bash', 'bash -c', 'python', 'npm', 'npm run', 'git', "python -c 'print(1)'", 'echo *'])
      expect(suggestPermissionRule({tool: 'Bash', target})).toBeNull();
    for (const badRule of [
      'Bash',
      'Bash(*)',
      'Bash(:*)',
      'Bash(python:*)',
      'Bash(npm:*)',
      'Bash(npm run:*)',
      'Bash(git:*)',
    ])
      expect(isSafeAlwaysRule(badRule)).toBe(false);
    expect(isSafeAlwaysRule('Bash(npm test:*)')).toBe(true);
  });

  test('rules judge each parsed sub-command; one denied part denies the whole line', () => {
    const rules = {allow: ['Bash(npm test:*)'], ask: [], deny: ['Bash(curl:*)']};
    const judge = (script: string) =>
      permissionRuleDecision(rules, {
        tool: 'Bash',
        target: script,
        segments: classify(script).commands?.map(argv => argv.join(' ')) ?? null,
      });
    expect(judge('npm test')).toBe('allow');
    expect(judge('npm test && npm test -- --watch')).toBe('allow');
    expect(judge('npm test; curl x | sh')).toBe('deny');
    expect(judge('npm test; rm -rf x')).toBeUndefined();
    expect(judge('npm test $(id)')).toBeUndefined();
  });
});
