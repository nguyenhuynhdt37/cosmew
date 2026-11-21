# Tool calling, reasoning và coding tools — audit 2026-11-21

Follow-up: the user approved five corrective groups. Implementation and current
verification are tracked in [tool reliability fixes](../delivery/tool-reliability-fixes.md).
The findings below preserve the original audit snapshot; they are not a claim
that all listed gaps remain in the updated tree. Thinking controls for additional
protocols, cache pricing and comparative live benchmarks remain separate work.

## Kết luận

Cosmew có nền tảng agent/tool loop thực sự: dispatch khi arguments hoàn chỉnh,
shared/exclusive scheduling, cancellation, retry giữ tool receipts, compaction,
output archive, coding tools và provider adapters. Chưa có bằng chứng để gọi là
đã tối ưu số call/token/latency/cost hoặc tương đương đầy đủ Codex, OpenCode và
Claude Code. Có các lỗi correctness cần sửa trước khi benchmark tối ưu.

Audit được điều phối thành ba nhánh GPT-6.1 Sol, reasoning medium theo lựa chọn
của người dùng sau khi công cụ từ chối GPT-6.2 Sol. Không sửa source, không gọi
provider tính phí, không đọc credentials và không chạy executable agent upstream.
Các test/probe dùng fixture và dữ liệu tạm. Báo cáo này là file repository duy
nhất được thêm bởi lượt audit.

## Nguồn đối chiếu

- Cosmew: working tree hiện tại, gồm các thay đổi chưa commit. Line references
  dưới đây tương ứng snapshot lúc kiểm tra, không phải một release đã ghim.
- Codex: local `/tmp/codex-audit.To6lHb`, HEAD
  `4739e94260dccd4ec050d457b437a5fc82e3493e`, commit ngày 2026-11-21.
- OpenCode: local `/tmp/opencode-audit2`, HEAD
  `0811b42484cc5d7441c57affcba9382cf53a6535`, commit ngày 2026-11-20.
- Hai HEAD đã được kiểm tra bằng Git với fsmonitor/hooks bị vô hiệu. Không coi
  các revision này là xác minh lại historical pins trong wave-1.
- Provider docs được nhánh reasoning tra qua Context7 ngày 2026-11-21:
  [OpenAI reasoning](https://developers.openai.com/api/docs/guides/reasoning),
  [Responses migration](https://developers.openai.com/api/docs/guides/migrate-to-responses),
  [conversation state](https://developers.openai.com/api/docs/guides/conversation-state),
  [Google thought signatures](https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures),
  [Gemini 3](https://ai.google.dev/gemini-api/docs/generate-content/gemini-3),
  [AI SDK Anthropic](https://ai-sdk.dev/providers/ai-sdk-providers/anthropic),
  [AI SDK Google](https://ai-sdk.dev/providers/ai-sdk-providers/google).
- Claude Code: chưa xác minh mới implementation nội bộ của tool scheduler và
  reasoning replay. Anthropic API support không chứng minh exact Claude CLI
  parity. Phần này **Needs verification**.

## P1 — sửa correctness trước

### 1. Mất provider reasoning state giữa các vòng tool

`packages/models/src/adapter.ts:506–517` giữ reasoning text và tool
id/name/input, bỏ provider metadata. `packages/contracts/src/models.ts:225,
239–240,303–309` không có chỗ giữ structured replay state;
`adapter.ts:114–120,439` chỉ replay reasoning string cho Chat opt-in.

- Responses OAuth đặt `store:false` (`adapter.ts:410`) nhưng không giữ/replay
  encrypted reasoning output items. Effort và summary không thay thế state này.
- Gemini mất thoughtSignature gắn với function-call part. Probe dùng serializer
  thật của ProviderAdapter cho thấy SDK chèn
  `skip_thought_signature_validator` thay chữ ký thật. Không tuyên bố đã quan
  sát HTTP 400 live: installed Google SDK có fallback che một phần lỗi.
- Anthropic thinking chưa có enablement path nên thiếu signed/redacted replay
  vừa là giới hạn contract, vừa là prerequisite trước khi thêm thinking controls.

Codex giữ ResponseItem::Reasoning và encrypted content tại `core/src/client.rs:
1299–1308,1326`, `client_common.rs:98`. OpenCode có reasoning encrypted include
trong `packages/ai/src/protocols/openai-responses.ts:438`, signed/redacted
thinking tại `anthropic-messages.ts:913–928` ở các revision trên.

Hướng sửa: contract version mới cho ordered, provider/protocol/model-bound
opaque replay parts; giữ qua core, persistence, checkpoint và resume. Không mở
arbitrary providerOptions passthrough. Test adapter → core → persistence →
adapter với encrypted-only reasoning, single/parallel/sequential signatures,
restart, cancel và provider switch. Live interoperability **Needs verification**.

### 2. Compaction bỏ evidence nhưng dedup vẫn yêu cầu dùng kết quả cũ

`packages/core/src/agent/turn-tools.ts:258–267` nhớ kết quả trong `seen`, trong
khi `turn.ts:540–541` thay visible history bằng summary. `seen` không bị
invalidate theo evidence còn hiện diện. Kết quả nhỏ không có archive handle.

Probe qua public Conversation: 6 reads, 1 summary; evidence gốc không còn trong
request cuối, reread trả `[unchanged] ... use the earlier result`. Đây là lỗi
đã tái hiện, khiến model không lấy lại được source sau compaction.

Hướng sửa: chỉ dedup khi evidence còn visible/retrievable, hoặc invalidate theo
compaction. Thêm test kết hợp compaction + reread của kết quả không được archive.

### 3. MCP mặc định chạy song song cả tool chưa biết có mutation hay không

`packages/tools/src/handlers/mcp.ts:47–54` hardcode `parallel:true`;
`core/src/agent/turn-tools.ts:172` dùng flag này thật. Các mutation được duyệt có
thể race nhau. Đây không phải bypass permission.

Codex `core/src/tools/handlers/mcp.rs:187–198` opt-in concurrency theo support/
read-only metadata. Hướng sửa: unknown/mutating mặc định exclusive; safe opt-in
không được tự cấp quyền. Test thứ tự read/write và delayed mutations.

### 4. Model-facing shell contract sai so với sandbox defaults

`packages/tools/src/exec/command.ts:70` và `core/src/agent/guidance.ts:39` mô tả
shell như luôn được containment/proxy bảo vệ và sandboxed commands thường không
hỏi. ADR 0081 hiện mặc định sandbox off, autoAllow false. Runtime vẫn theo policy
thật; lỗi nằm ở thông tin model dùng để quyết định hành động.

Hướng sửa: sinh guidance/schema description theo effective trusted configuration,
hoặc mô tả rõ từng điều kiện. Không đổi authorized defaults để khớp mô tả cũ.

### 5. Có thể mở host session nhưng không expose được stdin/poll/interrupt

`packages/tools/src/handlers/command.ts:24–30` cho runtime có unsandboxed capability
launch khi sandbox health không tốt. `handlers/stdin.ts:55` lại yêu cầu
`availability().ok`, nên owned session đó mất transport qua dispatcher. Probe
runtime availability=false, unsandboxed=true xác nhận stdin.available=false.

Hướng sửa: owned-session transport độc lập health của một launch sandbox mới;
vẫn kiểm ownership và launch authority. Thêm regression launch → poll → interrupt.

## P2 — coding tools, context và recovery

| Vấn đề | Evidence | Hướng sửa tối thiểu |
|---|---|---|
| Read continuation bỏ phần cuối dòng bị byte-clip | `tools/src/builtin/read.ts:132–135`; probe 100 dòng × 1999 ký tự cắt giữa dòng 26 nhưng hướng dẫn offset 27 | Cắt ở ranh giới dòng hoặc có partial-line cursor; test pagination không mất dữ liệu/UTF-8 |
| Glob sai newest-first ở additional directory | `tools/src/builtin/search.ts:249–253` join root với candidate absolute; stat sai rồi mtime=0 | Phân biệt absolute/relative path; test reverse mtime/alphabet và >100 candidates |
| MCP không validate advertised input schema | `tools/src/handlers/mcp.ts:59–70`; schema required integer vẫn prepare `{wrong:true}` | Bounded JSON-schema validation trước prompt/call; malformed input không gọi remote |
| Schema MCP lớn bị thay bằng unrestricted object | `mcp/src/servers.ts:298–307`, ngưỡng 8192 chars | Explicit diagnostic/deferred schema, không silently widen |
| MCP application error mất hướng dẫn tự sửa | `mcp/src/client.ts:142`, `servers.ts:261`, `tools/src/handlers/mcp.ts:86` biến isError thành generic transport | Giữ bounded/redacted tool-error text riêng transport exception |
| MCP output bị clip không có retrieval handle | `tools/src/orchestrator.ts:99–110,232–234`; archive kinds bỏ MCP | Archive output captured theo scope/policy, đưa tool_output ref; không tăng output vô hạn |
| Large-read dedup bị UUID archive phá | `tools/src/orchestrator.ts:85–94`, `persistence/src/output-archive.ts:25`, `core/src/agent/turn-tools.ts:261` | So canonical evidence digest, không so host-generated retrieval marker |
| Concurrency cấu hình dưới 4 bị bỏ qua | `core/src/agent/turn.ts:189` dùng Math.max(default,configured) | Tôn trọng lower configured limit và validate bounds; test 1/2/4 slots |
| Thiếu Anthropic/Gemini thinking controls | `models/src/adapter.ts:328–331,407–423`; ADR 0078 ghi rõ | Thêm protocol/model-specific enablement/budget/effort sau khi giữ đúng replay state |
| Cache-adjusted cost chưa có | `models/src/adapter.ts:243–245`, `contracts/src/models.ts:197–201` chỉ có input/output rate | Cache read/write pricing metadata và fixture math; vẫn ghi estimate khi thiếu coverage |

OpenCode `packages/core/src/tool/read-filesystem.ts:243–245` kiểm byte cost theo
whole line trước khi append; `tool/mcp.ts:84–90` giữ text của application error
để model tự sửa. Đây là đối chiếu cụ thể, không phải blanket parity claim.

## Phần đang thừa hoặc quá cứng

- `core/src/agent/guidance.ts:86` nói mọi failed call đều final trong turn trừ khi
  user đổi. Điều này gộp permission denial với sai arguments/path có thể sửa.
  Nên cấm bypass denial/replay unknown mutation, nhưng cho sửa INVALID_INPUT và
  recovery có căn cứ. Đây là prompt overconstraint; không khẳng định runtime đã
  chặn mọi corrective call.
- `core/src/agent/turn.ts:40–43` hardcode hướng dẫn HTML/full-read offset 1 limit
  2000 cho artifact targets nói chung. `progress.ts:70–84` lại dùng nontruncated
  read làm verification evidence. Đọc lại toàn file vừa tốn context vừa không
  chứng minh behavior của TS/Go. Nên chọn verification theo loại task và receipt.
- Full offered schemas và AJV validators được dựng mỗi request
  (`adapter.ts:374–389`; `turn.ts:365–368,474`). Schema-revision caching/deferred
  discovery là ứng viên đo, chưa đủ bằng chứng để gọi là bottleneck lớn.

Không có lý do audit để xoá edit/write/apply_patch: ba tool phục vụ focused exact
replace, new/full-file content và multi-file patch. Giữ ToolDispatcher, permission
revalidation, unknown-outcome handling, Git/state protection và user-only MCP là
chủ đích. Không thêm default 16/32-call cap trái thiết kế long-task hiện tại.

## Kiểm chứng

| Nhánh | Lệnh | Kết quả |
|---|---|---|
| Loop/context | `bun test tests/contracts/model-compaction.test.ts tests/contracts/tool-output-archive.test.ts tests/end-to-end/progressive-exploration.test.ts` | 50 pass, 0 fail, 341 assertions |
| Reasoning | `bun test tests/contracts/reasoning-effort.test.ts tests/contracts/provider-adapters.test.ts tests/end-to-end/deepseek.test.ts` | 43 pass, 0 fail, 179 assertions |
| Coding tools | `bun test tests/security/read-extended.test.ts tests/security/grep-ripgrep.test.ts tests/mcp/user-servers.test.ts` | 28 pass, 0 fail, 177 assertions |

Các suite hiện có xanh nhưng chưa bao phủ các tổ hợp lỗi ở trên. Có thêm probe
in-memory cho compaction/reread, Gemini serializer, read pagination, absolute-path
join, MCP invalid arguments và stdin availability. Không chạy lại full suite
trong lượt này. DeepSeek test mang tên restart hiện chỉ reload stored session cùng
app; cần đóng/mở persistence và gửi turn mới để chứng minh actual restart replay.

## Thứ tự đề xuất

1. Reasoning replay state, compaction/dedup và MCP scheduling correctness.
2. Sửa shell guidance, owned stdin, read pagination và additional-root Glob.
3. MCP schema/error/archive; ổn định dedup/concurrency và task-aware verification.
4. Anthropic/Gemini thinking, cache pricing và actual restart coverage.
5. Benchmark cùng model/effort/task/workspace: successful task completion, số
   request/tool calls, input/cache/output tokens, latency p50/p95, cost coverage,
   recovery sau cancel/error. Chỉ kết luận tối ưu khi có phép đo này.

Live provider behavior, semantic answer quality, exact Claude CLI parity và
non-macOS compatibility còn **Needs verification**.
