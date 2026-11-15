# FUTRYN TUI1 — Acceptance Evidence

> Current appearance profile: [ADR 0011](../adr/0011-monochrome-appearance.md) supersedes the older multicolor and wallpaper catalog claims below. `/theme` now offers system, white on black, and black on white; custom theme files are preserved but cannot be applied.

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
