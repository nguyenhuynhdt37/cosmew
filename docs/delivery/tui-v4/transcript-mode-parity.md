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
