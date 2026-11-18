# Composer — Pha 1

Phạm vi implementation: `composer`, `autocomplete`, `history`, `paste`. Không
thay SDK, dispatch/policy, composition root, keymap, dependency hay renderer cũ.

## Nối vào Pha 2

- `Composer(props)` là component tự giữ state. Props bắt buộc `onSubmit(content)`;
  tuỳ chọn `onCommand`, `onRemember`, `busy`, `workspaceAccess`, `isActive`,
  `initialValue`, `initialHistory`, `width`, `maxRows`, `placeholder`,
  `onShellResult`, `onShellOutput`, `onNotice`, `onEmptyHomeEnd`.
- Khi cần điều phối Esc, dùng `useComposer(options)` +
  `ComposerView({controller, width?, maxRows?, placeholder?, isActive?})`.
  Hook trả `draft`, `content` đã mở paste, `setDraft`, `history`, `search`,
  `items`, `selected`, `notice`, `busy`, `submit`, `paste`, `interrupt`.
- Host kiểm consent/auth trước khi cho phép input, đặt `busy` đúng vòng đời turn,
  đăng ký consumers trước khi gọi SDK. `onSubmit` bắt đầu iterator
  `client.sendMessage` ở host và trả ngay khi chấp nhận; `false` giữ draft.
  Callback không nên await toàn bộ generation. Error giữ draft và chỉ báo mã
  lỗi, không đưa exception/provider output thô lên UI.
- `onCommand` nối command router hiện có (canonical registry SDK, bao gồm mọi
  slash/alias, arguments và unsupported diagnostic). Skill slash dùng `onSubmit`
  để SDK tự mediated invocation. Host tiếp tục sở hữu shortcut commands,
  Shift+Tab permissions, Ctrl+O transcript, Ctrl+C/exit và scroll Home/End.
  `onEmptyHomeEnd` cho phép chuyển Home/End ở draft rỗng sang transcript.
- Shell là chủ sở hữu Esc theo contract 0.1: `InkApp.onInterrupt` gọi
  `controller.interrupt()` trước; nếu trả `false` và host đang chạy generation,
  abort controller của host. Composer tự abort shell do nó tạo khi interrupt
  hoặc unmount. Không đăng ký Esc thêm trong composer.
- `!command` gọi đúng `client.runShellCommand` với AbortSignal, không launch
  process. Nối `onShellOutput`/`onShellResult` vào transcript Bash card. Shell
  result denied/error được báo đúng và giữ draft; result ok được đưa vào history.
  `sessionId` báo process còn chạy, host phải hiển thị và thu bằng luồng hiện có.
- `workspaceAccess` chỉ bật sau consent: SDK `listWorkspaceFiles(query)` hiện
  không tự kiểm toolsEnabled. Không gọi khi render; danh sách memo theo query.
  Overlay giữ mounted state và tắt cả phím/paste theo `InputScope`.
- `Autocomplete({items, selected?, visibleRows?, width?})`, `useAutocomplete`,
  `completionContext`, `getCompletions` export từ `autocomplete/index.tsx`.
  `/` dùng `SLASH_COMMANDS` (kể cả aliases, unavailable/shortcut metadata) +
  skills SDK; `@` dùng public file-list API; `$` chỉ dùng catalog skills.
- `History({query, match?, width?})`, `useHistory`, `recordHistory`,
  `searchHistory` export từ `history/index.tsx`.
- `Paste({id, content, width?})`, `usePasteState` và range helpers export từ
  `paste/index.tsx`. Paste >=5 dòng hoặc >=1000 ký tự thu thành marker, vẫn gửi
  đủ nội dung đã lọc terminal controls. Marker do user tự gõ luôn giữ literal.
  Phím di chuyển/xoá coi mỗi paste thu gọn là một đơn vị, không thể gửi mảnh marker.

## Hành vi và các giới hạn API

Viền bo, placeholder, caret, selection Shift+←/→, xoá/thay selection,
Backspace/Delete, grapheme Unicode, Home/End/Ctrl+A/E, Ctrl+K/U/W, Alt+←/→,
Shift+Enter, `\`+Enter, Alt+Enter/Ctrl+J. ↑/↓ đi theo hàng hiển thị rồi tới
history ở biên; draft trước history được khôi phục nguyên paste metadata.
Ctrl+R tìm ngược và lặp để tìm cũ hơn, Enter phục hồi không tự gửi,
Ctrl+G hoặc host Esc huỷ. Menu cuộn theo selection; Tab nhận, Enter file/skill
mention nhận vào draft; Enter slash giữ hành vi canonical cũ. Hints dùng KEYMAP.
Màu lấy theme capability; text từ metadata/history/paste lọc terminal controls.
Wrap theo cell/CJK/grapheme, giữ tối đa 6 hàng quanh caret; resize reflow,
width <6 dùng plain truncated view. Draft/layout/completions memo theo input,
không quét file mỗi token stream.

- SDK không có kho command history riêng. Hook seed từ user messages của
  `activeSession()` (bao gồm durable recovered session), giữ tối đa 100 bản ghi
  không trùng trong mount. Host có thể truyền `initialHistory`. Chưa có lịch sử
  shell/slash bền qua restart; cần SDK/persistence API riêng nếu muốn đủ parity.
- SDK chỉ có memory read/delete, chưa có public mediated write. `#note` giữ draft
  và báo `Not implemented` nếu thiếu `onRemember`; không giả thành một prompt đã
  ghi nhớ, không ghi filesystem trực tiếp. Đề xuất SDK expose `writeMemory` qua
  cùng dispatcher/mutation policy, rồi host nối callback với input metadata rõ.
- Ink 8 có `usePaste` tách bracketed paste khỏi `useInput`. Feature dùng native
  hook này + `useInputEnabled` của pha 0, không gắn listener stdin riêng. Đề xuất
  pha 0 bọc thành `useTextPaste` nếu muốn mọi input API tập trung trong hooks.
- `submitWhileBusy` dùng SDK thật, draft chỉ xoá khi steered/queued được chấp nhận;
  reject/journal failure giữ nguyên. Host phải drain `takeQueuedMessage()` khi
  generation kết thúc và giữ nguyên lifecycle session/cancellation hiện có.
- Fixture test không chứng minh live provider/OS sandbox. Terminal thật,
  startup gate, tổng thể transcript, raw-mode teardown cần nghiệm thu Pha 2.

## Kiểm thử

`bun test apps/tui/src/ink/features/composer apps/tui/src/ink/features/autocomplete apps/tui/src/ink/features/history apps/tui/src/ink/features/paste`

Dùng helper `ink/testing` + ink-testing-library, SDK thật trên ports fixture;
không có network/process thật. Các ca giữ draft khi thất bại, consent, SDK
steer/queue, AbortSignal shell/unmount, Unicode edits, selection, resize,
paste literal/control-safety, overlay input scope, commands/skills/files/history.
Nguồn API Ink kiểm tại bản cài 8.0.0 `build/hooks/use-{input,paste}.d.ts/.js`,
`build/components/App.js`, ngày 2026-11-18. Context7 lookup cùng ngày thất bại
`fetch failed`; không dựa rolling docs để suy đoán API.

Kết quả Pha 1 (2026-11-18): 33 tests / 112 assertions pass trong 5 file;
`bun run typecheck` pass; Prettier check cho bốn vùng pass. `bun run lint`
bị chặn tại `features/picker/dialogs.test.tsx:22` (TS6133: biến `model`
không dùng, ngoài vùng sở hữu); không sửa file đó. Không chạy toàn suite,
không commit/push.

## Pha 2 integration (2026-11-18)

Các mục nối host ở trên được triển khai trong `ink/integrated-shell.tsx` và runtime,
router `ink/features/commands.ts`; API nền version 0.2 trong
[contracts](../../../../../../docs/delivery/tui-v3/contracts.md).
Evidence từng luồng và giới hạn tại
[parity](../../../../../../docs/delivery/tui-v3/parity.md),
`ink/testing/integration.test.tsx`, `tests/end-to-end/tui-ink-pty.test.ts` và
`tests/contracts/sdk-memory-write.test.ts`. Default/golden legacy không đổi.
