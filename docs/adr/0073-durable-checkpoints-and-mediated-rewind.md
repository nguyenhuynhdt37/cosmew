# ADR 0073 — Checkpoint bền và rewind qua dispatcher

Trạng thái: chấp nhận. Ngày: 2026-11-20. Contract 1.38, SQLite 9.

SDK `checkpoints()` trả metadata từng lượt: `promptId`, `text`, `conversationIndex`,
`fileChanges` gồm path và số dòng thêm/xoá. Không trả nội dung snapshot.
`rewind({checkpointId, scope})` nhận `conversation`, `code` hoặc `both`.
Composition root tạo checkpoint trước mỗi lượt người dùng. Persistence sở hữu bảng
`turn_checkpoints` và journal chỉ nối thêm `rewind_events`.

ApplyPatchRuntime lưu nội dung trước sửa và hash/mode dự kiến sau sửa trước khi ghi
file. Edit, write, apply_patch và LSP rename của dispatcher cha dùng chung cơ chế.
Restore gộp checkpoint được chọn với các lượt sau: giữ nội dung ban đầu sớm nhất,
đối chiếu poststate cuối cùng. File thay đổi ngoài dự kiến thì từ chối toàn bộ trước
khi ghi. Crash hoặc partial apply mà poststate không khớp cũng từ chối; không đoán
và không ghi đè sửa đổi của người dùng. Lỗi OS giữa lúc restore nhiều file có thể
đã khôi phục một phần; SDK trả thất bại và giữ nguyên ngữ cảnh hội thoại. Đây không
phải transaction filesystem.

Handler `restore_checkpoint` không xuất hiện trong tool catalog cho model. Handler
đọc preimage đáng tin theo id và tạo patch plan thông thường. Mọi ghi đi qua
ToolDispatcher: chuẩn hoá path → policy/rule → approval/diff → revalidate → audit
→ SecureFiles descriptor-relative. `.git`, state, symlink và path ngoài trusted
roots vẫn bị chặn. SDK không tự ghi filesystem. Lượt cha, shell nền hoặc subagent
còn chạy thì không được rewind.

Rewind hội thoại tạo phiên mới từ lịch sử trước lượt được chọn, nối thông báo
rewind rồi chuyển client sang phiên đó. Phiên gốc và execution journal giữ nguyên.
Đây là lựa chọn fork giữ bằng chứng thay vì sửa/xoá journal cũ. Receipt rewind chỉ
nối thêm, ghi checkpoint, phiên nguồn/đích, scope và thời gian. Code-only giữ phiên
hiện tại. Restart có thể đọc lại checkpoint đã lưu; metadata/preimage checkpoint
được cập nhật khi chuẩn bị patch, không phải journal bất biến.

Giới hạn: 100 checkpoint và 64 MiB mỗi phiên, 16 MiB mỗi checkpoint. Kiểm tra secret
đã đăng ký trên chuỗi thô trước serialization; snapshot có secret bị vô hiệu hoá,
không lưu secret bytes. Không lưu image payload. Metadata prompt/path được redact.
Retention có thể xoá checkpoint cũ.

Phạm vi restore là file văn bản được sửa qua dispatcher cha. Không khôi phục thay
đổi tuỳ ý từ shell/MCP, subagent/worktree, binary hoặc thư mục rỗng mới tạo. Sửa đổi
bên ngoài trên file đã theo dõi gây conflict. Đây không phải snapshot toàn bộ
workspace hay Git reset. OS/live provider ngoài bằng chứng SecureFiles hiện có còn
Needs verification.

Bằng chứng: `tests/contracts/checkpoints.test.ts` dùng filesystem thật qua dispatcher:
restore tích luỹ, conflict, quyền plan, protected roots, secret có newline, đọc lại
persistence và giữ nguyên bằng chứng phiên gốc. Không dùng mock success để chứng
minh tương thích OS/live.
