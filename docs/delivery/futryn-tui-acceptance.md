# FUTRYN TUI1 — Acceptance Evidence

> Slash-command interaction follows [ADR 0013](../adr/0013-canonical-slash-commands.md): `/theme` opens the picker without arguments. Prior direct `/theme auto|dark|light` forms in historical notes below are no longer supported.

> Current appearance profile: [ADR 0012](../adr/0012-theme-naming-and-semantic-colors.md) supersedes the earlier monochrome-token and multicolor-catalog claims below. `/theme` offers Auto, Dark, and Light with colored semantic tokens; custom theme files remain preserved but cannot be applied.

Trạng thái: **TUI1 implemented (headless + unit/E2E verified)**. Chưa có xác minh thủ công trên terminal thật (iTerm/Kitty/Windows Terminal) — `Needs verification`.

## Phạm vi đã triển khai
| Hạng mục | Vị trí | Bằng chứng |
| :-- | :-- | :-- |
| 30 semantic tokens + schema Zod | `packages/contracts/src/models.ts` | `tests/contracts/theme-engine.test.ts` |
| 15 theme màu + 12 theme live | `apps/tui/src/theme/presets.ts` | cùng file test (contrast > 4.5 mọi theme) |
| Theme Engine (preview/cancel/commit, global+project, editor ops, import/export/remove, recovery) | `apps/tui/src/theme/theme.ts` | cùng file test + `tests/end-to-end/tui.test.ts` |
| Import FUTRYN / OpenCode / Claude Desktop + `CompatibilityReport`, từ chối JS/CSS nguy hiểm | `apps/tui/src/theme/compat.ts` | theme-engine test |
| 12 wallpaper khai báo (không chạy JS ngoài), veil, reduced-motion, pause unfocused, tự tắt khi terminal nhỏ | `apps/tui/src/theme/wallpaper.ts` | `tests/contracts/wallpaper-engine.test.ts` |
| Composer, transcript, tool card, diff, permission, sessions, models, connect, settings, status, help, palette | `apps/tui/src/components`, `apps/tui/src/screens`, `apps/tui/src/app.tsx` | E2E TUI |
| SDK ranh giới (`apps/tui` chỉ phụ thuộc contracts + sdk) | `packages/sdk` | typecheck |
| Composition root, workspace files/diff thật từ git, `hannes tui`, `hannes themes …` | `apps/cli/src` | E2E TUI |

## Upstream tham chiếu
- OpenCode `024a1462f55aa64243b859729b2d0816b42b17e3` (MIT) — chỉ tham chiếu UX, không sao chép branding/asset.
- claude-desktop-themes `1ac84ea764028dd1be6f8bc808ca18b622bcad2a` (0.8.0, MIT) — chuyển đổi palette/metadata; CSS/JS không được thực thi.
- Chi tiết: [futryn-tui-upstream-research.md](futryn-tui-upstream-research.md), [ADR 0006](../adr/0006-futryn-tui-and-theme-engine.md).

## Giới hạn trung thực
- Renderer là compositor khung ô tự viết (ANSI differential), **không dùng OpenTUI/SolidJS**; lý do ghi trong research doc. Không tuyên bố tương đương pixel với OpenCode.
- Thực thi shell/filesystem tool, MCP, plugin, subagent: **Not implemented**; tool call hiển thị nhãn "NOT IMPLEMENTED (PA1/TUI1)".
- Permission dialog: hàng đợi và quyết định hoạt động ở SDK, nhưng hiện chưa có tool nào của backend phát sinh yêu cầu thật; demo request bằng phím `N` đã bị gỡ trong Provider Connect rebuild. Chỉnh sửa tool-policy vẫn Not implemented.
- Fyn follow-up (2026-11-14): `tests/end-to-end/tui.test.ts` bổ sung subprocess PTY cho `runInteractiveTui`: hiện Fyn, chuyển động khi không có wallpaper, output monochrome và Ctrl+C khôi phục cursor/alternate screen. Các flow TUI khác vẫn chủ yếu có bằng chứng headless; chưa có nghiệm thu thủ công trên terminal GUI. [Chi tiết Fyn](fyn-companion.md).
- Product MVP **chưa** được tuyên bố hoàn tất khi chưa có nghiệm thu thủ công.


## Provider Connect and commands follow-up

[Current acceptance and reproducible tests](provider-connect-acceptance.md) include registry search/auth/account dialogs, custom endpoints, model/session boundaries, official OpenRouter headless PKCE, full actual PTY login/chat/restart/logout and native keyring rotation/deletion. [ADR 0007](../adr/0007-provider-connect-and-commands.md) records contract 1.1/schema-1 compatibility. Manual terminal-emulator visual review and live vendor generation remain pending.


## Monochrome appearance profile (2026-11-15)

The picker offers exactly three appearances with live preview, keyboard navigation, Enter apply and Esc cancel. Every theme token and rendered fixture cell uses grayscale. Old built-in themes and live wallpaper choices have been removed; active legacy global/project settings migrate without deleting custom files. CLI aliases `themes set dark|light|system` and `themes mode` persist the same state; retired theme/import/wallpaper requests report errors. System detection and fallback limitations are recorded in ADR 0011.

Verification includes palette/schema/contrast checks, preview/cancel, per-project and global migration, retained custom files, system preference changes, grayscale framebuffer cells, restart persistence, CLI diagnostics and a real Bun.Terminal keyboard/PTY test. Visual QA inspected rendered fixture picker frames in both dark and light modes; this is not manual testing of every terminal emulator.

Observed on this host: `bun run typecheck` and `bun run lint` pass; full opt-in suite **159 pass, 0 fail** across 15 files; separate integration **40 pass**, end-to-end **74 pass**. After the compact-terminal footer adjustment, the focused TUI suite passed **10 tests**, including the real PTY mode-switch/restart test. No live provider credentials were used for this appearance change.


## Auto, Dark and Light with semantic colors (2026-11-15)

The canonical `/theme` picker and IDs are `auto`, `dark`, `light`; direct `/theme auto|dark|light` and the compatibility `/themes` alias are supported. `themes set auto|dark|light` and `themes mode auto|dark|light` share the same persisted state; `system`, `futryn-default`, `monochrome-dark`, and `monochrome-light` remain accepted compatibility inputs. Settings schema 1 is unchanged. On startup previous profile IDs are migrated for global and active project separately, without deleting custom files. `mode: system` remains the storage representation for Auto.

Dark/light surfaces and normal text remain black/white; errors, warnings, success, information, emphasis, diff and syntax use semantic colors with contrast checked against both backgrounds. The chosen terminal color capability can affect actual colors; `NO_COLOR` continues to honor the terminal. The picker remains usable at small sizes, with preview/Enter/Esc semantics. System detection limits remain as documented in ADR 0011.

Observed checks: `bun run typecheck` and `bun run lint` pass; full opt-in suite **160 pass, 0 fail** across 15 files. After the picker-label and alias follow-up, the focused theme/TUI suite reports **18 pass**, including actual PTY selection and direct slash-alias checks. Separate integration reports **40 pass**, and end-to-end reports **74 pass**. Dark/light fixture framebuffers were inspected visually, including the colored chat accent. No live-provider test was required for this presentation change.

## Chat layout follow-up (2026-11-15)

The conversation viewport takes priority in standard and short terminals: the compact Fyn state/header replaces six rows of mascot art during chat below 34 rows; larger chat windows still show the complete miniature. The welcome view keeps the miniature when there is room and presents relevant `/login` or `/model` guidance for an unconfigured account. On small terminals, the input and autocomplete stay visible even when the welcome art cannot fit. The composer keeps account identity visible when a model name must be truncated, gives the Esc interrupt hint priority during streaming, and leaves cost details on the message/usage view. Status and context remain visible. Slash matching ranks canonical command prefixes ahead of legacy alias prefixes, so `/mo` prioritizes `/model` over the `/model effort` compatibility alias.

The layout uses the existing theme tokens and terminal renderer; no public contract, provider transport, persistence schema or dependency changed. Framebuffer QA inspected welcome, active chat, slash autocomplete and 40×14 fixture frames. Terminal and fixture tests check small-terminal input focus/draft preservation, live stream status, contextual model/account labels, model switching, selection/copy, cancellation and real PTY output. Actual emulator and authenticated vendor tests are recorded separately.

Observed checks for this layout follow-up: `bun run typecheck` and `bun run lint` pass; the full opt-in suite reports **165 pass, 0 fail** across 15 files, including actual Bun.Terminal E2E. The focused presentation/TUI/usage suite reports **39 pass**, including a 30×10 slash-menu interaction, account-label truncation and interruption hints. Framebuffer screenshots use deterministic fixture data; live-vendor chat was not repeated.
