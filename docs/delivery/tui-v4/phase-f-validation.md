# Pha F — validation 2026-11-19

Không dependency mới, không sửa `packages/**`, không commit. Kết quả fixture không
chứng minh provider/OS/upstream live. Coordinator cung cấp baseline ngoài sandbox:
949 PASS / 6 SKIP / 1 FAIL; test fail là trust settings chọn nhầm số `3` (deny)
thay vì `2` (always) sau khi chỉ đánh số scope thực sự được SDK cấp.

## Kiểm chứng thay đổi

- Regression default/Auto: đã thấy RED khi mặc định là Auto và khi đọc appearance
  macOS; GREEN sau sửa. Saved Light/Auto vẫn được giữ; sửa option appearance khác
  không đưa default Dark trở lại Auto.
- Regression inline 80×12: đã thấy RED khi pending Read bị ẩn; GREEN sau sửa,
  giữ choices, denial input, input focus và trả composer về sau khi giải quyết.
- Question và Help picker giữ transcript, không hiện composer/spinner; đóng picker
  phục hồi draft. Luồng thật của host chạy trên SDK fixture, không HTTP/provider.
- Stream thường (không debug): sau trả lời permission rồi mở/đóng Help, answer và
  tool không replay vào Static; không có erase display/scrollback (`CSI 2J/3J`).
- Process con `FORCE_COLOR=3` kiểm ANSI RGB foreground/background, không chỉ text:
  accent, dim, success/error/warning, ba mode, permission title/rule, menu, diff,
  prompt user. Golden permission 80/36 đã review candidate rồi `UPDATE_GOLDEN=1`.
- Resize: test 16 consumer thấy RED với 17 listener; GREEN với một subscription
  chia sẻ, resize 80→36 đúng và unmount trả listener count về 0.
- E2e `approval-policy.test.ts` đã chạy riêng: 4 FAIL đều `EADDRINUSE` ở HTTP
  fixture trước TUI; cần coordinator chạy lại ngoài sandbox. Các assertion rule
  và pending request sau duyệt được giữ, thêm kiểm label always ở số 2.

## Full-suite cần chạy lại ngoài sandbox

Lần `bun test tests` trong sandbox trước lượt kiểm ổn định cuối: 447 PASS / 5 SKIP /
298 FAIL. Danh sách file và số ca thất bại bên dưới để coordinator rerun; không coi
các ca này là PASS. Các lỗi native/runtime/process/watch cần host xác minh, không
thay bằng mock success hoặc nới invariant.

| File | FAIL | Dấu hiệu |
| --- | ---: | --- |
| `tests/security/provider-failures.test.ts` | 14 | EADDRINUSE |
| `tests/security/web-fetch.test.ts` | 3 | EADDRINUSE |
| `tests/security/exec-command.test.ts` | 5 | native sandbox/process/watch (cần host) |
| `tests/security/process-supervision.test.ts` | 9 | native sandbox/process/watch (cần host) |
| `tests/security/claude-sandbox.test.ts` | 11 | native sandbox/process/watch (cần host) |
| `tests/security/provider-oauth.test.ts` | 3 | EADDRINUSE |
| `tests/security/native-exec.test.ts` | 14 | native sandbox/process/watch (cần host) |
| `tests/security/native-path-hardening.test.ts` | 7 | native sandbox/process/watch (cần host) |
| `tests/security/subagent-worktree.test.ts` | 1 | native sandbox/process/watch (cần host) |
| `tests/security/sandbox-proxy.test.ts` | 6 | native sandbox/process/watch (cần host) |
| `tests/security/native-host-env.test.ts` | 1 | native sandbox/process/watch (cần host) |
| `tests/contracts/provider-limits.test.ts` | 2 | EADDRINUSE |
| `tests/contracts/usage-context.test.ts` | 7 | EADDRINUSE |
| `tests/contracts/user-shell-history.test.ts` | 1 | EADDRINUSE |
| `tests/contracts/configuration.test.ts` | 2 | EADDRINUSE |
| `tests/contracts/provider-adapters.test.ts` | 21 | EADDRINUSE, native sandbox/process/watch (cần host) |
| `tests/contracts/process-observer.test.ts` | 1 | native sandbox/process/watch (cần host) |
| `tests/end-to-end/deepseek.test.ts` | 4 | EADDRINUSE |
| `tests/end-to-end/chatgpt-oauth.test.ts` | 16 | EADDRINUSE |
| `tests/end-to-end/conversation-recovery.test.ts` | 23 | EADDRINUSE |
| `tests/end-to-end/progressive-exploration.test.ts` | 19 | EADDRINUSE |
| `tests/end-to-end/exec-command.test.ts` | 7 | EADDRINUSE |
| `tests/end-to-end/file-edit.test.ts` | 2 | EADDRINUSE |
| `tests/end-to-end/tui-modes.test.ts` | 10 | EADDRINUSE |
| `tests/end-to-end/host-providers.test.ts` | 8 | EADDRINUSE |
| `tests/end-to-end/uat-driver.test.ts` | 2 | EADDRINUSE |
| `tests/end-to-end/approval-policy.test.ts` | 4 | EADDRINUSE |
| `tests/end-to-end/provider-connect.test.ts` | 1 | EADDRINUSE |
| `tests/end-to-end/read-media.test.ts` | 5 | EADDRINUSE |
| `tests/end-to-end/web-search.test.ts` | 8 | EADDRINUSE |
| `tests/end-to-end/apply-patch.test.ts` | 6 | EADDRINUSE |
| `tests/end-to-end/plan.test.ts` | 1 | EADDRINUSE |
| `tests/end-to-end/lsp.test.ts` | 5 | native sandbox/process/watch (cần host) |
| `tests/end-to-end/question.test.ts` | 8 | EADDRINUSE |
| `tests/end-to-end/project-context.test.ts` | 11 | EADDRINUSE |
| `tests/end-to-end/provider-cli.test.ts` | 14 | EADDRINUSE |
| `tests/end-to-end/native-agent.test.ts` | 1 | EADDRINUSE |
| `tests/end-to-end/read-tools.test.ts` | 6 | EADDRINUSE |
| `tests/end-to-end/headless-exec.test.ts` | 7 | EADDRINUSE |
| `tests/end-to-end/tui-ink-pty.test.ts` | 4 | EADDRINUSE |
| `tests/end-to-end/hannes-agent-matrix.test.ts` | 18 | EADDRINUSE |

Bốn ca của file e2e đã sửa (đều chưa qua bước bind port):

- default mode: `bun test` and `rm -rf` run in the sandbox without a prompt; a workspace edit asks
- acceptEdits approves the workspace edit without a prompt
- default mode in the real Seatbelt sandbox: rg runs without a prompt and cannot write outside the workspace
- a repository settings file that loosens something is offered in the TUI; approving it by content applies its rules

Chưa xác minh: màu/shimmer khớp terminal thực của người dùng, revision upstream,
provider đăng nhập thật. Mã màu mục tiêu **Needs verification against Claude Code**.
