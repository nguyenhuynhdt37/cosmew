# ADR 0114 — Large MCP tool catalogs

Date: 2026-11-22. Status: Accepted. Contract: 1.59 (additive).

A Gemini session configured through 9Router reported 209 MCP tools. Cosmew rejected normal turns with `INVALID_INPUT` before HTTP because `ModelRequest.tools` accepted at most 32 descriptors. A generation probe with an empty tool list succeeded against the same endpoint. A live Chat Completions probe with 240 synthetic descriptors received a completed stream.

Remove the obsolete descriptor count limit from `ModelRequest`. MCP discovery still bounds the number of servers and tools per server. Core accounts for serialized tool descriptions and schemas in context admission. The adapter still validates each descriptor and rejects duplicate names. Tool calls still pass through the dispatcher for validation, permissions and audit. Existing requests remain valid. The headless event version advances to 1.59 without changing event fields or durable storage.

The Chat adapter regression sends 209 descriptors through the real serializer to a local HTTP fixture and checks that every descriptor reached the provider. A live SDK turn in an empty workspace with the configured MCP servers sent 143 descriptors to 9Router and completed with HTTP 200. Exact limits for other endpoints remain **Needs verification**.
