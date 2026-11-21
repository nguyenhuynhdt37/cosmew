# Pha E — bằng chứng và vòng sửa sau nghiệm thu

Ngày 2026-11-19. Không thêm dependency, không sửa `packages/**`, không commit.
Fixture chứng minh hành vi UI/SDK; không thay thế xác minh provider/OS thật.

## Kết quả ngoài sandbox do coordinator cung cấp

**936 PASS / 6 SKIP / 6 FAIL** trong `bun test tests apps`, trước vòng sửa này.
Nguồn: báo cáo coordinator trong yêu cầu vòng sửa; agent không tự chạy được ngoài
sandbox. 298 lỗi của lần chạy sandbox trước là lỗi môi trường theo coordinator;
không dùng con số đó làm kết quả toàn suite trên host.

Sáu ca còn lại và phân loại sau điều tra:

| Test | Nguyên nhân | Sửa |
| --- | --- | --- |
| `exec-command.test.ts`: !command/approval/sandbox | Lỗi sản phẩm: metadata chiếm preview, che stdout; dư duration và success notice | Preview Bash chỉ lấy phần output của envelope dispatcher; exit khác 0 có `Error: Exit code N`; Ctrl+O giữ toàn bộ content. Bỏ duration row và success notice lặp |
| `read-tools.test.ts`: .env/Esc/redaction | Sản phẩm còn heading thô/filter/counter; assertion cũng giả định sai chỉ có 3 lựa chọn | Heading `Read file`, reason/risk mờ dưới target, không filter/count, footer `Esc to cancel`. Test kiểm đủ 4 scope thực tế trước Esc và vẫn kiểm không lộ secret |
| `tui-ink-pty.test.ts`: CLI permission flags | Text-only: footer bypass mới khác chuỗi test cũ | Chờ `bypass permissions on (shift+tab to cycle)`; thêm host test xác nhận SDK vẫn ở bypass và giải quyết ask không mở prompt; các test mode matrix vẫn chạy |
| `tui-modes.test.ts`: review/aliases/help | Text-only: help chuyển sang tab | Kiểm `[All] Keyboard Commands`, giữ các assertion không đọc project chưa duyệt và canonical aliases |
| `approval-policy.test.ts`: repository settings trust | Lỗi helper: chờ composer trong khi dialog trust hợp lệ thay composer; heading đổi có chủ đích | Helper chờ public SDK `userInputReady()`, không tự grant/dismiss. Test giữ duyệt chính xác nội dung/rule bằng lựa chọn always và kiểm pending hết sau duyệt; heading mới `Trust settings` |
| `project-context.test.ts`: PTY refresh/exit | Text/interaction-only: dòng 228 vẫn gửi một Ctrl+C, rồi timeout exit trả -1 | Giữ toàn bộ once-only/refresh/context assertions; kiểm hint sau Ctrl+C đầu và process còn sống, gửi Ctrl+C thứ hai rồi kiểm exit 0 |

Không phát hiện hồi quy hành vi bypass: SDK/dispatcher mode matrix và host fixture
kiểm secret/command/edit vẫn giữ quyền của mode. CLI PTY thật sau sửa cần coordinator
chạy lại vì HTTP fixture không bind được trong sandbox này.

## Sửa presentation bổ sung

- Footer mode, `? for shortcuts`, bảng shortcuts và thông báo tạm thụt 2 cells;
  context warning giữ canh phải trong vùng đã thụt.
- Description của menu slash/@/$ wrap theo từ và cell, tối đa 2 dòng rồi `…`;
  chỉ một từ dài hơn cả cột mới cần chia ở grapheme boundary.
- Trust paragraph wrap rõ theo chiều rộng: không có whitespace đầu dòng thừa.
  Có dòng trống trước options và footer; consent/billing chung một block mờ.
  Default No/exit, kiểm account, consent theo phiên và thu hồi khi unmount giữ nguyên.
- Permission vẫn dùng đúng các scope SDK cấp, number keys, default deny, diff đề xuất,
  NO SANDBOX, Ctrl+X revoke và denial feedback. Picker thực sự lọc vẫn có filter/counter.
- Bash chỉ bỏ envelope có đủ dấu hiệu `Wall time` và `Output capture` trước marker
  `Output:`; không xoá text giống metadata do chương trình thực sự in ra. Stdout/stderr
  sau marker giữ thứ tự; error heading đỏ, payload/receipt bền vững không đổi.

## Kiểm thử trong sandbox sau vòng sửa

- `bun run format`: PASS.
- `bun run typecheck`: PASS.
- `bun run lint`: PASS (unused checks, Prettier, `git diff --check`).
- `bun test apps`: **204 PASS / 2 SKIP / 0 FAIL**, 6 snapshots; native synthetic PTY
  cũng PASS. Đây là kết quả local sau sửa; không phải kết quả full suite ngoài sandbox.
- Sáu file e2e được yêu cầu cộng `tests/security/permission-modes.test.ts`:
  **30 PASS / 42 FAIL**. Cả 42 FAIL là `EADDRINUSE` khi tạo HTTP fixture, trước
  bước tương tác cần kiểm; 30 test mode/security PASS.
- Targeted transcript/autocomplete/trust/footer/picker: **84 PASS / 1 SKIP / 0 FAIL**
  (7 file, 505 assertions). Golden 80/36 và 6 primitive snapshots vẫn PASS; vòng sửa
  này không re-record golden.

Các regression thêm: metadata vs output thật và expanded content cho cả exec/stdin;
không duration row; shell success không footer/notice lặp; Read heading/target/reason/
choices/footer; word wrapping; trust spacing 80/36; settings dialog không tự grant;
launch bypass không prompt; chiều cao composer đo giữa hai Rule, vẫn kiểm cell width.
Ngưỡng input latency PTY và các assertion scope/denial/redaction/ordering/once-only/
không tool trước consent không bị bỏ.

### Sự cố sửa file test và phục hồi

Trong vòng sửa agent ghi nhầm nội dung status vào `composer/composer.test.tsx`.
Đã phục hồi 20 test của committed baseline, áp lại expectations v4 và dựng lại 7 ca
v4 (mode prefixes, shortcuts, undo/paste/stash, stash collision, double Esc/exit,
model/task/native bridge keys, effort/streaming rejection), thêm 1 ca shell success.
28 ca composer đều được giữ chạy; không skip để làm suite xanh. Bản chưa commit của
phase C không có backup xác nhận trong ngữ cảnh hiện tại; agent đã hỏi coordinator
về bản lưu để có thể đối chiếu/phục hồi nguyên văn. Đây là phục hồi coverage, chưa
phải chứng minh file giống nguyên văn trước sự cố.

## Coordinator cần chạy lại

```sh
bun run typecheck
bun run lint
bun test tests/end-to-end/exec-command.test.ts tests/end-to-end/read-tools.test.ts tests/end-to-end/tui-ink-pty.test.ts tests/end-to-end/tui-modes.test.ts tests/end-to-end/approval-policy.test.ts tests/end-to-end/project-context.test.ts
bun test tests apps
```

Chưa có số full-suite ngoài sandbox sau vòng sửa; không ghi các 6 lỗi là PASS khi
chưa có lần chạy đó. Upstream visual [K], provider đăng nhập thật và hình ảnh trên
terminal người dùng vẫn **Needs verification**. Không tuyên bố Product MVP complete.
