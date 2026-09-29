# DUNG NGUYEN PROMPTS — V1.3.1 Stage 2

Full-stack Cloudflare Workers + Static Assets + D1.

## Stage 2
- SEO meta, canonical, Open Graph, Twitter Card and JSON-LD on clean prompt URLs.
- Clean prompt URLs: `/prompt/<slug>` with D1 lookup.
- Dynamic sitemap: `/sitemap.xml`.
- Public category chips with published prompt counts.
- Admin Category Manager with prompt counts.
- Admin Backup: Export JSON, Import Merge, Import Replace.
- Backup never contains `ADMIN_PASSWORD` or `ADMIN_SESSION_SECRET`.
- Public home shows newest prompts first; after the ninth card the list becomes scrollable.
- Copy-link actions on cards and detail pages.
- PWA keeps static shell cached but deliberately skips dynamic prompt/admin/API/SEO routes.

## Existing bindings / secrets
This version keeps the existing Worker name, D1 binding and secret names. No new D1 migration is required.

- Worker: `dung-nguyen-prompts`
- D1 binding: `DB`
- D1 database: `dung-nguyen-prompt-db`
- Secrets: `ADMIN_PASSWORD`, `ADMIN_SESSION_SECRET`

## Deployment
Upload the contents of this package to the root of the existing GitHub repository and commit to `main`. Cloudflare Workers Builds will deploy the change automatically.

## Legacy files
The old UI helper files from V1 can be left in the repository during validation if they are not referenced by the V1.3.1 code. After the new version has been tested successfully, they may be deleted in a separate cleanup commit.

Legacy files that are not referenced by V1.3.1:
- `public/assets/styles.css`
- `public/assets/config.js`
- `public/assets/admin.js`
- `public/assets/app.js`

Keep a GitHub ZIP backup before cleanup. GitHub commit history also provides rollback history for the repository.
