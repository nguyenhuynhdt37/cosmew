# ADR 0059 — Khung Ink cho TUI v3, chuyển đổi song song

Accepted 2026-11-18 theo [kế hoạch TUI v3](../delivery/tui-v3/plan.md).
Phạm vi: Pha 0, `apps/tui`; không thay public SDK/agent-events contract,
quyền, provider, persistence hoặc feature của renderer cũ.

> **Cập nhật Pha 3 (2026-11-18):** mặc định đã đổi sang Ink cho `fyn`, `futryn`, `hannes`, `hannes tui` và chạy trần; cờ `FUTRYN_TUI` và toàn bộ renderer/feature cũ (`app.tsx`, `features/*`, `render/`, `ui/`, `core/`, `input/terminal-keys`) đã bị xoá. Giữ lại: theme engine (`src/theme/`), `input/text.ts`, `clipboard.ts`, `types.ts`.

## Quyết định

Dùng React/Ink cho TUI mới trong `apps/tui/src/ink/`, ghim chính xác:

| Package                   | Version | License |
| ------------------------- | ------- | ------- |
| ink                       | 8.0.0   | MIT     |
| react                     | 19.3.1  | MIT     |
| marked                    | 18.1.2  | MIT     |
| cli-highlight             | 2.1.11  | ISC     |
| @types/react (dev)        | 19.3.0  | MIT     |
| ink-testing-library (dev) | 4.0.0   | MIT     |

License/version được đọc lại từ manifests thực sự cài ngày 2026-11-18;
lockfile ghi integrity và transitive resolutions. Cài với `--ignore-scripts`.
Không thêm dependency trực tiếp khác; đo độ rộng/wrap dùng string-width và
wrap-ansi qua Ink, không deep-import transitive package. `apps/tui/tsconfig.json`
bật React JSX cho subtree Ink; JSX import-source pragma trong file mới giúp
root typecheck/Bun nhận React mà không đổi renderer cũ.

## Kiến trúc và migration

1. Pha 0 tạo runtime, composition slots, một overlay router, SDK hooks,
   semantic theme adapter và UI primitives. API nội bộ version 0.1 tại
   [contracts](../delivery/tui-v3/contracts.md). Chỉ dùng public exports của
   `@futryn/sdk`/`@futryn/contracts`; reuse ThemeEngine của cùng app.
2. [ĐÃ ĐỔI 2026-11-18, Pha 3] Ink là TUI duy nhất; `FUTRYN_TUI` và renderer cũ đã bị xoá. Nội dung gốc: trong thời gian chuyển đổi, `FUTRYN_TUI=ink` lazy-load runtime mới; mọi giá trị
   khác giữ runtime cũ. Không bật Ink mặc định ở Pha 0. Non-TTY in một frame
   rồi thoát; TTY dùng scrollback thường, không alternate buffer.
3. Pha 1 giữ feature boundaries của ADR 0015 trong các React feature folders;
   bốn agent chỉ sửa vùng của mình theo contracts. Pha 2 nối slots/lifecycle,
   startup consent, auth, command routing và event-driven views.
4. Chỉ Pha 3 được đổi default và xóa renderer cũ, sau khi đạt toàn bộ parity
   trong plan (gồm permissions, questions, plan, subagents, memories, skills,
   compaction, slash commands, non-TTY, PTY và streaming performance).

Pha 0 không gửi prompt/command, không đọc workspace, tắt tools và khả năng hỏi
user cho tới khi có gate/dialogs thật. Initial command nhận diagnostic rõ ràng,
không giả thành công. Slash registry canonical vẫn do SDK sở hữu (ADR 0013).
Thứ tự transcript `parts` và kiểu trình bày từ ADR 0021/0028 được giữ cho Pha 1.

Input nền bị tắt khi overlay mở nhưng component vẫn mounted để giữ draft/state.
Shell sở hữu Esc/exit; output folding chỉ bắt Ctrl+O khi được focus. Router
không quyết định permissions: dialog phải dismiss/cancel pending SDK requests
qua lifecycle của nó. Các renderer loại terminal control bytes trước khi đưa
text vào Ink; đây không thay thế redactor/policy ở backend.

Theme adapter subscribe engine hiện có; CodeBlock dùng semantic syntax tokens
qua cli-highlight, bỏ màu ở terminal capability `none`. Markdown là marked GFM
render thành Ink nodes, không HTML execution hay link opening. Markdown/code/diff
có bounds và marker truncation để tránh render vô hạn từ output lớn.

## Nguồn và giới hạn

- Ink source/docs: <https://github.com/vadimdemedes/ink>, bản cài **8.0.0**,
  `build/{render,render-to-string}.d.ts`, `package.json` inspected 2026-11-18.
  Context7 `/vadimdemedes/ink` API docs truy cập cùng ngày: render options,
  useInput, non-interactive rendering. Docs rolling không phải pinned revision;
  type declarations bản cài là nguồn kiểm chứng API dùng ở đây.
- React: <https://github.com/facebook/react>, bản cài **19.3.1**;
  marked: <https://github.com/markedjs/marked>, **18.1.2**;
  cli-highlight: <https://github.com/felixfbecker/cli-highlight>, **2.1.11**;
  ink-testing-library: <https://github.com/vadimdemedes/ink-testing-library>,
  **4.0.0**. Manifests/license tại các version này inspected 2026-11-18.
- Bun **1.4.4**, Darwin arm64: fixture render thật qua Ink/React/Yoga, keyboard
  input và subprocess non-TTY. Không dùng mock-success làm chứng cứ OS/provider.
  Real TTY/resize teardown trên các terminal, Linux/Windows và live provider:
  **Needs verification** ở các pha sau.

## Hệ quả

Có hai renderer trong giai đoạn migration và thêm React/Yoga/transitive graph.
Pha 0 giữ golden cũ để phát hiện thay đổi ngoài ý muốn. Test Ink đặt trong
subtree mới và chạy riêng bằng `bun test apps/tui/src/ink/testing`; root
`bun test tests` chưa bao phủ chúng, vì script gốc không thuộc phạm vi sửa.
Không có claims parity, authenticated-generation hay Product MVP completion.
