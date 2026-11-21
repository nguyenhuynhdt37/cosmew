# Codex và đối chiếu Hannes

## Codex có cắt kết quả tool không?

### Takeaway
Có. Không thể dùng riêng sự tồn tại của giới hạn 24 KB để kết luận Hannes kém Codex. Khác biệt cần kiểm chứng là ngân sách phù hợp tool/model, tính rõ ràng của preview, khả năng tìm lại bằng chứng và hành vi tiếp tục sau compact.

### Cited Findings
- Đã đọc clone `/tmp/ref-codex`, revision `090be4df0724cdef5758e6a0934ba557af8b6bbe`, commit time 2026-11-16T16:38:13Z; đối chiếu trang GitHub chính thức ngày 2026-11-19. `record_annotated_items` giữ payload gốc trong rollout, nhưng `record_item_with_metadata` cắt output trong live history theo model policy hoặc override của tool, có serialization allowance. Cắt xảy ra khi record item vào history, không phải đợi toàn context gần đầy. — [history.rs L628-L691](https://github.com/openai/codex/blob/090be4df0724cdef5758e6a0934ba557af8b6bbe/codex-rs/core/src/context_manager/history.rs#L628-L691).
- Codex hỗ trợ cả budget byte và token; byte policy dùng middle truncation. Do đó head/tail và mất phần giữa cũng tồn tại upstream. — [output truncation L20-L70](https://github.com/openai/codex/blob/090be4df0724cdef5758e6a0934ba557af8b6bbe/codex-rs/utils/output-truncation/src/lib.rs#L20-L70).
- Unified exec có `max_output_tokens`, mặc định 10,000 token ở revision đã đọc. Đây là cap output của tool, có thể còn cap history riêng; không được so đơn giản 10,000 token với 24,000 byte như hai đại lượng tương đương. — [unified_exec/mod.rs](https://github.com/openai/codex/blob/090be4df0724cdef5758e6a0934ba557af8b6bbe/codex-rs/core/src/unified_exec/mod.rs#L74).
- Tài liệu cấu hình hiện hành xác nhận `tool_output_token_limit` là ngân sách token lưu mỗi output vào history. — [Configuration reference](https://developers.openai.com/codex/config-reference/).
- Source có extension `history.list_windows/list_items/read_item/search_contents` và notes tools. Factory không trả tool khi thiếu backend; phải phân biệt tính năng có trong source với khả năng sẵn cho mọi phiên/model. — [history-notes tools L61-L98](https://github.com/openai/codex/blob/090be4df0724cdef5758e6a0934ba557af8b6bbe/codex-rs/ext/history-notes/src/tools.rs#L61-L98).
- Hannes cũng giữ transcript gốc; chỉ model-visible view bị cắt lại trong `prepareRequest` qua `truncateToolResults`. Marker chứa hash và thông báo thiếu output, không có handle hoặc chỉ dẫn đọc artifact gốc. — [local turn.ts](/Users/huynh/codes/hannes/packages/core/src/agent/turn.ts:431), [local builder.ts](/Users/huynh/codes/hannes/packages/core/src/context/builder.ts:63).

### Inferences
- Cần sửa phát biểu trước đó từ “cắt khi còn context là lỗi” thành “cắt output là tradeoff bình thường; cần đánh giá cap, nội dung bị mất, retrieval và task completion bằng test”.
- Hannes gọi hàm cắt mỗi request nhưng dựng lại từ transcript gốc. Đây không mặc nhiên là cắt lũy tiến mỗi vòng; không nên nói output tiếp tục teo sau mỗi lần nếu không có bằng chứng.

### Gaps
- Không xác minh live Codex các extension history/notes được offer ở những model/deployment nào. Không tuyên bố mọi shell output bị cắt đều có artifact file đọc lại tự động.

## Compact có dừng việc dùng tool không?

### Takeaway
Codex compact để tiếp tục cùng turn khi còn follow-up. Hannes có khoảng ngưỡng 85–90% có thể rút tool trước khi auto compact được thử; đây là vấn đề logic cụ thể hơn cáo buộc “cắt output làm yếu”.

### Cited Findings
- Model default auto-compact threshold là 90% resolved context; explicit limit bị clamp không vượt 90%. Ngoài ra source hiện có usable window, scopes và token-budget fallback nên không mô tả tất cả runtime bằng một con số cứng. — [openai_models.rs L571-L589](https://github.com/openai/codex/blob/090be4df0724cdef5758e6a0934ba557af8b6bbe/codex-rs/protocol/src/openai_models.rs#L571-L589), [context_window.rs L82-L127](https://github.com/openai/codex/blob/090be4df0724cdef5758e6a0934ba557af8b6bbe/codex-rs/core/src/session/context_window.rs#L82-L127).
- Khi model cần follow-up hoặc có pending input và đã tới limit, turn loop gọi `run_auto_compact`; `Ok(true)` dẫn đến `continue`, không bắt model kết thúc bằng một lượt không tools. — [session/turn.rs L717-L832](https://github.com/openai/codex/blob/090be4df0724cdef5758e6a0934ba557af8b6bbe/codex-rs/core/src/session/turn.rs#L717-L832).
- Hannes thử compact khi measure >= 90%, nhưng sau đó nếu used >= 85% ở round > 0 sẽ set `stop=context_window`, `available=[]`. Đây là thứ tự thực thi trực tiếp trong code. — [turn.ts](/Users/huynh/codes/hannes/packages/core/src/agent/turn.ts:380), [threshold](/Users/huynh/codes/hannes/packages/core/src/agent/turn-types.ts:30), [withdrawal](/Users/huynh/codes/hannes/packages/core/src/agent/turn.ts:437).

### Inferences
- Ví dụ measure/used = 87% với output nhỏ không bị cắt: không vào compact guard; set stop và rút tools. Khi tăng dần từ dưới 85%, turn có thể dừng trước khi tới 90%. Nếu nhảy thẳng từ <85% lên >=90%, compact vẫn có cơ hội chạy. Không được nói compact “luôn không chạy”.
- Hướng sửa: một state machine áp lực context: đo request thực -> compact trước khi cần rút tools -> đo lại -> tiếp tục nếu đủ chỗ; chỉ kết thúc có diagnostic khi compact thất bại/không giảm, active evidence vẫn không fit hoặc user budget hết.
- Test hữu ích: tăng dần qua 85–90% vẫn gọi được tool sau compact; nhảy qua threshold; summary thất bại/không giảm; cancellation; giữ pairing call/result và user constraints. Không chỉ test số token giảm.

### Gaps
- Chưa có benchmark cùng model/cùng task và live trace của phiên người dùng đang phản ánh. Source logic chứng minh một failure path có thể xảy ra, chưa chứng minh đây là nguyên nhân duy nhất trong phiên đó.

## Áp dụng gì cho Hannes?

### Takeaway
Ưu tiên sửa lifecycle compact/continue, sau đó làm output có thể truy hồi và đo bằng chứng hữu ích. Không tăng số tool call như mục tiêu chất lượng.

### Cited Findings
- Upstream vừa cắt output có budget vừa compact rồi tiếp tục; hai cơ chế giải quyết hai mức áp lực khác nhau. — [history.rs](https://github.com/openai/codex/blob/090be4df0724cdef5758e6a0934ba557af8b6bbe/codex-rs/core/src/context_manager/history.rs#L628-L691), [turn.rs](https://github.com/openai/codex/blob/090be4df0724cdef5758e6a0934ba557af8b6bbe/codex-rs/core/src/session/turn.rs#L767-L814).

### Inferences
- Đề xuất thiết kế cho Hannes: giữ full redacted bounded output tại persistence-owned artifact, trả preview + opaque id + paging/search qua ToolDispatcher. Không dùng hash đơn lẻ như retrieval interface. Dữ liệu artifact giữ security/session/workspace scope và quyền hiện tại; tuyệt đối không tạo đường đọc vòng dispatcher.
- Cho phép đọc file range hoặc output page cụ thể mà không lại cắt mất phần yêu cầu; cap mặc định theo tool và ngân sách model, vẫn giới hạn output lớn. Giữ bằng chứng mới và pending calls qua compact; summary lưu mục tiêu, constraints, quyết định, path/source ids và phần chưa xác minh.
- Đo A/B cùng model/task: completion correctness, retrieval of middle-file evidence, read redundancy, context bytes/tokens, compactions, latency. Tool count chỉ là diagnostic.

### Gaps
- Đây là đề xuất, chưa triển khai và chưa live nghiệm thu. Mọi thay đổi public contract cần version/consumer updates/ADR theo AGENTS.md.
