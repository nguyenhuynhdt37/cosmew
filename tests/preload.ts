/**
 * Hermetic test environment (ADR 0034). The CLI selects the Docker command backend automatically
 * when a local engine socket exists; fixture tests must never probe or use the developer's engine.
 * Real-engine tests opt in with FUTRYN_TEST_CONTAINER=1 and inject their runtime explicitly.
 */
process.env.FUTRYN_COMMAND_BACKEND ??= 'none';
/**
 * The product default is Codex `on-request` (ADR 0040). Fixture suites written against the approval
 * dialog start CLI-wired sessions in `untrusted` so every prompt path stays exercised; the
 * `on-request`/`never` behavior is pinned by tests that set the policy explicitly
 * (tests/security/approval-policy.test.ts, tests/end-to-end/approval-policy.test.ts).
 */
process.env.FUTRYN_APPROVAL_POLICY ??= 'untrusted';
