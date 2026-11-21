# ADR 0072 — Ảnh đính kèm do người dùng chọn

Trạng thái: chấp nhận. Ngày: 2026-11-20. Contract 1.38.

SDK `attachImage({mediaType, data | path})` chuẩn bị ảnh PNG/JPEG/GIF/WebP và trả id
cùng nhãn `[Image #N]`. `imageAttachments()` chỉ trả metadata;
`removeImageAttachment(id)` bỏ ảnh đang chờ. `sendMessage()` tiếp theo tiêu thụ tối
đa tám ảnh; cho phép tin nhắn chỉ có ảnh. Đổi phiên/account/model xoá ảnh đang chờ.
Không được đính kèm khi đang gửi.

Path do người dùng chọn đi qua tool `read` của ToolDispatcher: folder consent,
trusted roots, deny/ask rule, approval, target revalidation và audit. Văn bản prompt
không tự kích hoạt đọc file. Base64 trực tiếp dùng cùng giới hạn 20 MiB, kiểm tra
signature/cấu trúc và quét secret đã đăng ký theo UTF-8/latin1 như read media. MIME
phải khớp bytes. Đây là kiểm tra cấu trúc tối thiểu, không phải decoder đầy đủ hay
quét secret bằng OCR.

Core nhận ảnh trên message role user. Provider adapter chuyển qua cơ chế vision
hiện có, đặt ảnh cùng nội dung user. Model khai báo unsupported nhận ghi chú văn
bản rõ ràng; unknown được thử như tool media. SDK attachment view không trả bytes.
Ảnh chỉ sống trong request: message bền và journal chỉ lưu nhãn văn bản. Restart/
resume giữ nhãn nhưng không khôi phục bytes; cần đính kèm lại nếu muốn xem ảnh.
Send lỗi hoặc huỷ cũng tiêu thụ ảnh, tránh tự chuyển sang request sau.
Không thêm dependency, dịch vụ ngoài hoặc truy cập clipboard OS.

Bằng chứng: `tests/contracts/image-attachments.test.ts` kiểm tra format/secret,
provider conversion và luồng SDK/dispatcher. Live provider có xác thực còn Needs
verification. Không tuyên bố tương thích clipboard upstream.
