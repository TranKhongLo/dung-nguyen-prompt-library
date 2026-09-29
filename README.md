# DUNG NGUYEN PROMPTS — V1.4 Stage 3

Full-stack Cloudflare Workers + Static Assets + D1.

## Stage 3
- Giữ toàn bộ Stage 2: SEO, canonical, Open Graph, Twitter Card, JSON-LD, clean prompt URLs, dynamic sitemap, category manager, backup/restore, 9-card latest view, copy-link, PWA shell.
- Related Prompts trên trang chi tiết, ưu tiên prompt cùng category.
- Favorites nâng cấp với migration từ key cũ.
- Collections lưu trực tiếp trên thiết bị: tạo, đổi tên, xóa, thêm/bỏ prompt.
- Prompt detail có Lưu prompt và Thêm vào Collection.
- Trang Đã lưu hỗ trợ lọc theo Collection và quản lý collections.
- Admin Analytics: top lượt xem, top lượt copy, phân bố prompt theo category, prompt mới gần đây.
- Admin prompt editor giữ nguyên slug và preselect đúng category.
- Public API thêm route related prompts.
- View/copy counters không làm thay đổi updated_at, tránh làm sitemap/analytics timestamp bị nhiễu.
- Không cần migration D1 mới.

## Existing bindings / secrets
- Worker: `dung-nguyen-prompts`
- D1 binding: `DB`
- D1 database: `dung-nguyen-prompt-db`
- Secrets: `ADMIN_PASSWORD`, `ADMIN_SESSION_SECRET`

## Deployment
1. Giữ một ZIP backup của repository V1.3.1 đang chạy.
2. Upload toàn bộ nội dung của package này vào root repository hiện tại.
3. Commit trực tiếp vào `main`.
4. Cloudflare Workers Builds sẽ tự động build/deploy.

## Legacy files
Các file legacy của V1 vẫn có thể giữ nguyên trong repository trong thời gian kiểm tra nếu không được tham chiếu:
- `public/assets/styles.css`
- `public/assets/config.js`
- `public/assets/admin.js`
- `public/assets/app.js`

Chỉ xóa chúng trong một cleanup commit riêng sau khi Stage 3 đã được kiểm tra ổn định.

## Storage model
Favorites và Collections ở Stage 3 được lưu trong localStorage của trình duyệt/thiết bị. Không cần đăng nhập và dữ liệu không đồng bộ giữa các thiết bị.
