# ADR 0028 — Transcript kiểu Claude Code và rule quyền theo dự án

Accepted 2026-11-16 theo yêu cầu của người dùng: các lệnh và giao diện theo chuẩn Claude CLI (`/permissions` để cài đặt; cách hiện bash và thinking), vì màu sắc và cách chia hiện tại khó nhìn. Người dùng chọn "Giống Claude Code" và "Rule như Claude". Thay phần trình bày của ADR 0021; timeline `parts` theo thứ tự đến vẫn giữ nguyên.

## Transcript

- Tin nhắn của người dùng: `> prompt` trên một dải nền nhạt (pha 7% chữ vào nền).
- Câu trả lời: `⏺ text`. Thinking: một dòng `✻ Thought · tiêu đề` (`✻ Thinking…` khi đang chạy); Ctrl+R hoặc click để mở thân, hiện thụt lề, mờ, nghiêng.
- Mỗi lần gọi tool là một khối: `⏺ Tên(tham số)` (tên in đậm màu accent, chấm xanh khi xong, đỏ khi lỗi hoặc bị từ chối, accent khi đang chạy), rồi `⎿` với kết quả: `Read N lines`, `Found N files/matches`, 4 dòng đầu output của Bash rồi `… +N lines`, hoặc trạng thái và diff của Update. Header tối đa 2 dòng rồi `…`; click mở ra tham số và output đầy đủ.
- Ký tự điều khiển trong tên hoặc tham số do model chọn bị loại bỏ trước khi vẽ.
- Tool native của runtime (ADR 0027) giờ là event riêng `activity` (`RuntimeActivity`: id, name, label, status, output) và được vẽ giống hệt tool của Hannes. Event này chỉ để hiển thị, không bao giờ thành tool call hay result của Hannes, và đi qua redactor như text.

## Rule quyền

`/permissions` khi không có yêu cầu đang chờ mở trang Allow / Ask / Deny / Mode. Rule được lưu theo đường dẫn workspace trong `settings.projectPermissionRules`. Trường này là tuỳ chọn và thêm mới, nên file cũ vẫn đọc được mà không cần migration; dữ liệu nằm trong SQLite của Hannes, không ghi file vào repo. Cú pháp rule:

- `Bash` hoặc `Bash(npm test:*)` (khớp tiền tố theo từ) hoặc `Bash(lệnh chính xác)`.
- `Read(glob)` và `Edit(glob)`: glob tương đối với workspace; `**` khớp mọi thư mục.
- `WebFetch(domain:host)`, `Tool(name)`.

Thứ tự quyết định: deny > ask > allow, rồi mới đến chế độ của phiên. Lệnh Bash được tách theo `;`, `&&`, `||`, `|`, `&` và xuống dòng: deny hoặc ask khi bất kỳ lệnh con nào khớp, allow chỉ khi mọi lệnh con đều khớp. Lệnh có `$(…)`, backtick hoặc `<`/`>` không bao giờ được allow tự động. Gợi ý [4] không đưa ra tiền tố cho trình thông dịch hay wrapper (`bash`, `python`, `node`, `sudo`, `env`…) mà chỉ đưa đúng nguyên lệnh, và không xuất hiện với lệnh nối. Một patch nhiều đường dẫn bị deny hoặc ask nếu bất kỳ đường dẫn nào khớp, và chỉ được allow khi mọi đường dẫn đều được allow. Rule chỉ trả lời các yêu cầu mà policy để ở `ask` (Hannes) hoặc runtime gửi lên. Luật chặn cứng không đổi: ngoài workspace, `.git`, state của Hannes. Rule chỉ xét đích có cấu trúc, đúng nguyên văn và không bị cắt: lệnh hoặc đường dẫn gốc (`rawInput.command`, `command`, `fullCommandText`…). Nhãn hiển thị (đã cắt, thay ký tự điều khiển) không bao giờ được xét; yêu cầu chỉ có tiêu đề (`ruleTarget: null`, ví dụ file-change của Codex hay tool `other`) đi thẳng tới chế độ. Đường dẫn được chuẩn hoá trước khi khớp: đường dẫn có `..` thoát khỏi workspace, đường dẫn tuyệt đối ngoài workspace hay `~` không bao giờ được allow (deny vẫn nhìn xuyên qua `..`). Lệnh có ký tự điều khiển, kể cả `\r`, không được allow. `WebFetch` chỉ coi là host một URL hợp lệ hoặc một hostname trần.

Hộp duyệt có lựa chọn "[4] Yes, and don't ask again for `Bash(npm test:*)`": lưu rule Allow được gợi ý rồi duyệt một lần. Lựa chọn này chỉ có khi gợi ý được rule. Các nhãn lựa chọn đổi thành Yes / Yes, for this session / No.

## Bằng chứng

Fixture: khớp rule và thứ tự ưu tiên; rule áp lên yêu cầu native của Grok (allow bỏ qua prompt, deny thắng ở bypass, ask vẫn hỏi ở bypass, lưu theo dự án); sửa rule bằng bàn phím trong `/permissions`; lựa chọn [4] lưu rule; các frame transcript và golden đã ghi lại. Chưa chụp được ảnh giao diện có màu (trình duyệt không khởi động được); người dùng đã gửi ảnh chụp theme sáng.
