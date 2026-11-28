# ADR 0127 — Bộ theme GitHub (Primer), Sync with system và preview cục bộ trong dialog

- **Trạng thái**: Đã chấp nhận (2026-11-28)
- **Hợp đồng chia sẻ**: `1.72` (từ `1.71`, chỉ cộng thêm / additive)
- **Dependency mới**: 0 (giá trị màu Primer được chép thành dữ liệu, không import package)
- **Spec**: [2026-11-28-github-themes-design.md](../superpowers/specs/2026-11-28-github-themes-design.md)

## 1. Bối cảnh

- Bộ theme cũ (Auto/Dark/Light, `*-daltonized`, `*-ansi`, Midnight, Parchment) phần lớn suy ra từ 3 màu
  (`deriveTokensFromTriplet`), khó đạt đúng bảng màu có vai trò rõ ràng.
- Preview trong `/theme` gọi `ThemeEngine.previewTheme()` → `notify()` → `ThemeProvider` tạo context mới →
  khoảng 41 file dùng `useTheme()` render lại, kể cả toàn bộ transcript phía sau dialog. Transcript càng dài,
  preview càng giật.

## 2. Quyết định

### 2.1. Bảng màu
- 9 theme GitHub: `github-light`, `github-light-high-contrast`, `github-light-colorblind`,
  `github-light-tritanopia`, `github-dark`, `github-dark-high-contrast`, `github-dark-colorblind`,
  `github-dark-tritanopia`, `github-dark-dimmed`.
- Nguồn: `@primer/primitives` **11.10.0** (MIT), `dist/css/functional/themes/<name>.css`, tải từ
  `https://unpkg.com/@primer/primitives@11.10.0/` ngày 2026-11-28. `scripts/import-primer-themes.ts` đọc CSS
  như dữ liệu, giải `var(--x)`, trộn màu có alpha lên `--bgColor-default`, và sinh
  `apps/tui/src/theme/github-palettes.ts` (commit kèm repo). Thiếu biến Primer → script lỗi, không đoán.
- Bảng quy đổi (Cosmew ← Primer):

| Cosmew | Primer |
|---|---|
| background | bgColor-default |
| backgroundPanel, composerBackground | bgColor-muted |
| backgroundElevated, overlayBackground | overlay-bgColor |
| sidebarBackground | bgColor-inset |
| foreground, selectionForeground | fgColor-default |
| foregroundMuted, foregroundSubtle, diffContext | fgColor-muted |
| accent, cursor, info, markdownHeading | fgColor-accent |
| accentForeground | fgColor-onEmphasis |
| border | borderColor-default |
| borderFocused | focus-outlineColor |
| selection | bgColor-accent-muted (đã trộn) |
| scrollbar | borderColor-muted (đã trộn) |
| error, diffRemoved | fgColor-danger |
| warning | fgColor-attention |
| success, diffAdded | fgColor-success |
| syntaxKeyword / String / Comment / Function | color-prettylights-syntax-keyword / string / comment / entity |
| markdownCode | color-prettylights-syntax-constant |

- Giữ lại: `auto` (mặc định), `dark`, `light`, `dark-ansi`, `light-ansi`.
- Id cũ được chuyển qua `normalizeThemeId`: `midnight → github-dark-dimmed`, `parchment → github-light`,
  `dark-daltonized → github-dark-colorblind`, `light-daltonized → github-light-colorblind`.
- Terminal 16 màu: theme GitHub dùng token `<mode>-ansi` như `auto`.

### 2.2. Hợp đồng appearance 1.72
- Thêm `syncWithSystem: boolean = false`, `lightTheme = 'github-light'`, `darkTheme = 'github-dark'` vào
  `appearanceSchema` và `partialAppearanceSchema`. Key trên đĩa (`~/.cosmew/settings.json`) trùng tên.
  Không dùng tên `themeMode` vì key này đã lưu `mode`.
- Khi `syncWithSystem`, theme đang dùng = `darkTheme` nếu nền terminal tối (OSC 11 / COLORFGBG /
  `COSMEW_THEME_MODE`), ngược lại `lightTheme`; `mode` lưu là `system`. Chọn một theme đơn sẽ tắt sync.

### 2.3. Preview cục bộ (phương án A)
- `themeView(engine, manifest, mode)` là hàm thuần, có cache theo manifest, trả về giá trị context.
- `ThemePreviewScope` bọc riêng khung preview bằng context lồng nhau. Dialog giữ theme đang highlight trong
  state React; engine chỉ đổi khi Enter. Màn hình phía sau không đổi khi lướt danh sách.
- Phương án bị loại: B (preview toàn app + memo + debounce) vẫn chậm dần theo độ dài transcript;
  C (A + repaint toàn app có debounce) giữ một phần chi phí của B.

## 3. Hệ quả
- Người dùng đang lưu theme cũ được chuyển sang theme GitHub tương ứng, không lỗi.
- Màn hình phía sau dialog không xem trước theme khi lướt (giống thẻ preview của GitHub).
- Màu thật trên terminal 256 màu và terminal Linux: Needs verification.
