# DUNG NGUYEN PROMPT LIBRARY v1.3

Cloudflare Workers + Static Assets + D1.

## V1.3
- SEO + dynamic Open Graph metadata for clean prompt URLs
- `/prompt/<slug>` URLs
- Dynamic sitemap
- Category filter on public homepage
- Admin Category Manager
- Admin statistics
- Admin JSON export/import backup
- PWA manifest + service worker
- Public Favorites + Collections stored locally on the device
- Prompt Builder (Smart Template mode, no API key required)
- Fast copy-link actions
- Mobile-first UI

## Existing D1 schema
This release is compatible with the existing `categories` and `prompts` tables already created for the project. No migration is required.

## Secrets
Keep:
- `ADMIN_PASSWORD`
- `ADMIN_SESSION_SECRET`

No secret is stored in the repository.
