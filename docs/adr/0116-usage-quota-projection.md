# ADR 0116 — Usage quota projection

Date: 2026-11-22. Status: Accepted. Contract: 1.61 (additive).

Settings Usage read full session records twice and computed context, project and Git data even when rendering quota. It drew bars for old provider-reported percentages with no known reset. When any bar existed, the summary omitted connected accounts without quota data and suppressed session token totals.

The optional SDK backend port `listQuotaSources()` reads source-owned quota directly from the workspace's persisted turn receipts and standalone usage. SQLite projects quota-bearing sources without reading messages, attachments or recovering sessions. Child attribution remains in the parent receipt's source breakdown. Existing SDK hosts can use the session-based fallback. No schema migration or quota API was added.

The Usage summary shows session token totals and each connected account's quota state. A reply snapshot whose reset is missing or has passed retains its historical figure and observation time in details. The overview adds a current-quota-unknown label and omits its bar. Provider credit refresh is explicit with R or on entering Usage, and runs only for supported quota endpoints. Switching or scrolling does not rebuild unrelated reports.

Tests cover stale and reset-less snapshots, mixed timestamp provenance, workspaces and standalone receipt ownership, and rendering Usage without loading project or context state.

On the reported workspace, five local samples of default Usage data preparation took 111.5–222.2 ms before the change and 2.3–11.7 ms afterward. This measures the synchronous report preparation path and excludes terminal painting and provider I/O.
