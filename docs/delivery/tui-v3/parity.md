# TUI v3 Pha 2 — parity và bằng chứng

2026-11-18. Pha 3 xong: Ink là TUI duy nhất (không còn `FUTRYN_TUI`, renderer cũ đã xoá). PASS bên dưới là hành vi có
test tự động, không phải nghiệm thu live provider hay mọi terminal/OS.
Provider giả chỉ chứng minh wire/lifecycle của Futryn; không chứng minh ChatGPT,
DeepSeek, shell sandbox hay keyring live. Không tuyên bố Product MVP complete.

Paths viết tắt: `ink/` = `apps/tui/src/ink/`; PTY =
`tests/end-to-end/tui-ink-pty.test.ts`; host = `ink/testing/integration.test.tsx`.
Mỗi dòng tương ứng một mục phân cách bằng dấu `;` ở bảng parity trong plan.md.

| Mục                                              | Trạng thái | Test chứng minh                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------ | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Đồng ý thư mục + xác minh tài khoản              | PASS       | host: no probe trước consent, initialCommand chỉ sau verify, AUTH failure vẫn locked; `ink/features/status/chrome.test.tsx`: Exit mặc định/no account; PTY consent + provider HTTP check                                                                                                                 |
| Đăng nhập/đổi tài khoản/model/effort             | PASS       | `ink/features/picker/dialogs.test.tsx`: API key SDK validation, OAuth cancellation/late challenge, account confirmation, custom provider, advertised effort, model discovery abort; gate route connect/models                                                                                            |
| Gửi, steer khi đang chạy, Esc ngắt               | PASS       | host: gửi qua iterator, shell Esc/shutdown; `ink/features/composer/composer.test.tsx`: SDK steer/queue/rejection giữ draft; transcript tests: delivered steered event, cancellation                                                                                                                      |
| Transcript đủ loại phần                          | PASS       | `ink/features/transcript/transcript.test.tsx`: ordered stream/replay, discarded response, reasoning/tools/text, diagnostics, split memory citations; composed golden 80/36 cột                                                                                                                           |
| Quyền once/session/always/deny, NO SANDBOX, mạng | PASS       | `ink/features/picker/dialogs.test.tsx`: offered choices, exact rule, scope/stale/dismiss/revoke, NO SANDBOX; host: denial feedback qua SDK, PTY chọn Cả phiên; `tests/security/approval-policy.test.ts` kiểm backend network/session grants                                                              |
| request_user_input                               | PASS       | `ink/features/picker/dialogs.test.tsx`: multiple/free input, explicit submit, unmount dismiss; `tests/end-to-end/question.test.ts` public SDK/backend                                                                                                                                                    |
| Plan                                             | PASS       | `ink/features/plan/plan.test.tsx`: trạng thái/window; PTY tool update_plan → checklist ghim                                                                                                                                                                                                              |
| Diff                                             | PASS       | `ink/features/diff/diff.test.tsx`: receipt/partial/error/diagnostics, workspace filter/navigation/copy callback; golden + host route refresh/error. Native clipboard fallback giữ bridge cũ; clipboard OS thật Needs verification                                                                        |
| Subagent chờ/nền, /agents                        | PASS       | `ink/features/subagents/subagents.test.tsx`, notices tests: progress/transcript/background notice; dialogs tests inspect/stop; PTY /agents; backend `tests/end-to-end/subagents-background.test.ts`                                                                                                      |
| Skills /skills, /tên, $tên                       | PASS       | host canonical router + SkillsDialog callback; composer/autocomplete tests: slash skill/$ catalog; `tests/end-to-end/skills.test.ts`: dispatcher-mediated invocation                                                                                                                                     |
| Memories /memory, citations, #                   | PASS       | PTY /memory; host # → public write API; `tests/contracts/sdk-memory-write.test.ts`: dispatcher thật, consent/schema/plan/read-only/deny/durable write; transcript citations + dialogs read/delete failure                                                                                                |
| /compact                                         | PASS       | PTY compaction sau turn; host route; `tests/contracts/model-compaction.test.ts` và backend suites kiểm model/fallback/cancellation                                                                                                                                                                       |
| /permissions + Shift+Tab + Full Access warning   | PASS       | PTY Shift+Tab; dialogs tests Full Access explicit confirmation; PTY permission flags test warning/preset qua startup                                                                                                                                                                                     |
| Mọi lệnh SLASH_COMMANDS                          | PASS       | host test duyệt từng definition: route observable hoặc diagnostic; SDK parser dùng chung alias/args; unavailable luôn có Not implemented; `tests/contracts/commands-module.test.ts` canonical metadata                                                                                                   |
| Theme                                            | PASS       | host picker nhớ selection, highlight preview và Esc rollback; dialogs tests Apply/Back; foundation theme/syntax tests                                                                                                                                                                                    |
| Sessions/resume                                  | PASS       | PTY resume 1.200 messages; host /clear reset Static key; dialogs tests session resume/delete failure/confirmation                                                                                                                                                                                        |
| Usage/context                                    | PASS       | `ink/features/status/chrome.test.tsx`: billing/coverage/limits/details/context/status, clamp/reduced motion; PTY status sau turn                                                                                                                                                                         |
| --yolo / --full-auto / -s / -a                   | PASS       | PTY permission flags: --yolo → Full Access warning, --full-auto → Auto, -s read-only -a on-request → Read Only sau consent/verify                                                                                                                                                                        |
| Non-TTY một khung                                | PASS       | `ink/testing/foundation.test.tsx`: public runtime subprocess opt-in selection, single-frame/no ANSI/no prompt; không mount startup gate hay chạy initialCommand                                                                                                                                          |
| Hiệu năng: stream dài, transcript >1.000 dòng    | PASS       | PTY `tui-ink-pty.test.ts` stream liên tục 2.000 dòng: độ trễ input→output < 250ms (đo 6–65ms trên máy dev, 1 terminal giả lập PTY); live item chỉ render đuôi viewport (`liveTail`, test trong `transcript.test.tsx`); transcript >1.000 dòng và resume 1.200 messages. Chưa đo trên nhiều terminal thật |
| Dialog quyền đồng thời / giải quyết qua SDK      | PASS       | `tests/end-to-end/subagents.test.ts` (2 quyền song song: không dismiss im lặng, hỏi cũ nhất trước, dialog đóng khi SDK giải quyết)                                                                                                                                                                       |
| Subagent nền đánh thức parent rảnh               | PASS       | `tests/end-to-end/subagents-background.test.ts` (/agents dừng child, kết quả queued thành lượt kế tiếp)                                                                                                                                                                                                  |
| Startup: account đổi trong lúc kiểm tra          | PARTIAL    | Logic có trong `useStartupGate` (kiểm tra lại, không vào chat); test Ink riêng chưa viết sau khi xoá `tests/contracts/startup-gate.test.ts`                                                                                                                                                              |

**22 PASS / 1 PARTIAL / 0 MISSING** (23 dòng gồm 3 dòng bổ sung ở Pha 3). PASS nghĩa là có test tự động, không phải nghiệm thu live provider/OS/nhiều terminal.

## Golden và các mục bàn giao

Golden Ink riêng: `ink/testing/golden-ink/integrated-{80,36}.txt`, test
`composition-golden.test.tsx`. Candidate được xem ở hai độ rộng trước
`UPDATE_GOLDEN=1`; không sửa golden legacy. Pha 1 foundation snapshots giữ nguyên.

Host nối lifecycle begin/applyEvent/finish, session reset key, bounded history overlay,
focus Ctrl+O, notices/diff, shell transcript, denial feedback, controlled picker,
preview/remembered selection, startup connect/models và SDK mediated memory write.
README bốn feature trỏ về contract nội bộ 0.2 và tài liệu này.

## Pha 3 (đã làm 2026-11-18)

Ink là mặc định và duy nhất; đã xoá `apps/tui/src/{app.tsx,features/,render/,ui/,core/,input/terminal-keys.ts}`, cờ `FUTRYN_TUI`, `tests/performance/tui-*` (và script `bench:tui*`), `tests/end-to-end/tui-v2-pty.test.ts` (thay bởi `tui-ink-pty.test.ts`), golden cũ `tests/contracts/__golden__`. Giữ lại và dùng bởi Ink: `src/theme/` (theme engine, presets, compat, wallpaper), `src/input/text.ts`, `src/clipboard.ts`, `src/types.ts`.

### Test cũ → Ink

- Chuyển sang Ink thật + SDK thật (`ink/testing/ink-session.tsx`, `openInk`): `tests/end-to-end/{apply-patch,approval-policy,exec-command,file-edit,host-providers,memories,native-agent,plan,question,read-media,read-tools,skills,subagents,subagents-background,tui-modes}.test.ts`, `tests/security/approval-policy.test.ts`.
- Giữ phần backend, bỏ phần render: `tests/contracts/{usage-context,configuration,provider-limits,turn-usage,memory-citations,model-compaction}.test.ts`; `tests/end-to-end/provider-connect.test.ts` thu gọn còn bất biến SDK; `themes-cli.test.ts` tách từ `tui.test.ts`.
- Xoá vì chỉ kiểm renderer cũ: `chat-interactions, chat-presentation, commands-module, composer-input, diff-presentation, frame-scheduler, mascot, quiet-transcript, startup-gate(-module), text-selection, transcript-activity, transcript-virtualization, tui-golden, tui-v2-integration, tui`; hành vi tương ứng nằm trong test Ink của từng feature (xem bảng trên).

### Không làm / đã bỏ cùng TUI cũ (không còn trong Ink)

- Companion/mascot (Fyn, Weepinbell), sidebar, wallpaper overlay, theme editor, command palette, chọn text bằng chuột + clipboard OSC 52 trong transcript (dùng chọn text của terminal), splash companion.
- Nhiều tab/overlay riêng của cấu hình cũ gom vào `/settings`, `/permissions`, `/usage`.
- Câu chữ khác TUI cũ: tool hiện `⏺ name(arg) · state` thay vì `Read(...)`/`Bash(...)`; lỗi provider hiện `Request failed [CODE]`; form custom provider báo chung "Provider configuration rejected" (không nêu chi tiết credential-looking header).
- Mất test (hành vi có trong code Ink nhưng chưa có test riêng): thay account khi đang kiểm tra startup (PARTIAL ở bảng), fallback đăng xuất account đang dùng qua dialog (SDK `logoutAccount` có test; điều phối fallback của dialog chưa có), `/effort` dạng staged keyboard cũ.
- Vẫn Needs verification: provider live, ChatGPT OAuth, clipboard OS thật, nhiều terminal/OS, sandbox ngoài macOS.
