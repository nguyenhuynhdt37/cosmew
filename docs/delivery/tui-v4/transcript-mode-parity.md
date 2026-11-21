# Transcript mode parity — Claude Code 2.1.330

Đo ngày 2026-11-21, chỉ thực hiện Task 1 của [plan](../../superpowers/plans/2026-11-21-ctrl-o-transcript-parity.md).
Đã đọc cả Evidence, Global Constraints và các task sau để kiểm tra giả định đầu vào.
Không thay đổi source code, public contract, dependency hay settings của repository.

## Nguồn và phương pháp

- Binary cài đặt: `~/.local/share/claude/versions/2.1.330`. Revision nhận diện bằng version và SHA-256 trong
  [binary-evidence.txt](reference/transcript-2.1.330/binary-evidence.txt). Trích bằng Python `re.finditer(pattern, bytes)`
  trên `Path.read_bytes()`, lấy vùng quanh match; không chạy pipeline `strings` trên binary.
  B1–B9 bên dưới là nhãn section trong file bằng chứng, có offset byte đầu/cuối để tái kiểm tra. Escape JS giữ nguyên;
  trong đặc tả này `\xB7` là `·`, `\u2026` là `…`.
- Live: đúng executable trên, PTY 100×36 và 40×36, pyte 0.8.2 từ môi trường tạm có sẵn.
  Mỗi lần khởi động dùng một thư mục tạm mới, rỗng; lọc mọi biến bắt đầu `CLAUDE` và mọi biến `ANTHROPIC_` khỏi env trước spawn.
  Giữ đăng nhập/settings người dùng; thêm `--settings '{"disableAllHooks":true}' --strict-mcp-config` để tắt hook và MCP khi chụp.
  Không gửi prompt, không gửi Enter trong ô prompt, không gọi model; chỉ Enter xác nhận trust sau khi chọn `Yes, I trust this folder`.
  Banner `API Usage Billing` không chặn UI; không cần đăng nhập hay thanh toán thêm.
  Không dùng resume, dữ liệu hội thoại cũ hoặc nội dung giả để tạo match. Tên editor hiện trong legend là `code` từ môi trường hiện tại.
- Cả hai process được SIGTERM theo process group rồi `wait()` thu hồi trong `finally`; thư mục cwd tạm được xoá.
  Frame `.txt` dùng `NN|dòng` (36 dòng), kèm `.colors.json` theo dạng `[y, [[x0,x1,fg,bg,bold,italic,reverse,text],…]]`.
  Email, tổ chức, UUID và path được redact; redaction có thể làm độ dài text khác số cell gốc trong metadata màu.
- Đây là đo UI rảnh với hội thoại rỗng. Static evidence chứng minh nhánh code tồn tại, không chứng minh mọi nhánh đã được quan sát live.
  Không dùng khung cũ `live-120x36/L08-ctrl-o.txt` làm bằng chứng live cho version 2.1.330.

## Keymap

B1 là toàn bộ bảng `context:"Transcript"` mặc định trong binary:

| Phím | Action id | Bằng chứng |
| --- | --- | --- |
| `ctrl+e` | `transcript:toggleShowAll` | B1, B4; chỉ active khi `!virtualScrollActive` |
| `ctrl+c`, `escape`, `q` | `transcript:exit` | B1, B4; exit handler tắt khi search bar mở |
| `ctrl+u` / `ctrl+d` | `scroll:halfPageUp` / `scroll:halfPageDown` | B1 |
| `ctrl+b` / `ctrl+f` | `scroll:fullPageUp` / `scroll:fullPageDown` | B1 |
| `ctrl+n` / `ctrl+p` | `scroll:lineDown` / `scroll:lineUp` | B1 |
| `j` / `k` | `scroll:lineDown` / `scroll:lineUp` | B1 |
| `up` / `down` | `scroll:lineUp` / `scroll:lineDown` | B1 |
| `g` / `shift+g` | `scroll:top` / `scroll:bottom` | B1 |
| `home` / `end` | `scroll:top` / `scroll:bottom` | B1 |
| `space` / `b` | `scroll:fullPageDown` / `scroll:fullPageUp` | B1 |

Những phím dưới được xử lý trực tiếp trong controller B4, **không nằm trong bảng Transcript B1**:

| Phím | Hành vi | Điều kiện / bằng chứng |
| --- | --- | --- |
| `/` | Mở search, đặt anchor, đóng help | Virtual scroll active, không dump mode; B4, `03-search-empty` cả hai width |
| `?` | Bật/tắt legend | Cùng điều kiện; B4, `02-help` |
| `n` / `N` | Match tiếp/trước, hỗ trợ ký tự lặp | Có match, search bar đã đóng; B4. Needs verification live |
| `{` / `}` | Prompt trước/sau | B4, B3 legend. Needs verification live với lịch sử |
| `[` | Print to scrollback | Không dump mode, không embedded; B4. Needs verification live |
| `v` | Render transcript vào file tạm, mở editor | B4. Needs verification live |
| `ctrl+o` | Toggle transcript qua Global | B2/B3, `01-ctrl-o` |

Khi search bar mở, controller xử lý trực tiếp các ký tự ở trên không active (`es=!Ho`), chữ phải vào query.
B4 không tự chứng minh toàn bộ routing của mọi scroll binding khi nhập query: **Needs verification**.
Các scroll action và exit key ngoài Ctrl+O chưa được thử live với dữ liệu; bảng là static evidence, không phải test hành vi cuộn.

## Footer: text, ưu tiên và cắt dòng

B2: rule trên (`borderTop`, dim), `marginTop:1`, `paddingLeft:2`, width `100%`, spacer flex ở giữa.
Text trái dim và `wrap:"truncate-end"`. Các phần có giá trị nối bằng ` · `:

`[dialog waiting · |working · ]Showing detailed transcript · <toggleKey> to toggle · <variant>`

`dialog waiting` ưu tiên hơn `working`, được tô màu permission; `working` dùng màu claude.
Đây là prefix trái, **không tự động thành status phải**. B2 truyền prop `status` riêng cho badge phải.

| Điều kiện theo thứ tự | Variant chính xác | Bằng chứng |
| --- | --- | --- |
| Có `searchBadge` | `n/N to navigate` | B2, B4; Needs verification live |
| Virtual scroll, đủ chỗ | `↑/↓ to scroll · v to open in <editor> · ? for shortcuts` | B2; editor không xác định: `open in editor`. Needs verification live nhánh đủ chỗ trong capture này |
| Virtual scroll, không đủ chỗ | `? for shortcuts` | B2; `100x36-01-ctrl-o.txt` |
| Không virtual scroll, `suppressShowAll` | `v to open in <editor>` hoặc `v to open in editor` | B2; Needs verification live |
| Không virtual scroll, không suppress, chưa show all | `<showAllKey> to show all` | B2; default `ctrl+e`; Needs verification live |
| Như trên, đã show all | `<showAllKey> to collapse` | B2; Needs verification live |

Fit test của nhánh virtual scroll dùng **strict `< columns`**, không phải `<=`:

`2 + cells(join([prefixStatus ?? "", "Showing detailed transcript", "<toggleKey> to toggle", fullScrollHint].filter(nonempty), " · ")) + cells(status ? status + " " : verboseText) < columns`

Trong binary `tX=2`, `aX="verbose "`; khi có prefix working/dialog thì `verboseText=""`, còn lại là `aX`.
Fit test này không cộng badge tìm kiếm: nhánh có searchBadge đã chọn variant khác.
Sau khi chọn variant, renderer cắt cuối toàn bộ text trái bằng ellipsis khi thiếu chỗ, không wrap footer.
Exact cell allocation ở các width khác hai khung đã đo: **Needs verification**.

Badge phải theo thứ tự: `status + " "` → `<current> of <count> ` → `verbose ` → rỗng.
`verbose` chỉ hiện khi không có prefix working/dialog; searchBadge/status vẫn có thể hiện khi verbose bị tắt. B2.

Task 5 footer regression correction (2026-11-21): the inline shell selects B2's scroll/help
footer branch when the transcript has at most 30 messages, since there is no hidden recent
window to expand. At width 140 the full scroll/editor/help hint fits; narrower widths retain
the strict fit fallback. Actual transcript virtualization and Ctrl+E routing are unchanged.
The regression test renders the shell with an empty transcript and the draft `keep this`;
this is local test evidence, not new upstream live evidence.

Live 100 cột: hai khoảng trắng đầu, `Showing detailed transcript · ctrl+o to toggle · ? for shortcuts`, badge `verbose` bên phải.
Live 40 cột: `  Showing detailed transcript · …verbose` (không có khoảng trống giữa ellipsis và badge trong frame).
Xem [`100x36-01-ctrl-o.txt`](reference/transcript-2.1.330/100x36-01-ctrl-o.txt) và
[`40x36-01-ctrl-o.txt`](reference/transcript-2.1.330/40x36-01-ctrl-o.txt).
`06-ctrl-e` ở cả hai width giữ nguyên footer: khớp B4 vô hiệu hoá toggle khi virtual scroll active.

## Search bar và badge

B3, B4; frames `03-search-empty`, `04-search-candidate`, `05-search-no-match` cho cả hai width.
`/` mở bar thay footer ở đáy; rule trên, `marginTop:1`, trái thụt 2; ô nhập borderless flex-grow, vùng badge/hint không co và `paddingX:2`.
Placeholder chính xác là `Search transcript…`, có glyph `⌕` phía trước trong frame.
Query không rỗng thay placeholder. Ô query **có thể wrap**: query `zz_transcript_no_match_98371` chiếm hai hàng ở width 40;
không suy từ ràng buộc footer một dòng thành search query một dòng.

| Trạng thái, theo ưu tiên YGe trong B3 | Text | Quan sát |
| --- | --- | --- |
| `indexStatus === "building"` | `indexing…` | Static; Needs verification live |
| `indexStatus` chứa ms | `indexed in <ms>ms` | Static; Needs verification live |
| count 0, query không rỗng | `no matches` | `04-search-candidate`, `05-search-no-match`, cả hai width |
| count > 0 | `<current> of <count>` | Static; Needs verification live |
| count 0, query rỗng, không indexStatus | Không badge | `03-search-empty`, cả hai width |

Warm index dưới 20ms bỏ trạng thái indexed; từ 20ms trở lên hiện duration rồi xoá sau 2000ms (B3).
Badge/hints nối bằng ` · `. Width >=70 và có match mới thêm `enter to keep`; width >=50 thêm `esc to cancel`.
100 cột bar rỗng có `esc to cancel`; 40 cột không có. Enter là **keep và đóng bar**, không phải next-match trong controller B4.
B4 giữ query khi đóng chỉ nếu có match; Esc huỷ và khôi phục query đã giữ trước đó.
Sau khi giữ query có match, footer dùng `n/N to navigate` và badge `<current> of <count>`.
Hành vi Enter/Esc với query có match, wrap vòng n/N, highlight, index chậm: **Needs verification live**.

Không có frame thành công cho query khớp: trong phiên rỗng, `Claude` cũng trả `no matches` dù có trong banner.
File `04-search-candidate` ghi đúng lần thử này, không được dùng làm fixture match. Tạo hội thoại/model request bị loại khỏi phạm vi.

## Show all: số lượng và giới hạn thực tế

**Cửa sổ transcript cũ là 30 message, không phải 200.** B5 có `Jr=30,vR=50,mS=200,gl=2`;
B7 tính `gs = ce && !Qe && !ee` (transcript, history chưa yêu cầu all, không virtual scroll),
rồi `hr = gs ? ws.slice(-Jr) : ws`, `hasTruncatedMessages = gs && bs.length > Jr`.
Đây là message sau các bước biến đổi trước đó, không phải số dòng terminal và không nhất thiết bằng số raw SDK items.
`hiddenMessageCount = Gn.length - Jr`; UI hiện header bằng B9:

- `<showAllKey> to show <N> previous messages` khi truncated.
- `<showAllKey> to hide <N> previous messages` khi transcript có history override, N>0 và không uncapped.
- `<N>` bold; khi `Cn` đúng thì bỏ cả số và khoảng trắng theo sau. Ngữ nghĩa điều kiện `Cn`: **Needs verification**.

Không tìm thấy bằng chứng cho dòng `Showing last N of M · ctrl+e to show all` trong transcript controller này.
Không dùng câu đó của Task 5 làm exact string: match `Showing last` khác trong binary thuộc UI teleport, không phải viewer này.

B4: showAll khởi tạo false; toggle đổi false/true; history là `undefined` → `"all"`; dump mode là `"uncapped"`.
`scriptSources` đổi `collapsed` → `whole`. Handler `transcript:toggleShowAll` chỉ active khi **không** virtual scroll.
Virtual scroll bỏ cửa sổ 30; `ctrl+e` không đổi màn hình rỗng live (hai frame `06-ctrl-e`).
Không thể kết luận từ đó mọi lịch sử đã được render đồng thời: virtualization vẫn có render range.

200 là **render cap riêng** của nhánh không virtual scroll, B5/B6/B8: `fS(rows, flag)` trả `min(200, rows)` nếu flag đúng, còn lại 200.
`yl` giữ anchor; chỉ khi phần còn lại `> window + 50` mới chuyển anchor về `length - window`.
Pre-cap raw dùng `window*2`, cap renderable dùng `window`; uncapped/renderRange bỏ cap này.
`history:"all"` tự nó không phải `uncapped`: không nên triển khai show-all như bỏ mọi giới hạn renderer.
Cờ từ `la()` và tác động trên các môi trường khác: **Needs verification**.

Static đã xác nhận con số 30 và các điều kiện; hành vi với lịch sử >30, >200, 5.000 items, show/hide header,
reset showAll khi rời rồi vào lại, responsiveness và số đếm sau normalize: **Needs verification live**.
Không ép tắt virtual scroll bằng biến CLAUDE vì phiên capture yêu cầu loại toàn bộ nhóm biến đó.

## Legend `?`

B3/B4 và [`100x36-02-help.txt`](reference/transcript-2.1.330/100x36-02-help.txt),
[`40x36-02-help.txt`](reference/transcript-2.1.330/40x36-02-help.txt).
100 cột chia ba cột, đọc mỗi cột từ trên xuống; 40 cột một cột, 11 hàng:

```text
q/ctrl+o to exit
? to close
↑/↓/j/k to scroll
ctrl+u/d to move half a page
space/b to move a page
g/G to go to top/bottom
{/} to jump between prompts
/ to search
n/N to cycle matches
[ to print to scrollback
v to open in code
```

Không editor thì legend là `v to open in editor` (B3).
B4 `v` có status `rendering <N> messages…`, rồi `opening <path>` hoặc
`wrote <path> · no $VISUAL/$EDITOR set`, hoặc `couldn't render: <error>`; xoá status sau 4000ms.
Do đó chỉ chuỗi `no $VISUAL/$EDITOR set` riêng lẻ chưa phải toàn bộ thông báo upstream. Các nhánh editor: **Needs verification live**.

## Cosmew đang khớp và khác

Đọc working tree hiện tại: `apps/tui/src/ink/integrated-shell.tsx` (`DetailedFooter`, `quickKeys`, handlers)
và `apps/tui/src/ink/hooks/keymap/defaults.ts`, ngày 2026-11-21. Đây là so sánh source read-only, không chạy acceptance Task 8.

| Hạng mục | Kết quả source hiện tại | Bằng chứng |
| --- | --- | --- |
| Ctrl+O, q/Ctrl+C/Esc | Matches về binding/toggle/exit | defaults Transcript; shell `transcript:exit`; B1/B2 |
| `{`/`}`, `[`, `v`, `?` | Matches về phím và mục đích cơ bản | defaults Transcript, shell handlers; B4 |
| ↑/↓, PgUp/PgDn, Ctrl+Home/End | Đã có Scroll bindings/handlers; không chứng minh mọi khoảng cuộn khớp | defaults Scroll; B1 (Transcript dùng Home/End trực tiếp) |
| Footer cơ bản | Matches rule, indent 2, dim, text `Showing detailed transcript`, toggle, `verbose` phải | DetailedFooter; B2 và `01-ctrl-o` |
| Footer variant và truncation | Differs: luôn giữ `↑/↓ to scroll`, thêm editor/help từng phần nếu `<= width-12`; không cùng strict fit/fallback và không có truncate-end | DetailedFooter; B2, hai frame `01-ctrl-o` |
| Editor footer | Differs: hardcode `code`, upstream lấy editor thực tế hoặc `editor` | DetailedFooter; B2 |
| Working/dialog/status/search badge | Differs: DetailedFooter chỉ nhận width, chưa có các nhánh này | DetailedFooter; B2 |
| Ctrl+E, 30-message window | Differs: chưa có action/state show-all trong defaults/shell | defaults Transcript, shell; B1/B4/B7 |
| Vim/Emacs scroll aliases, Home/End | Differs: thiếu các binding Transcript trong B1 | defaults Transcript/Scroll; B1 |
| Search `/`, bar, index/badge, n/N | Differs: thiếu bindings và routing search trong viewer hiện tại | defaults/shell; B3/B4 |
| Help | Differs: `quickKeys` tạo notice một dòng với `exit`, `scroll`, `prompts`, `to scrollback`, `open in editor`; upstream có legend 11 mục và layout thích ứng | shell quickKeys; B3, `02-help` |

Matches ở bảng này chỉ là phần đã đối chiếu; remapping, streaming, dialog pending và hành vi scroll/editor/scrollback thật của Cosmew:
**Needs verification** (ngoài Task 1). Các task sau phải sửa giả định “Ctrl+E luôn active”, “show-all bỏ mọi cap”,
“Enter next match” và dòng `Showing last…` trước khi lấy chúng làm expectation.

## Danh sách frame và kiểm tra

Trong [reference/transcript-2.1.330/](reference/transcript-2.1.330/) mỗi width 100/40 có `.txt` và `.colors.json`:
`00-ready`, `01-ctrl-o`, `02-help`, `03-search-empty`, `04-search-candidate`, `05-search-no-match`, `06-ctrl-e`.
Tổng 14 frame, 14 color sidecar, một `binary-evidence.txt`.

Task 1 verification: chạy `git diff --check` trên shared dirty tree và quét riêng tài liệu/frame mới để kiểm tra thông tin cá nhân.
Kết quả: `git diff --check` PASS; quét thông tin cá nhân bắt buộc trả 0 match (exit 1 của `rg`); kiểm tra thêm email/UUID/path cũng PASS.
14 frame đều đủ 36 dòng đánh số và 14 color sidecar đều parse JSON được. Không chạy suite source hoặc thay đổi các file của phiên khác.

## Task 3 — footer composer (2026-11-21)

Implemented `features/transcript/footer-logic.ts` and `detailed-footer.tsx`; the shell supplies width,
editor and existing busy/pending-interaction state. Ctrl+O toggles during a turn or pending permission/question
without cancelling it. Search/show-all/badge remain defaulted for Tasks 5–6. Hints subscribe to the central
keymap and use Task 2 action IDs/keyLabels, including live remaps.

Ruling: B2 overrides the plan's right-hand activity status: `working ·` / `dialog waiting ·` are left
prefixes, suppressing `verbose `. The independent transient right status has its own optional `rightStatus`
input; precedence is rightStatus → search badge → verbose → empty. Badge strings retain B2's trailing space.
The full scroll/editor/help hint uses B2's strict `< width` test; otherwise the virtual-scroll variant is
only `? for shortcuts`, with no intermediate editor-only fallback. Non-virtual variants are exposed through
optional `virtualScroll`/`suppressShowAll` inputs. No new key bindings or public contract changes.

Cell allocation reserves the two-cell indent and right badge before truncating the left with `…`.
The trailing badge space is included in the budget, so at 40 cells the left ends ` ·…` rather than the
live capture's ` · …`. Exact upstream renderer allocation remains **Needs verification**, as noted above;
this implementation guarantees no wrap/overflow and does not claim pixel-exact live parity.

TDD: missing-module RED, streaming/dialog RED, and live-remapping RED were each observed before their fixes.
Verification: touched tests **31 pass**, including exhaustive cell-budget checks at every width 24–200 with
wide/long strings and activity/search states; reference/composition tests **17 pass, 1 skip** (existing skip).
Reviewed scoped diff: no existing golden includes the changed footer; all golden assertions pass, so none
was re-recorded. `bun run typecheck` PASS. `bun run lint` stopped on formatting of the concurrently added
`tests/contracts/sandbox-modes.test.ts`, outside Task 3; that file was left untouched.

## Task 4 — transcript scroll keys (2026-11-21)

Wired Task 2's existing B1 action IDs in the shell's Transcript context: j/k and Ctrl+N/P move one row;
Ctrl+D/U move half the measured viewport (floor, minimum 1); Ctrl+F/space and Ctrl+B/b move a whole
viewport; g/shift+g and Home/End reach the ends. No Task 4 key-name conflict with B1 was found.
`useScrollback` now exposes `halfPageUp`/`halfPageDown`; existing PgUp/PgDn retain their half-screen
steps, and Ctrl+Home/End, arrows and wheel paths remain available. No dependency or public contract change.

Transcript handlers require `viewing && !searchOpen`; `searchOpen = false` is a commented placeholder
for Task 6. Scroll fallback handlers also yield to search. Query routing, including Esc before Global/Chat
fallbacks, remains Task 6 work and **Needs verification** with the actual search bar.

Collisions resolved through the existing context priority and composer focus rules: Ctrl+D is Global
`app:exit`/delete outside the viewer; Ctrl+B is Chat `task:background`; Ctrl+P/N navigate composer
history/autocomplete; Ctrl+U deletes to the start; printable b/space/j/k/g/G remain prompt text.
Transcript takes those keys only in detailed mode; composer code and non-transcript behavior are unchanged.

TDD: missing line/half/full-page/end aliases failed before implementation. The Task 3 footer occupies two
rows, so tests use a 28-row viewport at 100x30, half 14; the initial test assumption of three footer rows
was corrected against the existing component. Tests assert visible content offsets via numbered answer
rows, both directions, top/bottom, normal prompt typing/history/deletion and Esc/q/Ctrl+C focus restoration.
Scoped independent review found no important Task 4 issues.

Verification: `bun run typecheck` PASS; fullscreen tests **37 pass**, combined fullscreen/keymap tests
**56 pass**, scoped `git diff --check` PASS. `bun run lint` fails only on formatting in untouched
`tests/contracts/branding-guard.test.ts`, `cosmew-rename.test.ts` and `sandbox-modes.test.ts`.
The broader `bun run test` and its one retry both report **601 pass, 9 skip, 306 fail**; failures are
outside the touched test files, including fixture-server `EADDRINUSE`, native sandbox `UNSUPPORTED`,
process/PTY/LSP environment checks and concurrent branding/state changes. These do not establish live
terminal/OS parity and were left untouched. Logs for this run: `/tmp/task4-{red,fullscreen,touched,lint,suite,suite-retry}.log`.

## Task 5 — show-all window (2026-11-21)

Implemented `visibleWindow` in `features/transcript/show-all.ts`, exporting `DETAILED_RECENT_LIMIT = 30`.
Detailed non-virtual transcripts render the most recent 30 items by default; Ctrl+E toggles all passed
items and the footer's exact `ctrl+e to show all` / `ctrl+e to collapse` wording. Every Ctrl+O entry resets
showAll to false. Normal transcripts retain their existing Static/live/history behavior. Short histories
have no hidden-count hint and suppress the footer show-all variant. Hints use the live central keymap;
the default top hint spells the chord `Ctrl+E`, as B6's fallback does, and bolds the count (B9).

Ruling: B5/B7/B9 override Task 5's proposed `Showing last N of M · ctrl+e to show all` line. The actual
lines are `Ctrl+E to show N previous messages` and, after expansion, `Ctrl+E to hide N previous messages`.
30 is the recent-message window; 200 is an independent upstream renderer cap, not this window's size.
This task does not add that upstream renderer/normalization pipeline or remove Cosmew's existing paging
limits. Counts here are SDK transcript items; exact equivalence to upstream's normalized messages and
B9's count-suppression condition remain **Needs verification**.

Ruling: B4 disables Ctrl+E while virtual scroll is active; B7 also bypasses the 30-message window in that
branch. Cosmew maps its fullscreen history paging (`60 + olderPages * 40`, `ScrollViewport` and
`useScrollback`) to that branch: no show/hide hint, no Ctrl+E state change, existing scroll/footer behavior
retained. Inline output has no paged viewport and uses the non-virtual show-all branch. This is an explicit
adapter mapping: Cosmew clips a mounted tree and pages older history rather than using upstream's
render-range virtualizer; precise equivalence is **Needs verification**. Scrolling away from the bottom
does not switch branches or enable Ctrl+E. The component's `virtualScroll` prop bypasses its legacy window.

TDD: observed missing-helper RED and missing recent-window/hint/inline-toggle RED before implementation.
Tests cover short/exact-limit histories, oldest-item removal/counts/immutability, expansion/collapse,
non-detailed preservation, virtual bypass, inline shell toggle/reset/composer focus, fullscreen Ctrl+E
suppression, and computing the 5,000-item window in under 200 ms. The timing assertion covers window
computation, not rendering 5,000 Ink components or live terminal input latency.

Verification: `bun run typecheck` PASS; `bun run lint` PASS. Touched files plus footer, transcript-reference
and composition-golden regression tests: **86 pass, 1 existing skip, 0 fail**. Reviewed scoped source/test diff;
no golden changes were needed and none were re-recorded. Shared pre-existing edits were preserved;
no stash/reset/commit and neither protected mouse/wheel source file was touched. Live long-history
upstream/OS acceptance remains **Needs verification**.

## Task 6 — search (2026-11-21)

Implemented lazy, cancellable index warming and query scans in setImmediate chunks, visible ANSI/OSC-sanitized
item text, UTF-16 visible offsets (including wide characters), current-match theme highlight and row reveal.
Index warming is cached per transcript array revision; closing/reopening does not rebuild an unchanged index.
B3 status priority, duration threshold (20 ms / 2 s), placeholder, wrapping query and responsive hints are wired.

Ruling: B3/B4 override the plan's Enter-next step: Enter keeps a matching query and closes; n/N cycle with
wrap only after close. Printable jkgqn belong to the query while open. Esc cancels back to the kept query;
a subsequent Esc exits. No match queries are discarded on keep. No contract/dependency change.

Needs verification: live upstream matching/highlight and slow-index behavior (no successful match was captured).
The selected item uses a sanitized plain-body rendering to map offsets without corrupting ANSI or wide text;
its Markdown/tool decoration is simplified while highlighted. Exact rendered-text normalization, cursor editing
beyond append/backspace/Ctrl+U, single extremely large item latency, and real-terminal 5,000-item input latency
remain Needs verification. Chunk tests cover 5,000 moderate items and cancellation, not an OS latency guarantee.

TDD: missing-module/search-open RED; navigation initially failed to reveal the matching row; Backspace RED
confirmed raw-key routing needed a non-printable fallback. Verification after fixes: typecheck PASS, lint PASS,
search + fullscreen files **45 pass, 0 fail**. No golden was re-recorded. A focused test was inadvertently run
while an earlier verification process was still finishing; final verification was rerun sequentially.

## Task 7 — legend and editor message (2026-11-21)

Legend now replaces the footer, with B3's eleven lines and column-major three-column layout when it fits,
one column when narrow. Labels subscribe to the live keymap; default aliases retain the measured compact
`ctrl+u/d`, `space/b`, `g/G`, `n/N` spellings. A remapped dump key is reflected without reopening help.
`v` without VISUAL/EDITOR shows the exact `no $VISUAL/$EDITOR set` status for four seconds and does not suspend.
Updated keys.md section 5, keys-status.md and g3-status.md.

Ruling: B4's upstream full status includes `wrote <path> · `, but this no-editor branch does not write a
throwaway file just to report that no editor exists. It displays the evidenced message suffix directly.
Full upstream render/write/open status lifecycle and actual editor-name parsing beyond the first executable
remain **Needs verification**. No new dependency/contract or terminal suspension path.

TDD: legend text/remapping and no-editor RED observed; fixed an invalid test keymap document encoding and
an editorName import shadow caught by typecheck. Final verification: typecheck PASS, lint PASS,
keys.test.tsx **21 pass, 0 fail**. No golden changed.

## Task 8 — reference verification (2026-11-21)

Added footer, legend, empty-search and wrapped no-match region comparisons at 100 and 40 columns against
`reference/transcript-2.1.330`. Only product/editor names and terminal-edge trailing blanks are normalized;
spacing within rows is compared exactly. Banner/session content and absolute viewport row placement are outside
these region assertions. No reference or golden was re-recorded.

Frame RED exposed Task 3's one-cell narrow-footer difference. Corrected allocation: when clipping the left,
drop the expendable terminal-edge trailing badge space before reserving the badge. At 40 columns it now reads
`  Showing detailed transcript · …verbose`, matching the capture. This supersedes Task 3's documented difference;
strict hint fit and the no-wrap cell budget remain tested across widths 24–200.

Added native PTY sequence: Ctrl+O, `/`, query, n as query text, Backspace/Enter keep, n navigation, Ctrl+E,
?, q; assertions check process stays alive. Ruling: Enter is necessary before n navigation because B3/B4 gives
n to the query while the bar is open. The new case failed before reaching UI: `fixtureServer` cannot bind port 0
(`EADDRINUSE`) in this environment. It remains a real failing test, not skipped or replaced by mock success.

Final independent review found three issues, each reproduced RED and fixed GREEN:

- Revealing the oldest match in 5,000 items expanded the mounted history tail to all items and timed out.
  Search now mounts at most 60 items around the match; the existing viewport/controller reveals its row.
- Custom code-point width estimation mislocated matches after wide emoji. Match row measurement now uses
  Ink's own static Text renderer, matching its wrapping/grapheme behavior.
- Search/legend could consume dialog space and input when a new question arrived. Both panels are suspended
  while an overlay is active; the ordinary two-row activity footer preserves the dialog's existing budget.

The 5,000-item shell case now passes, including a <16.7 ms yield assertion during query input and oldest-match
reveal. This proves bounded work returns control to the input turn; exact visible-frame deadlines on a real
terminal, a single enormous item, and platform-specific latency remain **Needs verification**.

| Behavior | Result | Evidence / limits |
| --- | --- | --- |
| Footer text at 100/40 columns | matches | Exact viewer-region comparison, including 40-column ellipsis space |
| Legend text and column layout at 100/40 | matches | Exact region comparison, product/editor names normalized |
| Empty search and no-match wrapping at 100/40 | matches | Four B3 frame comparisons; 40-column query wraps |
| `/`, printable query ownership, Enter keep, Esc cancel/exit | matches | B3/B4 semantics; fullscreen tests, including Backspace |
| B3 four badge strings and precedence | matches | Pure tests; live duration/successful-match evidence still unavailable |
| n/N wrap, footer hint/badge and matching-row reveal | matches | Local shell tests and B2/B4 static evidence; not an upstream live success capture |
| ANSI/OSC visible offsets, wide text and emoji reveal | matches | Sanitizer/offset tests and actual Ink wrap/reveal test |
| Ctrl+O during streaming/dialog; arriving dialog during search/help | matches | Existing streaming/dialog regressions and new overlay tests |
| Remapped keys in footer/legend | matches | Live keymap subscription tests |
| Ctrl+E virtual-scroll suppression / inline 30-item window | matches | Task 5 tests and B4/B7; upstream long-history normalization remains unverified |
| Selected-item formatting during search | differs | Current match uses sanitized plain body rather than Markdown/tool decorations |
| No-editor v status | differs | Exact `no $VISUAL/$EDITOR set` suffix; does not create upstream's `wrote <path>` temporary copy |
| Search/legend widths other than measured 100/40 | Needs verification | Responsive layout implemented; exact upstream spacing unmeasured |
| Full-screen absolute row placement at width 40 | Needs verification | Captured footer has an additional trailing blank row; region tests exclude surrounding blank rows |
| 5,000-item real-terminal latency and huge single-item behavior | Needs verification | Local chunk/cancellation tests + bounded shell test, no OS guarantee |
| New native PTY navigation/process-alive sequence | Needs verification | Environment fails before UI at fixtureServer port 0; no live acceptance claim |
| Successful upstream search/highlight, external editor and scrollback acceptance | Needs verification | No new live upstream run; manual real-terminal check remains coordinator/user work |

Final checks, run sequentially: `bun run typecheck` PASS; `bun run lint` PASS. Six touched/regression TUI files
(search, transcript, footer-logic, reference-frames, fullscreen, keys): **118 pass, 1 existing skip, 0 fail**.
Full touched `tests/end-to-end/tui-ink-pty.test.ts`: **1 pass, 5 fail**; all five failures are the fixture-server
port-0 bind error, including the new case. Logs: `/tmp/task8-{typecheck,lint,tests,pty-full}.log`.
The coordinator's whole suite was not run. No commit/stash/reset; protected mouse/wheel files were not touched.

## PTY suite-order investigation (2026-11-21)

The transcript PTY child now uses an explicit environment with isolated HOME/TMPDIR and COSMEW_HOME,
fixed TERM/locale and NO_COLOR, rather than inheriting host state roots, keybindings, theme/color overrides
or proxy settings. Its wait assertion permanently includes the awaited text and a bounded 8 KB terminal
output tail (escaped to preserve ANSI evidence); the existing 8 s deadline is unchanged.

Needs verification: the reported full-suite-only timeout's root cause. In this restricted execution session,
contracts, security+contracts, MCP, workspace, and themes-cli combinations with the PTY file all fail at
fixture-server listen with EADDRINUSE before the transcript child starts, both before and after environment
isolation. These runs cannot identify the stuck frame or establish that isolation fixes the reported timeout.
Typecheck and lint pass. This is diagnostic hardening, not a claim of successful PTY/full-suite acceptance.

Exact final `bun test tests`: **603 pass, 9 skip, 305 fail** (76.72 s); the transcript PTY fails at
fixtureServer before spawn (1.01 ms), not at a wait. Post-change security+contracts+PTY:
**546 pass, 5 skip, 119 fail** (43.16 s). Logs: `/tmp/pty-full-suite.log`,
`/tmp/pty-fixed-security-contracts.log`, `/tmp/pty-{contracts,mcp,workspace,themes}.log`,
`/tmp/pty-{typecheck,lint}.log`. No timeout increase, production change, commit, stash or reset.
