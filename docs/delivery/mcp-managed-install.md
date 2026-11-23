# MCP metadata and local package format

Implemented boundary, 2026-11-22: discovery reads only the official registry at
`https://registry.modelcontextprotocol.io/v0.1/servers`. Search is explicitly
user initiated, bounded to 512 KiB/30 entries and ten seconds, cancellable, and
uses escaped IDs/cursors. Publisher text, commands, arguments and headers never
execute during discovery. Remote recipes configure HTTPS URLs; discovery does
not contact those endpoints. Connection composition remains responsible for its
network policy. Registry-listed and Cosmew-tested are separate fields; all
curated candidate entries currently have `tested: false`.

Local installation supports exact-version npm JavaScript bins. The automatic
path fetches the exact npm version metadata, requires SHA-512 integrity and
supports dependency-free packages. Packages with dependencies require an
explicit complete package-lock v3, with pinned versions, SHA-512 integrity and
HTTPS `registry.npmjs.org` tarballs for every dependency. Git/file/URL dependency
specifiers, links, bundled artifacts, non-npm registries, arbitrary runtime
commands and lifecycle scripts are unsupported. Missing package requirements
produce a manual-setup error. There is no implicit npm resolver: resolving git
transitive dependencies can execute programs before a generated lock can be
validated. A later safe dependency resolver can expand this deliberately limited
format. Registry metadata alone does not guarantee installability.

Only explicit human manager install operations compose the installer. It never
registers a model tool or writes server configuration. npm runs `ci` with
`--ignore-scripts --bin-links=false`, ignores user/global npm config, has a
private HOME/cache and receives no inherited NODE_OPTIONS or credentials. npm
checks lock integrity on download; independent post-install validation rejects
symlinks and package/bin identity or traversal changes. The returned launch
command is `node` plus the installed package's absolute JavaScript bin, rather
than an npx download command. Manager connection supplies the protocol handshake;
installation readiness means validated files, not successful MCP negotiation.
The private per-user store writes an atomic manifest after validation; failed or
cancelled installs are removed and cannot advertise ready. Removal requires an
owned UUID directory and marker and cannot target another path. Interrupted
processes may leave `installing` records, which remain visibly unfinished.

Verification uses injected npm runners and metadata fixtures, with the returned
bin actually launched against a local fixture. This proves manager filesystem,
identity, cancellation and argv invariants. It is not evidence of live npm
package extraction/integrity interoperability, remote service authentication,
real-service compatibility, cross-platform npm behavior or package security.
No real packages/accounts are used by the tests. No external dependency was added.

Upstream documentation inspected through Context7 on 2026-11-22, upstream `main`
(revision SHA unavailable, Needs verification for future schema changes):

- https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/api/official-registry-api.md
- https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/api/generic-registry-api.md
- https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/server-json/generic-server-json.md
- https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/server-json/official-registry-requirements.md

The registry response wraps each `server` beside registry-owned `_meta`;
packages use `registryType`, `identifier`, `version` and `transport.type`;
remote URLs use `remotes[].type = streamable-http`. Exact-version lookup is
`/v0.1/servers/{escaped name}/versions/{escaped version}`.
