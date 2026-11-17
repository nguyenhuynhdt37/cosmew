# ADR 0029 — Hannes sở hữu agent; backend delegated chỉ khi opt-in

> **Cập nhật 2026-11-17:** Codex runtime (backend `codex-bridge`, fallback cho ChatGPT) đã bị bỏ hẳn; mọi provider chỉ được gọi qua API. Xem [ADR 0049](0049-remove-codex-runtime.md).

Accepted 2026-11-16 theo yêu cầu "Make Hannes a truly independent, multi-model Codex-style coding agent". Thay thế một phần [ADR 0027](0027-permission-modes-and-native-runtime-tools.md): tool native của runtime không còn bật tự động khi người dùng đồng ý cho dùng folder. Chế độ quyền và rule (ADR 0027/0028) giữ nguyên.

## Audit trước thay đổi (HEAD `3b6f89f`)

| Đường thực thi | Vòng model/tool | Chọn tool | Đọc / ghi file | Shell | Policy và sandbox | Kết quả, receipt | Huỷ, tiếp tục |
|---|---|---|---|---|---|---|---|
| A. API trực tiếp → tool Hannes | Hannes `Conversation` | model | Hannes dispatcher / `SecureFiles` | Hannes `exec_command` (production đóng) | Hannes security + workspace | Hannes (`messages`, `tool_audit`, receipts) | Hannes |
| B. Codex app-server → cầu nối dynamic tool | **Codex** (thread/turn) | model trong Codex | Hannes dispatcher | không có (shell của Codex tắt, sandbox read-only) | Hannes | Hannes ghi các bước inline | turn của Codex, signal của Hannes |
| C. Codex native (ADR 0027) | Codex | Codex | **Codex** | **Codex, danger-full-access** | Codex (Hannes chỉ trả lời yêu cầu duyệt) | Codex; Hannes không có receipt | Codex |
| D. Grok/Gemini/Copilot/Qwen native (ADR 0027) | runtime | runtime | **runtime** | **runtime, không sandbox** | runtime + rule ask/deny của Hannes | runtime | runtime |

Vấn đề: C và D được bật chỉ vì người dùng đồng ý cho dùng folder, tức là runtime ngoài âm thầm thành engine coding chính. B bị mô tả như thể Hannes sở hữu vòng lặp. Adapter còn tự validate input của tool call và làm hỏng cả lượt (`PROTOCOL`) thay vì trả lỗi cho model. Prompt của cầu nối ghi "Use only read/glob/grep" kể cả khi có `apply_patch`.

Tham chiếu upstream: openai/codex `5cb38e79842a0e0a6dca5bb97874163e8ee50129`, `core/src/tools/{orchestrator,router}.rs`, `core/src/session/turn.rs`, đọc ngày 2026-11-16. Các bất biến áp dụng: phê duyệt gắn với từng call; nâng quyền cần duyệt lại; retry có giới hạn; lỗi tham số được trả về model (`RespondToModel`); chạy tuần tự khi không rõ khả năng song song; kết quả tool đi qua history; ngắt thì kết thúc lượt.

## Quyết định

1. **`ExecutionBackend`** (`executionBackendFor`, contract 1.11 additive) cho biết ai sở hữu vòng lặp và ai sở hữu tool:
   - `hannes`: API trực tiếp. Model chỉ quyết định; Hannes chạy mọi tool dự án.
   - `codex-bridge`: Codex giữ vòng lặp, mọi tool dự án là tool Hannes.
   - `chat-only`: Grok/Gemini/Copilot/Qwen mặc định, hoặc khi chưa đồng ý dùng folder.
   - `delegated`: runtime giữ cả vòng lặp lẫn tool.

   Backend hiện trong `/status`, trên dòng meta của composer và qua lệnh `/backend`.
2. **Delegated là opt-in tường minh, từng phiên**: `/backend delegated` hoặc `setDelegatedAgent(true)`. Cần đồng ý dùng folder và một provider có runtime; API trực tiếp luôn là `hannes`. Startup chỉ chạy runtime trong workspace khi có cả hai điều kiện, và khi đó không chào mời tool Hannes song song.
3. **Đổi tài khoản hoặc provider bỏ mọi quyền đã nâng**: chế độ về `default`, tắt delegated, thu hồi session grant. Quay lại tài khoản cũ cũng không khôi phục những quyền này.
4. **Adapter chỉ chuyển đổi**: tool call sai schema hoặc tên lạ đi tới `ToolRouter`, router trả `INVALID_INPUT`/`UNKNOWN_TOOL` cho model. Adapter chỉ từ chối lỗi wire thật (trùng id, quá 32 call, quá kích thước).
5. **Hoạt động delegated luôn mang tên runtime** (`⏺ grok-build · Bash(…)`) và không bao giờ là tool call hay receipt của Hannes. Prompt của cầu nối liệt kê đúng các tool đang được chào mời.

## Ranh giới tin cậy của delegated (không phải sandbox của Hannes)

Codex chạy `danger-full-access`, Grok chạy `sandbox off`. Môi trường con kế thừa môi trường người dùng, trừ các API key. Grok có thể nạp plugin, hook và MCP của chính người dùng. Hannes chỉ thấy những yêu cầu duyệt mà runtime chọn gửi về; đọc thường của runtime không qua Hannes. Không có bảo vệ filesystem nào được Hannes cưỡng chế ở chế độ này.

## Terminal

`exec_command` của Hannes vẫn **đóng ở production** (ADR 0022/0023) cho đến khi chứng minh được cơ chế chứa (containment) ở cấp OS. `/status` báo "Terminal: Unavailable · OS containment not proven" trừ khi tool đó thật sự được chào mời. Shell của runtime delegated không được trình bày như terminal của Hannes. Unified Exec, PTY và `write_stdin` chưa được triển khai.

## Bằng chứng

`tests/end-to-end/hannes-agent-matrix.test.ts` chạy 9 kịch bản × 2 định dạng wire độc lập (OpenAI Chat Completions, Anthropic Messages) qua cùng một `Conversation`: read; search → read; read → apply_patch → read; ghi bị từ chối; cạn budget; tham số sai; lỗi provider có retry giới hạn; huỷ khi đang chờ duyệt; resume không chạy lại thao tác ghi. Các test trong `subscriptions.test.ts` kiểm: đồng ý dùng folder không bật tool native; delegated cần opt-in, đồng ý dùng folder và một runtime; đổi provider đặt lại quyền; `/backend`. Đây là bằng chứng từ fixture, không phải xác minh live.

## Khoảng cách còn lại so với Codex

Chưa có: Unified Exec/PTY/`write_stdin` và terminal production; nâng quyền/retry khi sandbox từ chối; gọi tool song song; quản lý context và compaction; hook; MCP; subagent. Subscription Grok/Gemini/Copilot/Qwen không có transport chỉ-model chính thức được ghi nhận (Needs verification), nên mặc định là `chat-only`. Codex app-server không cho Hannes sở hữu vòng lặp model, nên cầu nối là backend lai được gắn nhãn rõ.
