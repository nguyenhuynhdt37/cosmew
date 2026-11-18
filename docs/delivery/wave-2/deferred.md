# Đợt 2 — việc hoãn lại (làm cùng bước MCP/plugin S6)

Ghi ngày 2026-11-18. Mỗi mục ghi nguồn tham chiếu để phiên sau đọc lại.

## Skills (từ S3)

| Mục | Nguồn | Ghi chú |
|---|---|---|
| Tải skill từ index qua URL (cache + phiên bản) | OpenCode `packages/core/src/skill/discovery.ts` @ `852d5ed` | Làm cùng `mcp_install`: một lần xác nhận, ghim phiên bản, lưu ở cấp user |
| Skill admin `/etc/futryn/skills` | Codex `codex-rs/ext/skills/src/host_roots.rs` (`SkillScope::Admin`) @ `090be4d` | Cần quyết định chính sách quản trị |
| `skill-installer` / tự cài skill theo yêu cầu | Codex skill mẫu `codex-rs/skills/src/assets/samples/skill-installer` | Gộp với tự cài MCP (Registry) |
| Phụ thuộc MCP khai báo trong skill (`dependencies.tools`) | Codex `codex-rs/skills/src/metadata.rs` | Cần MCP stdio/HTTP tổng quát trước |
| Skill trong plugin | Claude Code (plugin `skills/`), Codex `core-plugins` | Làm khi có hệ plugin |
| Skill trên cloud / gói executor | Codex `ext/skills/src/cloud_skill.rs` | Không ưu tiên |

## Đã biết từ UAT, giữ nguyên theo quyết định user

- Session terminal có giới hạn cứng 300 s (`create-next-app` vượt, cài vẫn xong).
- Dev server không tải được Google Fonts khi sandbox không có mạng (bật `network_access = true` nếu cần).
