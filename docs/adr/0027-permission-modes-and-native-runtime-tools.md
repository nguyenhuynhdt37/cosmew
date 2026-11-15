# ADR 0027 — Chế độ quyền và tool native của runtime subscription

> **Thay thế một phần bởi [ADR 0029](0029-hannes-owned-agent-and-delegated-backends.md) (2026-11-16):** tool native của runtime không còn tự bật khi người dùng đồng ý cho dùng folder; đó là backend `delegated`, chỉ bật bằng opt-in tường minh (`/backend delegated`). Chế độ quyền và cách định tuyến yêu cầu duyệt bên dưới vẫn còn hiệu lực.

Accepted 2026-11-15 theo yêu cầu của người dùng: subscription runtime phải thực thi được trong dự án ("ko thể thực thi"), cái cần chặn thì chặn nhưng hiện thông báo để cho phép, với nhiều chế độ như Claude Code (bypass, auto, …). Thay thế một phần ADR 0008 (chặn mọi tool của runtime), ADR 0018 (Codex chỉ qua cầu nối read/glob/grep) và phần chat-only của ADR 0026.

## Chế độ quyền

`PermissionMode` (contract 1.11, `@hannes/contracts`): `default`, `acceptEdits`, `auto`, `plan`, `bypassPermissions`. Chế độ áp dụng cho từng phiên, không lưu xuống đĩa, mỗi phiên bắt đầu ở `default`. Đổi bằng Shift+Tab (thứ tự default → acceptEdits → auto → plan → bypassPermissions) hoặc `/permissions <mode>`. Chế độ hiện ở chip của composer.

Chế độ chỉ trả lời các quyết định `ask`. Các luật `deny` không bao giờ đổi: đường dẫn ngoài workspace, `.git`, thư mục state của Hannes.

| Loại yêu cầu | default | acceptEdits | auto | plan | bypassPermissions |
|---|---|---|---|---|---|
| đọc thường | allow | allow | allow | allow | allow |
| file bí mật (`.env`, key, `~/.ssh`…) | ask | ask | ask | ask | allow |
| sửa file | ask | allow | allow | deny | allow |
| chạy lệnh | ask | ask | allow | deny | allow |
| mạng / tool khác | ask | ask | ask | ask | allow |

`FutrynClient.requestPermission` áp dụng bảng này trước khi tạo prompt, vì vậy tool của Hannes (`ToolDispatcher`) và tool native của runtime dùng chung một cơ chế. Chế độ không bỏ qua bước audit, đánh giá policy hay kiểm tra lại của dispatcher.

## Tool native của runtime

Sau khi người dùng đồng ý cho dùng folder trong phiên (consent), runtime chạy trong workspace thật với tool của chính nó (`SubscriptionRecipe.workspace`). Môi trường con là môi trường của người dùng, trừ các API key có thể bỏ qua subscription. Credential vẫn chỉ lấy từ profile riêng. Mọi yêu cầu quyền mà runtime gửi về client đều thành prompt của Hannes và được quyết theo chế độ:

- **Grok Build**: chạy `grok agent --no-leader stdio`, không `--always-approve`, sandbox `off`. Rule `ask` cho các đường dẫn bí mật; rule `deny` cho `~/.hannes/**` và sửa `.git`. Yêu cầu tới qua ACP `session/request_permission`.
- **Codex**: sandbox `danger-full-access`, tham số thread/turn `approvalPolicy: "untrusted"`. Codex 0.167 không còn nhận khoá này trong `config.toml`, nên chỉ đặt qua tham số API. Duyệt qua `item/commandExecution|fileChange/requestApproval`. Cầu nối Hannes (ADR 0018) vẫn còn khi `nativeRuntimeTools: false`.
- **Copilot** (`requestPermission: true`, không đặt `availableTools`), **Gemini/Qwen** (bỏ giới hạn core tools, vẫn ACP): cùng một cách định tuyến. Chưa kiểm chứng live.

Khi chưa có consent, runtime vẫn chat-only như ADR 0008. Một yêu cầu bị từ chối hiện dòng `▸ denied: …`. Nếu runtime tự kết thúc lượt (Grok trả `stopReason: cancelled`), Hannes ghi "Permission denied … Not run." thay vì báo lỗi giao thức.

## Bằng chứng và giới hạn

- Fixture: `tests/end-to-end/subscriptions.test.ts` (Grok/Codex native: default → prompt và deny, plan → refuse, auto → chạy trong workspace; chưa consent → fail closed; bảng chế độ; Shift+Tab và `/permissions`).
- Live 2026-11-15, tài khoản thật của người dùng, thư mục scratch: Grok 4.7 và Codex `gpt-6-luna` ở `auto` đều chạy được lệnh shell và tạo file; ở `default` mỗi bên hiện một prompt `process.execute`, khi bị từ chối thì không có file.
- Sandbox kernel `strict` của Grok từ chối khởi động trên máy có `/var/run/docker.sock` là symlink (OrbStack), nên không dùng. Tool đọc native của runtime tự đọc được mọi nơi máy cho phép; Hannes chỉ thấy những lần đọc khớp rule `ask` hoặc `deny`.
- Với HOME thật, Grok nạp plugin, hook và MCP mà người dùng đã cài (quan sát được: MCP mongodb, hook hookify). Đây là cấu hình riêng của người dùng, không phải của Hannes.
- File do runtime sửa không phải receipt của `apply_patch` Hannes: không có diff preview ở prompt, chỉ có lệnh hoặc nhãn mà runtime gửi.
