# ADR 0092: Approval for external file access and command cwd

Date: 2026-11-22. Status: Accepted. Shared contract: 1.46.

The user requested removal of the hard workspace boundary. This supersedes the external-path refusal in ADR 0067 and the corresponding project instructions.

File tools normalize external paths using a narrow canonical root for that operation, then ask through ToolDispatcher. Normalization is not authorization. Read, Edit, Write, apply_patch, Glob, Grep and LSP use the same flow. Default and acceptEdits ask outside working directories; explicit rules, exact session grants or bypass may permit. Multi-file patches require approval for any external target not already permitted. Deny rules, protected Git/state paths, secret handling, read-before-edit, cancellation, target revalidation, Plan/Review and read-only profiles remain enforced. Search is contained to the selected root and filters protected/secret hits. External LSP location snippets are omitted without read authorization.

A canonical external Bash cwd is bound to its invocation and normal Bash approval. CommandRequest.cwdRoots includes that directory, without adding it to OS-sandbox writable roots. Sandbox off uses OS user permissions. Sandbox on retains existing write restrictions; failures do not fallback. Instructions and project context remain project-scoped. No settings file is automatically written or trusted. No dependencies added.

SDK permission requests add requiresApproval: policy asks cannot be silently answered by acceptEdits; deny rules and Plan writes still win, explicit allow and bypass can permit. Event envelopes are unchanged. Consumers expecting an exact contract version move to 1.46.

Evidence: official Claude documentation https://code.claude.com/docs/en/security and https://code.claude.com/docs/en/permissions#working-directories, retrieved 2026-11-22 via Context7 /websites/code_claude. Local installed Claude 2.1.330 (version only). Claude runtime prompt wording, exact grants and Linux bubblewrap parity: **Needs verification**.

Verification includes real temporary filesystem operations, SDK/TUI permission mode tests, LSP filtering/rename, target swaps, grant revocation, cancellation, real unsandboxed cwd writes and actual macOS Seatbelt external-write refusal. No paid provider or external agent was invoked.

Dedicated skill loads retain their existing exact catalog-discovered-file authority; generic Read still asks for external skill files. Checkpoint restoration uses the same external-write approval flow and cannot silently restore external paths in acceptEdits.

Absolute Read/Edit allow rules use Claude-style `Read(//absolute/path)` / `Edit(//absolute/path)`. Relative rules and bare Read/Edit do not implicitly grant external paths; suggested Always rules encode the explicit absolute form.
