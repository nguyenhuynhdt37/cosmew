# ADR 0060 — Ink TUI integration và SDK memory write

Accepted 2026-11-18. Tiếp nối ADR 0059, 0013–0015 và 0057.
Pha 3 (cùng ngày) đã đổi mặc định sang Ink và xoá renderer cũ; `FUTRYN_TUI` không còn. Nội dung dưới đây mô tả Pha 2.
Không thêm dependency, không đổi schema persistence hoặc policy.

## Composition và lifecycle

`InkApp` dùng IntegratedShell khi không inject slots. Shell giữ startup gate sống
suốt phiên, chỉ mở composer sau consent và account generation probe thành công;
không có account/probe thất bại → connect/models rồi kiểm lại. Non-TTY chỉ render
preview một khung, không mount gate, không gửi initial command.

Một host sở hữu turn AbortController, iterator SDK, steering/queued input, shell
output, pending permission/question routing, command tasks và shutdown. Esc đóng
UI/dismiss SDK request, huỷ composer search/shell hoặc turn. Ctrl+C/SIGINT/SIGTERM
huỷ và drain tác vụ trước cleanup Ink; CLI vẫn sở hữu backend. Dialog không cấp
quyền ngoài SDK; denial reason đi qua submitWhileBusy, báo rõ khi bị từ chối.

Transcript settled vào Static; session/reset đổi historyKey. Ctrl+O mở inspection
page độc lập (8 messages), PgUp/PgDn/Home/End paging, ↑↓ focus activity; chỉ vùng
đang focus được expand. Composer luôn mounted, input nền bị khoá khi overlay mở.
Router canonical dùng SDK parseSlashCommand/SLASH_COMMANDS; backend chưa hỗ trợ
in Not implemented, không giả thành công. Dialog tự có Panel, không lồng frame.
Picker controlled cursor/onHighlight phục vụ permission numbering và theme
preview; selection nhớ theo title trong session, settings nhớ section.

## SDK contract 1.35

Thêm `client.writeMemory(entry: MemoryWrite): Promise<ToolResult>`; schema public
đã có, không thêm tool hay capability. API yêu cầu consent, chat và idle, validate
metadata trước port; backend gọi **memory tool qua ToolDispatcher** với action write.
Read-only, plan/review và project deny vẫn từ chối; audit/redactor giữ nguyên.
Port memoryAction nhận union `read|delete|write`, optional entry cho write.
Consumers read/delete không đổi hành vi. CLI composition root phải được nối thêm
entry: chỉ sửa SDK không thể đưa write tới dispatcher thật. Đây là thay đổi ngoài
vùng Ink bắt buộc cho mục #memory; không sửa core/security/tools.

`#text` tạo name `note-<random>`, type feedback, description lấy dòng đầu đã gộp
whitespace (≤300), content nguyên note (SDK/tool enforce size/secrets). Chỉ xoá draft
khi ToolResult ok. Không ghi file trực tiếp và không gửi note như chat prompt.

## Evidence và giới hạn

[Parity](../delivery/tui-v3/parity.md) gắn từng mục với test.
PTY dùng Bun.Terminal thật và provider HTTP fixture, không chứng minh live provider
hoặc OS sandbox execution. Golden Ink mới được xem candidate 80/36 cột trước
UPDATE_GOLDEN; golden legacy giữ nguyên. Visual acceptance đa terminal, live
ChatGPT/DeepSeek và Linux/Windows: Needs verification; không tuyên bố Product MVP complete.
Nguồn API: source pinned Ink 8.0.0 `build/hooks/use-{input,paste}.js`,
`build/components/App.js`, React 19.3.1; inspected 2026-11-18. Không suy diễn rolling upstream.

## Pha 3 — bổ sung khi chuyển mặc định (2026-11-18)

- Dialog quyền: host không bao giờ thay một dialog còn pending bằng dialog khác (thay = dismiss = từ chối im lặng); hỏi yêu cầu cũ nhất trước; dialog đóng khi quyền được giải quyết qua SDK ở nơi khác.
- Khi parent rảnh, kết quả subagent nền `queued` được lấy bằng `takeQueuedMessage` và gửi thành lượt kế tiếp (parity với TUI cũ / Codex).
- Live item chỉ render phần đuôi theo viewport khi đang stream (độ trễ nhập < 250ms trong PTY 2.000 dòng); item hoàn tất giữ đủ nội dung.
- Shift+Tab từ cấu hình `custom` vào Auto trước, cùng thứ tự `cyclePermissionPreset` của SDK; non-TTY in cảnh báo Full Access.
- Test hành vi backend dùng `ink/testing/ink-session.tsx` (Ink thật + SDK thật, không PTY).
