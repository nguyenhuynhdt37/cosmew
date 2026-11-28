# Theme GitHub (Primer) và Sync with system — bằng chứng

Ngày: 2026-11-28 · [ADR 0127](../../adr/0127-github-themes-and-sync-appearance.md) ·
[Spec](../../superpowers/specs/2026-11-28-github-themes-design.md) · [Plan](../../superpowers/plans/2026-11-28-github-themes.md)

## Đã có

- 9 theme GitHub sinh từ `@primer/primitives` **11.10.0** (MIT), tải từ
  `https://unpkg.com/@primer/primitives@11.10.0/dist/css/functional/themes/` ngày 2026-11-28
  (`scripts/import-primer-themes.ts` → `apps/tui/src/theme/github-palettes.ts`). Package không được thêm vào dependency.
- Id cũ (`midnight`, `parchment`, `*-daltonized`) tự chuyển sang theme GitHub tương ứng.
- `/theme`: Tab / Shift+Tab / ← / → (action `tabs:next` / `tabs:previous`) chuyển Single theme → Day theme →
  Night theme. Enter ở Single gọi `setTheme` (tắt sync); ở Day/Night gọi `setSync` cho đúng slot.
- Preview nằm trong dialog (`ThemePreviewScope`): transcript (`❯` prompt, `⏺ Update(path)`), diff, markdown,
  trạng thái, code có tô màu, `/config · Bash · ✻ Thinking`. Bố cục: danh sách bên cạnh preview từ 70 cột và
  19 dòng, xếp dọc ở 46–69 cột, compact dưới 46 cột hoặc dưới 19 dòng.

## Hiệu năng

`apps/tui/src/ink/features/themes/themes.test.tsx` — 200 item transcript, 110×40, bấm ↓ 10 lần (Bun 1.4.4,
Darwin arm64, ink-testing-library, không phải PTY):

| | ms mỗi phím (keypress → frame) | Engine notify |
|---|---|---|
| Trước (preview qua engine) | 3, 15, 8, 13, 9, 11, 8, 8, 7, 10 | 10 / 10 |
| Sau (preview trong dialog) | 4, 8, 6, 7, 6, 7, 5, 7, 6, 7 | 0 / 10 |

Engine không notify nghĩa là `ThemeProvider` không đổi giá trị context, nên transcript không render lại vì theme
khi lướt danh sách. Mã ANSI (`fgHex`/`bgHex`) và giá trị context (`themeView`) được cache.

## Sửa sau review toàn nhánh

- SDK `getAppearance`/`updateAppearance` giờ giữ `syncWithSystem`/`lightTheme`/`darkTheme` cho phạm vi project và
  khi không có appearance store.
- Bật/tắt sync không còn xóa theme đơn đã lưu; tắt sync trả về mode riêng của theme đó.
- Màu nền terminal (OSC 11) được hỏi lúc khởi động với mọi theme, không chỉ `auto`, để bật sync giữa phiên chọn
  đúng ô.
- Terminal 40×15: preview chỉ lấy số dòng còn trống, nên tiêu đề, dòng Single/Sync, hai ô và danh sách luôn hiện.

- Đếm render trực tiếp: test spy `useTerminalSize` và chỉ đếm lời gọi từ `TranscriptItem` (mỗi lần item render):
  0 lần trong 10 lần ↓; cách preview cũ (qua engine) cho 20 lần. Đổi theme thật vẫn render lại (đối chứng).
- Khi sync, `getEffectiveMode()` theo mode riêng của theme trong ô; theme GitHub không tô nền trên terminal 16 màu
  hoặc không màu; footer ghi `Tab Single / Day / Night`; `/config` hiện trạng thái sync và Color Mode mở bảng chọn
  theme thay vì âm thầm tắt sync; snapshot dialog (rộng, xếp dọc, hẹp + sync) trong
  `features/themes/__snapshots__/`.

## Giới hạn / Needs verification
- Câu trả lời OSC 11 đến sau cửa sổ 150 ms lúc khởi động bị bỏ qua; theme không đổi theo nền terminal đổi giữa
  phiên (giới hạn có từ trước với `auto`, nay ảnh hưởng cả sync). Needs verification trên Apple Terminal/Linux.

- Chưa kiểm thử tay trong TTY thật cho bản này (chỉ ink-testing-library).
- Màu trên terminal 256 màu và terminal Linux: Needs verification.
