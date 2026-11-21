/**
 * Hermetic test environment (ADR 0034, 0062). Fixture tests must not run the developer's shell.
 * Suites that need the OS sandbox pass `FUTRYN_COMMAND_BACKEND=native` themselves.
 */
process.env.FUTRYN_COMMAND_BACKEND ??= 'none';
