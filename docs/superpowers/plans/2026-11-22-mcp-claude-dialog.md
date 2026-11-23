# MCP Claude-style dialog Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task; no parallel workers required.

**Goal:** Make `/mcp` recognizable and easy to operate using the captured Claude CLI list pattern.

**Architecture:** Keep management/auth/config in the existing SDK/host. Change only the Ink dialog's presentation/navigation and form validation. Retain bounded dispatcher-side MCP validation.

**Tech Stack:** TypeScript, React/Ink, Bun tests, existing AJV 8.20.0.

**Spec:** `docs/superpowers/specs/2026-11-22-mcp-claude-dialog-design.md`

## Global Constraints

No new dependencies or wire contracts. Never expose credentials. Default Cancel before mutations; preserve cancellation drain and permission checks. Label uncaptured Claude behavior as Needs verification.

## Tasks

- [x] Lock down the real OpenAI Docs 2020-12 schema failure with dispatcher regressions, select the proper AJV dialect, retain restrictions, and verify a real read-only call.
- [x] Add failing keyboard tests for the Claude-style list, server details/advanced settings, URL-first guided setup with draft-preserving validation and Tab navigation. Implement using the existing dialog, SDK ports and a small presentation helper.
- [x] Update previous manager tests to the intentional navigation changes. Check secrets/default Cancel/cancellation/narrow layouts. Run MCP/TUI suites, typecheck/lint and document evidence and reference limits.

## Acceptance

Typecheck and lint passed. `bun test tests/mcp apps/tui/src/ink`: 707 passed, 4 skipped, 0 failed; 8 snapshots, 28,062 assertions across 72 files. The 4 color/terminal opt-in checks remain skipped. Real OpenAI Docs search through ToolDispatcher returned ok after one-call approval.

## Visual/usability extension

User explicitly requested GPT-6.1 Sol medium subagents. Three independent workers owned status presentation, color/narrow tests, and a read-only capability audit; root integrated keyboard filtering/refresh and actionable diagnostics. Added theme-aware counters/details, local server/tool filtering, status-only refresh, guided next steps, all-problem browsing, managed-edit gating and correct removal disclosure. Focused interface checks: 30 pass/0 fail; full MCP/Ink regression gate passed.

Final visual/usability integration: typecheck and lint passed. MCP plus complete Ink test tree: 721 passed, 4 skipped, 0 failed. 8 snapshots, 28192 expect() calls. Ran 725 tests across 73 files. [90.52s].
