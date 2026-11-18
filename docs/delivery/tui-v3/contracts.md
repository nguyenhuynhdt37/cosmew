# TUI v3 — contract nội bộ Pha 0, version 0.1

Ngày 2026-11-18. Contract này dành cho bốn agent Pha 1 theo [plan](plan.md).
Mã nguồn chuẩn: `apps/tui/src/ink/`. Không đổi contract SDK/agent events,
public exports của `@futryn/tui` hay default runtime. Quyết định: [ADR 0059](../../adr/0059-ink-tui-foundation.md).

## Runtime và composition

`src/runtime.tsx::runInteractiveTui(options)` lazy-load Ink chỉ khi
(đã bỏ ở Pha 3) Ink là runtime duy nhất; `FUTRYN_TUI` không còn được đọc.
`ink/runtime.tsx` export `selectTuiRuntime(env?)` và `runInkTui(options)`.
Options kế thừa `FutrynTuiOptions`, thêm `initialCommand?`, `stdin?`, `stdout?`,
`stderr?`, `slots?`. Streams có thể được inject để test. Non-TTY render đúng một
frame bằng `renderToString`, không listener input, không animation còn sống.
TTY dùng scrollback thường, không alternate buffer, 30 FPS; Ctrl+C/SIGINT/SIGTERM
thoát, unmount và dọn listeners. Không đóng SDK/backend do CLI sở hữu.

Pha 0 chỉ là nền: runtime tắt tools và khả năng hỏi user, không gửi prompt,
không đọc workspace, không chạy slash command. `initialCommand` nhận diagnostic
“Not implemented”. Pha 1/2 nối startup gate, consent, account verification,
command routing và lifecycle cancellation trước khi bật các khả năng đó.
Không dùng fixture để tuyên bố tương thích provider hoặc hoàn thành parity.

`InkApp({client, themeEngine?, width?, slots?, onInterrupt?})` là composition root.
Bốn slot `AppSlots` đều là `ReactNode`, theo thứ tự:
`transcript`, `plan`, `composer`, `status`; overlay nằm sau status.
Mặc định các vùng rỗng. Slot components chạy bên trong client/theme/overlay providers.
`width` bỏ trống để theo terminal resize; truyền số để snapshot deterministic.
Esc gọi `onInterrupt` khi không có overlay, đóng overlay nếu đang mở.

## Hooks và input

Import từ `ink/hooks/index.ts`; hooks không gọi core/security và không tự gửi lệnh.

| API                                                           | Trả về / hành vi                                                                                                                                                                                                      |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FutrynClientProvider({client, children})`                    | Cung cấp đúng instance SDK của host.                                                                                                                                                                                  |
| `useFutrynClient(): FutrynClient`                             | Throw nếu thiếu provider. Chỉ gọi public API SDK.                                                                                                                                                                     |
| `useClientEvents({reactive?, interaction?, subagent?}): void` | Callback có type suy ra từ `onReactiveEvent`, `onInteractionEvent`, `onSubagentNotice` của SDK. Giữ callback mới qua rerender, cleanup cả ba subscription khi unmount hoặc đổi client. Đăng ký trước khi gửi command. |
| `useEvents`                                                   | Alias của `useClientEvents` theo tên trong plan.                                                                                                                                                                      |
| `useStatus(projectScoped = false)`                            | Trả `ReturnType<FutrynClient['status']>`, cập nhật theo reactive event; dùng event snapshot ổn định với `useSyncExternalStore`, không đưa `status()` mới vào snapshot.                                                |
| `useKeymap(handlers, {isActive?})`                            | Map action → callback, tắt nếu ngoài input scope hoặc không hỗ trợ raw mode. Không tự gọi SDK.                                                                                                                        |
| `useTextInput((input, key) => void, {isActive?})`             | Wrapper input cho composer/filter; tuân thủ cùng input scope. Shortcut có tên dùng `useKeymap`.                                                                                                                       |
| `useInputEnabled(isActive = true): boolean`                   | Dùng nếu một feature thật sự cần `useInput` của Ink trực tiếp.                                                                                                                                                        |
| `InputScope({active, children})`                              | Tắt toàn bộ input nền khi overlay mở, vẫn giữ state và render nền. Scope con không thể bật lại scope cha đã tắt.                                                                                                      |

`KEYMAP` là bảng `{action, keys, label}[]` cho help, `keyAction(input, key)` là
hàm thuần dùng cùng mapping. Các action:

| Action             | Phím        | Ý nghĩa                                                          |
| ------------------ | ----------- | ---------------------------------------------------------------- |
| `close`            | Esc         | Overlay do Shell đóng; khi không overlay thì interrupt callback. |
| `submit`           | Enter       | Submit/select tại feature đang focus.                            |
| `newline`          | Shift+Enter | Newline; composer Pha 1 bổ sung fallback `\\` + Enter.           |
| `previous`, `next` | ↑, ↓        | Navigation; feature sở hữu history/list.                         |
| `expand`           | Ctrl+O      | Mở/thu output được focus.                                        |
| `history`          | Ctrl+R      | Tìm history.                                                     |
| `permissions`      | Shift+Tab   | Feature gọi SDK cycle preset; nền Pha 0 không đổi quyền.         |
| `exit`             | Ctrl+C      | Shell exit.                                                      |

Key release và modifier navigation không khớp bị bỏ qua. Chỉ một feature
được sở hữu mỗi action trong cùng input scope; `Diff`/`Truncate` mặc định
`isActive=false` để tránh nhiều output đồng loạt mở. Dùng `useTextInput` thay
vì listener stdin riêng. Help/autocomplete/slash routing vẫn lấy canonical
metadata từ `@futryn/sdk::SLASH_COMMANDS` và `commandForShortcut` (ADR 0013),
không nhân bản registry slash commands trong keymap.

## Overlay

Import từ `ink/core/index.ts`: `OverlayProvider`, `useOverlay()`.

```ts
interface OverlayEntry {
  id: string;
  content: ReactNode;
}
interface OverlayRouter {
  active: OverlayEntry | null;
  open(id: string, content: ReactNode): void;
  close(): void;
}
```

`open` thay overlay hiện tại, không tạo stack. `open`/`close` có identity ổn định;
`close` idempotent. Shell sở hữu Esc và Ctrl+C. Overlay dùng `ListPicker` thì
**bỏ `onCancel`** để không xử lý Esc hai lần. Với picker standalone, truyền
`onCancel`. Component dialog sở hữu cleanup nghiệp vụ khi unmount (dismiss/cancel
qua SDK khi cần), router chỉ thay UI và không bao giờ cấp quyền. Khi chỉ đóng UI
không đủ để giải quyết prompt SDK, Pha 1 phải xử lý lifecycle đó trong dialog.

## Theme

Import từ `ink/theme/index.tsx`: `ThemeProvider({engine, children})`, `useTheme()`.
Provider subscribe một lần vào `ThemeEngine` hiện có; preview/commit/cancel đều
cập nhật consumers và unsubscribe khi unmount. Runtime initialize engine trước
render. `useTheme` trả:

- `engine: ThemeEngine`, `tokens: ThemeTokens`, `mode: 'dark' | 'light'`;
- `colors: boolean`, `color(token: ThemeTokenKey): string | undefined`;
- `animate: boolean` (respect animations enabled / reduced motion),
  `syntaxHighlighting: boolean`.

Màu semantic lấy từ engine cũ, không tạo palette riêng. Luôn dùng `color(key)`
cho Ink color props: capability `none` trả `undefined`. CodeBlock không phát màu
khi `NO_COLOR`, `FORCE_COLOR=0` hoặc `TERM=dumb` được engine phát hiện.
Ink sở hữu styling terminal; không thay env toàn process để ép màu.

## UI nền

Import từ `ink/ui/index.ts`. Mọi text đầu vào được bỏ ANSI/OSC/control bytes,
giữ newline, đổi tab thành bốn khoảng trắng. Không thực thi link, HTML hay code.

| Component                          | Props                                                                                                                        | Hành vi                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Panel`                            | `children: ReactNode`, `title?: string`, `width?: number`, `focused?: boolean=false`, `padding?: number=1`                   | Border bo góc, tiêu đề bold, semantic border/focused border, padding ngang.                                                                                                                                                                                                                                                                                                                             |
| `ListPicker<T extends PickerItem>` | `items: readonly T[]`, `onSelect(item: T)`, `onCancel?`, `visibleRows?=8`, `isActive?=true`, `placeholder?`, `initialQuery?` | Lọc label/description/keywords không phân biệt hoa thường, gõ/paste query (tối đa 512 code units), Backspace/Delete xóa code point cuối, ↑↓ di chuyển có giới hạn, Enter chọn, Esc gọi onCancel nếu có. Cuộn theo cursor, số thứ tự tương đối danh sách đã lọc, `n/total`; empty hiện No matches, không chọn; disabled vẫn hiện nhưng Enter không chọn. Không dùng phím số để chọn vì số cũng là query. |
| `Spinner`                          | `verb: string`, `startedAt?: number` (epoch ms), `elapsedMs?: number`, `tokens?: number`, `animate?=true`                    | Marker + động từ + elapsed + tokens; `elapsedMs` cho clock deterministic. Timer cleanup khi unmount. Reduced motion giữ marker tĩnh nhưng cập nhật elapsed mỗi giây.                                                                                                                                                                                                                                    |
| `KeyHint`                          | `keys: string`, `label: string`                                                                                              | Key bold, nhãn muted; không bắt input.                                                                                                                                                                                                                                                                                                                                                                  |
| `Markdown`                         | `text: string`, `width?=80`                                                                                                  | marked GFM → heading/list/task/nested list/quote/table/link/emphasis/inline code/code block. Link hiện URL như text; HTML hiện literal. Bảng chuyển sang các dòng `Header: value` khi quá hẹp. Lexer lỗi fallback text; depth render giới hạn 24.                                                                                                                                                       |
| `CodeBlock`                        | `code: string`, `language?: string`, `lineNumbers?=false`, `width?: number`                                                  | cli-highlight dùng màu syntax của theme; ngôn ngữ không biết hoặc lỗi thì plain code; tùy chọn gutter số dòng. Không autodetect ngôn ngữ tốn tài nguyên.                                                                                                                                                                                                                                                |
| `Diff`                             | `diff: string`, `maxLines?=20`, `expanded?: boolean`, `onToggle?`, `isActive?=false`, `width?: number`                       | Unified diff, hunk counters old/new, số dòng và màu +/−, source giống file header vẫn được đánh số. Thu gọn và hint Ctrl+O; phím chỉ hoạt động khi focus.                                                                                                                                                                                                                                               |
| `Truncate`                         | `text: string`, `maxLines?=8`, `expanded?: boolean`, `onToggle?`, `isActive?=false`, `width?: number`                        | Thu theo dòng logic, không phải số hàng sau wrap; giữ hint Ctrl+O và số dòng ẩn.                                                                                                                                                                                                                                                                                                                        |
| `TextLine`                         | `children: string`, `width?: number`, các `TextProps` trừ children                                                           | Bọc Ink Box/Text; Ink dùng string-width/wrap-ansi để wrap grapheme/CJK/ANSI theo cell, không tự cắt theo JS string length.                                                                                                                                                                                                                                                                              |

`Diff` và `Truncate`: bỏ `expanded` để dùng state nội bộ; truyền `expanded` để
controlled và cập nhật qua `onToggle`. Callback vẫn được gọi trong uncontrolled
mode. Thay content không tự reset state; đổi React `key` nếu đó là item mới.
`Markdown`, `CodeBlock`, `Diff` giới hạn 262144 ký tự render và hiện marker
truncated. `parseUnifiedDiff(diff): DiffLine[]` export cho kiểm tra hunk thuần.
`safeText(text): string` export cho các label của feature. Đây là lọc điều khiển
terminal, không thay redaction của SDK/security.

## Test harness

Import `ink/testing/index.tsx` (chỉ test):

- `createClientFixture(overrides?: Partial<FutrynBackendPorts>)` trả
  `{client, ports, settings}`: SDK thật trên ports bộ nhớ, không network/OS;
  các thao tác chưa cung cấp throw `UNSUPPORTED`, không fake success.
- `renderInk(element, {fixture?, themeEngine?})` trả instance của
  ink-testing-library, `fixture`, `rerender` vẫn bọc providers. Mặc định no-color,
  dark deterministic; `stdout.columns=100` theo testing library. Test width
  bằng props, không thay terminal thật.
- `await settle()` đợi event/effect/render commit (30 ms) trước khi đọc frame.
- `afterEach(cleanup)` từ ink-testing-library là bắt buộc. Dùng
  `stdin.write('\u001b[B')`, `stdin.write('\r')`, `stdin.write('\u001b')`
  cho ↓, Enter, Esc. Unmount trước khi kiểm tra subscription cleanup.

Test nằm trong `ink/testing/*.test.tsx` nên chạy rõ
`bun test apps/tui/src/ink/testing` (root script `bun test tests` không bao phủ
thư mục này). Root typecheck/lint vẫn bao phủ TypeScript/JSX mới.

## Vùng file Pha 1

Mỗi feature chỉ export qua `index.tsx`/`index.ts`, không import private file
của feature khác; composition app chỉ do Pha 2 ghép. Không sửa SDK/core/security.

| Agent            | Vùng file được sở hữu                                                                                             |
| ---------------- | ----------------------------------------------------------------------------------------------------------------- |
| `tui-transcript` | `ink/features/{transcript,diff,plan,subagents,notices}/**`                                                        |
| `tui-composer`   | `ink/features/{composer,autocomplete,history,paste}/**`                                                           |
| `tui-dialogs`    | `ink/features/{permissions,question,picker,connect,models,sessions,settings,themes,help,memory,agents,skills}/**` |
| `tui-chrome`     | `ink/features/{status,header,welcome,startup-gate,context-meter,usage}/**`                                        |

Đề xuất theo plan: `{index.tsx, logic.ts, view.tsx, use-<name>.ts}`; test đặt
ngay trong feature. Không sửa `ink/app.tsx` để nối feature ở Pha 1; trả component
và hook để `tui-integrate` ghép qua slots. Cần thay API nền thì báo người điều phối.
Transcript giữ thứ tự `parts` (ADR 0021/0028); mọi trạng thái denied/failed/partial
phải thật, không hiện diff như đã apply khi chỉ là proposal.

## Bằng chứng và việc còn lại

Pha 0 kiểm render/snapshot từng primitive, filter/navigation/scroll/empty picker,
Markdown/diff/gutter/folding, input scopes, theme, ba kênh SDK + cleanup, opt-in
qua entry runtime thật trong subprocess, non-TTY một frame và golden TUI cũ.
Pha 1/2 vẫn cần test generation/steering/cancellation, consent/auth, mọi dialog,
PTY terminal teardown/resize, hiệu năng transcript >1000 dòng, và parity đầy đủ.
Chưa nghiệm thu live-provider hay visual trên terminal người dùng.

## Pha 2 amendment — version 0.2 (2026-11-18, ADR 0060)

Phần này supersede các mô tả foundation-only ở trên. Không inject slots thì
InkApp mount IntegratedShell; runtime truyền initialCommand và registerShutdown.
Gate mounted suốt phiên; unlock sau consent + probe, initialCommand chạy một lần.
Shutdown huỷ/drain probe, turn, shell và async command trước unmount; không đóng SDK/backend.
Non-TTY giữ single-frame preview, tools/input tắt, không chạy command.

Overlay content render trực tiếp, không bọc Panel. Input wrappers kiểm active cả
khi callback chạy để event đã dispatch không lọt vào nền vừa mất focus. Ctrl+O mở
history inspection có paging; transcript chính giữ mounted. Reset đổi Static key.
ListPicker bổ sung optional `cursor`, `initialCursor`, `onCursorChange`, `onHighlight`,
`numbered` (default true), `hint` (false ẩn). Cursor theo filtered list; highlight
callback chỉ khi identity của item đổi. PickerDialog nhớ item theo title trong
OverlayProvider; settings giữ section ở host; theme highlight preview và rollback
khi đóng. Permission dùng controlled cursor, giữ nguyên số decision SDK.

SDK contract **1.35** thêm writeMemory qua memory tool (ADR 0060). `#text` tạo note
feedback với metadata rõ, chỉ accept khi tool ok. Không đường vòng filesystem/quyền.

OverlayProvider giữ `tasks: Map<AbortController, Promise<unknown>>` cho tác vụ dialog;
useDialogTask đăng ký/xóa task, abort khi unmount. Host shutdown abort rồi drain
map này cùng gate/turn/shell/commands trước teardown, kể cả discovery/sign-in đang chạy.
