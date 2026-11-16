/**
 * Hermetic test environment (ADR 0034). The CLI selects the Docker command backend automatically
 * when a local engine socket exists; fixture tests must never probe or use the developer's engine.
 * Real-engine tests opt in with FUTRYN_TEST_CONTAINER=1 and inject their runtime explicitly.
 */
process.env.FUTRYN_COMMAND_BACKEND ??= 'none';
