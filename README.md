# DUNG NGUYEN PROMPTS — V1.5 Stage 4

V1.5 builds on the stable V1.4 Stage 3 release.

## New in V1.5
- Server-side Gemini AI Prompt Builder.
- Automatic Smart Template fallback when Gemini is not configured.
- Admin Prompt Version History with restore.
- Version history included in backup/restore.
- Security hardening: security headers, same-origin checks, body-size limits, login/AI rate limiting, constant-time password comparison.
- `GEMINI_API_KEY` is a Cloudflare Worker Secret and is never exposed to browser code.
- `GEMINI_MODEL` is configurable in `wrangler.jsonc`.

## Existing infrastructure
- Worker: `dung-nguyen-prompts`
- D1: `dung-nguyen-prompt-db`
- D1 binding: `DB`
- Assets binding: `ASSETS`
- Existing secrets: `ADMIN_PASSWORD`, `ADMIN_SESSION_SECRET`
- Custom domain: `shareprompt.dungnguyen.pp.ua`

## Gemini setup
In Cloudflare Dashboard: Workers & Pages → `dung-nguyen-prompts` → Settings → Variables and Secrets → Add variable → Secret.

Name: `GEMINI_API_KEY`

Paste the Gemini API key and deploy the Worker after saving it. The Builder checks `/api/ai/status` without revealing the secret.

Default model: `gemini-3.8-flash`. Change the `GEMINI_MODEL` variable if your Gemini project uses another available model.

Never put Gemini API keys in `public/` or GitHub.

Legacy V1.3 files can remain until a later cleanup commit: `public/assets/styles.css`, `config.js`, `admin.js`, `app.js`.


## V1.5 Multi-Provider API Keys

AI Builder now supports Gemini, OpenAI, Anthropic Claude, OpenRouter, Groq and DeepSeek using session-only API keys. Keys are accepted per request and are not written to D1, GitHub, cookies, localStorage, sessionStorage, IndexedDB or backup files.


## V1.5 Multi-Provider Fix v2

- Gemini model dropdown includes Gemini 3.8 Flash, 3.7 Flash, 3.6 Flash, 3.5 Flash, 3.5 Flash-Lite, and 3.1 Flash-Lite.
- Provider test now reports HTTP status, error code, model, and truncated upstream detail.
- 400/401/402/403/404/429/500/503 are mapped to actionable Vietnamese messages.
- Model can be selected from the list or entered as a custom Model ID.
- API keys remain session-only in memory and are not stored in localStorage, sessionStorage, IndexedDB, D1, cookies, GitHub, or backups.
