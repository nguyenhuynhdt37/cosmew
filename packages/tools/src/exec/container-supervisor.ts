import {readFileSync} from 'node:fs';

/**
 * Source of the trusted PID1 supervisor (ADR 0032/0034), kept as a normal JavaScript file so it is
 * readable and reviewable. It runs inside the pinned image as `bun -e <source>`; its text is also
 * part of the Docker runtime id, so any change to it invalidates earlier approvals and self-tests.
 */
export const CONTAINER_SUPERVISOR = readFileSync(new URL('./container-supervisor.js', import.meta.url), 'utf8');
