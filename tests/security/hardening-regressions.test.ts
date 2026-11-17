import {expect, test} from 'bun:test';
import {APPROVAL_KIND_FOR_REASON} from '@futryn/security';
import {toolPermissionRequest} from '../../apps/cli/src/bootstrap/approvals';
import {fitUtf8Prefix} from '../../apps/cli/src/bootstrap/utf8';

test('every ask reason the policy can emit is shown as a sentence, never as a raw reason code', () => {
  const reasons = new Set([...Object.keys(APPROVAL_KIND_FOR_REASON), 'project-read-rule', 'web-fetch']);
  for (const reason of reasons) {
    // A patch has its own fixed explanation ("Review the exact file changes").
    const capabilities =
      reason === 'workspace-patch'
        ? (['fs.write'] as const)
        : (['fs.read', 'process.execute', 'network.connect'] as const);
    for (const capability of capabilities) {
      const request = toolPermissionRequest({tool: 'probe', capability, target: 'x', reason});
      expect(request.reason, `${reason}/${capability}`).not.toBe(reason);
      expect(request.reason).toContain(' ');
    }
  }
});

test('nested instruction budget is counted in UTF-8 bytes and never splits a code point', () => {
  for (const sample of ['Xin chào thế giới — tiếng Việt có dấu ắằẳ', 'emoji 🚀🚀🚀 end', 'a€b𐍈c']) {
    for (let max = 0; max <= Buffer.byteLength(sample) + 2; max++) {
      const fitted = fitUtf8Prefix(sample, max);
      expect(Buffer.byteLength(fitted)).toBeLessThanOrEqual(max);
      expect(fitted).not.toContain('�');
      expect(sample.startsWith(fitted)).toBe(true);
      // Maximal: one more code point would not have fit.
      const next = [...sample.slice(fitted.length)][0];
      if (next !== undefined) expect(Buffer.byteLength(fitted + next)).toBeGreaterThan(max);
    }
  }
  // String.slice counts UTF-16 units: 4 emoji are 16 bytes, so slicing by "room" would overshoot.
  expect(Buffer.byteLength('🚀'.repeat(10).slice(0, 10))).toBeGreaterThan(10);
  expect(Buffer.byteLength(fitUtf8Prefix('🚀'.repeat(10), 10))).toBeLessThanOrEqual(10);
});
