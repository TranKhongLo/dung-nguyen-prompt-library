const JSON_HEADERS = {
  "content-type": "application/json; charset=UTF-8",
  "cache-control": "no-store"
};
const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "cross-origin-opener-policy": "same-origin",
  "content-security-policy": "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; img-src 'self' data: https:; font-src 'self' data: https:; connect-src 'self' https://generativelanguage.googleapis.com; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; form-action 'self'"
};

function withSecurityHeaders(headers = {}) {
  return { ...SECURITY_HEADERS, ...headers };
}

function secureResponse(response) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    if (!headers.has(key)) headers.set(key, value);
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function serveAsset(env, request) {
  return secureResponse(await env.ASSETS.fetch(request));
}

function clientKey(request, suffix = "") {
  const ip = request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || "unknown";
  return `${ip}:${suffix}`;
}

const rateBuckets = new Map();
function consumeRateLimit(key, limit, windowMs) {
  const now = Date.now();
  const current = rateBuckets.get(key);
  if (!current || current.resetAt <= now) {
    rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true };
  }
  if (current.count >= limit) {
    return { allowed: false, retryAfter: Math.ceil((current.resetAt - now) / 1000) };
  }
  current.count += 1;
  return { allowed: true };
}
function resetRateLimit(key) { rateBuckets.delete(key); }
function sameOrigin(request, url) {
  const origin = request.headers.get("Origin");
  return !origin || origin === url.origin;
}
async function readJsonBody(request, maxBytes = 256 * 1024) {
  const length = Number(request.headers.get("Content-Length") || 0);
  if (length && length > maxBytes) throw new Error("Dữ liệu gửi lên quá lớn.");
  const textBody = await request.text();
  if (new TextEncoder().encode(textBody).byteLength > maxBytes) throw new Error("Dữ liệu gửi lên quá lớn.");
  if (!textBody.trim()) return {};
  return JSON.parse(textBody);
}
async function safeEqual(left, right) {
  const encoder = new TextEncoder();
  const a = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(String(left))));
  const b = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(String(right))));
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) diff |= (a[i % a.length] || 0) ^ (b[i % b.length] || 0);
  return diff === 0;
}

let versionSchemaPromise = null;
async function ensureVersionSchema(env) {
  if (!versionSchemaPromise) {
    versionSchemaPromise = (async () => {
      await env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS prompt_versions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          prompt_id INTEGER NOT NULL,
          version INTEGER NOT NULL,
          title TEXT NOT NULL,
          slug TEXT NOT NULL,
          description TEXT DEFAULT '',
          content TEXT NOT NULL,
          category_id INTEGER,
          tags TEXT DEFAULT '',
          featured INTEGER NOT NULL DEFAULT 0,
          published INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          note TEXT DEFAULT '',
          UNIQUE(prompt_id, version)
        )
      `).run();
      await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_prompt_versions_prompt_id ON prompt_versions(prompt_id)`).run();
    })().catch(error => { versionSchemaPromise = null; throw error; });
  }
  await versionSchemaPromise;
}

async function backfillInitialVersion(env, promptId) {
  await ensureVersionSchema(env);
  const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM prompt_versions WHERE prompt_id = ?`).bind(Number(promptId)).first();
  if (Number(count?.n || 0) > 0) return;
  const current = await getPromptRow(env, promptId);
  if (current) await savePromptVersion(env, current, "Baseline trước V1.5");
}

async function backfillAllPromptVersions(env) {
  await ensureVersionSchema(env);
  const rows = await env.DB.prepare(`SELECT id FROM prompts`).all();
  for (const row of rows.results || []) await backfillInitialVersion(env, Number(row.id));
}
async function savePromptVersion(env, prompt, note = "") {
  if (!prompt?.id) return null;
  await ensureVersionSchema(env);
  const next = await env.DB.prepare(`SELECT COALESCE(MAX(version),0)+1 AS next_version FROM prompt_versions WHERE prompt_id = ?`).bind(Number(prompt.id)).first();
  const version = Number(next?.next_version || 1);
  await env.DB.prepare(`
    INSERT INTO prompt_versions (prompt_id,version,title,slug,description,content,category_id,tags,featured,published,note)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).bind(Number(prompt.id), version, String(prompt.title||""), String(prompt.slug||""), String(prompt.description||""), String(prompt.content||""), prompt.category_id==null?null:Number(prompt.category_id), String(prompt.tags||""), Number(prompt.featured||0), Number(prompt.published==null?1:prompt.published), String(note||"")).run();
  return version;
}
async function getPromptRow(env, id) {
  return env.DB.prepare(`SELECT p.*, c.name AS category_name, c.slug AS category_slug FROM prompts p LEFT JOIN categories c ON c.id=p.category_id WHERE p.id=? LIMIT 1`).bind(Number(id)).first();
}
async function getPromptVersions(env, promptId) {
  await backfillInitialVersion(env, promptId);
  const result = await env.DB.prepare(`SELECT id,prompt_id,version,title,slug,description,content,category_id,tags,featured,published,created_at,note FROM prompt_versions WHERE prompt_id=? ORDER BY version DESC LIMIT 100`).bind(Number(promptId)).all();
  return result.results || [];
}
async function restorePromptVersion(env, promptId, version) {
  await ensureVersionSchema(env);
  const current = await getPromptRow(env, promptId);
  if (!current) throw new Error("Không tìm thấy prompt.");
  const target = await env.DB.prepare(`SELECT * FROM prompt_versions WHERE prompt_id=? AND version=? LIMIT 1`).bind(Number(promptId), Number(version)).first();
  if (!target) throw new Error("Không tìm thấy phiên bản cần khôi phục.");
  await savePromptVersion(env, current, `Snapshot trước khi khôi phục phiên bản ${Number(version)}`);
  await env.DB.prepare(`UPDATE prompts SET title=?,description=?,content=?,category_id=?,tags=?,featured=?,published=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(String(target.title||""), String(target.description||""), String(target.content||""), target.category_id==null?null:Number(target.category_id), String(target.tags||""), Number(target.featured||0), Number(target.published==null?1:target.published), Number(promptId)).run();
  return getPromptRow(env, promptId);
}
function smartTemplatePrompt(input) {
  const topic=String(input.topic||"").trim(), goal=String(input.goal||"Tạo nội dung").trim(), tool=String(input.tool||"").trim(), style=String(input.style||"cinematic, realistic, detailed").trim(), tone=String(input.tone||"deep, emotional, professional").trim(), format=String(input.format||"9:16").trim(), duration=String(input.duration||"").trim(), language=String(input.language||"Vietnamese").trim(), details=String(input.details||"").trim();
  return `You are a professional AI content creator. Create a production-ready ${goal.toLowerCase()} prompt.\n\nSUBJECT:\n${topic}\n\nAI TOOL:\n${tool||"Use the most suitable AI tool."}\n\nSTYLE:\n${style}\n\nEMOTIONAL TONE:\n${tone}\n\nFORMAT / ASPECT RATIO:\n${format}\n\nDURATION:\n${duration||"Not specified"}\n\nLANGUAGE:\n${language}\n\nADDITIONAL DETAILS:\n${details||"Use coherent cinematic details and preserve the core subject."}\n\nQUALITY REQUIREMENTS:\nClear subject hierarchy, coherent composition, intentional camera language, realistic lighting, strong atmosphere, consistent details, professional visual language, useful technical specificity, no unnecessary text, no distorted anatomy, no duplicated objects.`;
}

const PROVIDER_CONFIG = {
  gemini: {
    label: "Google Gemini",
    endpoint: "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
    kind: "gemini",
    defaultModel: "gemini-3.8-flash"
  },
  openai: {
    label: "OpenAI",
    endpoint: "https://api.openai.com/v1/chat/completions",
    kind: "openai",
    defaultModel: "gpt-5"
  },
  anthropic: {
    label: "Anthropic Claude",
    endpoint: "https://api.anthropic.com/v1/messages",
    kind: "anthropic",
    defaultModel: "claude-sonnet-4"
  },
  openrouter: {
    label: "OpenRouter",
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    kind: "openai-compatible",
    defaultModel: "openai/gpt-5"
  },
  groq: {
    label: "Groq",
    endpoint: "https://api.groq.com/openai/v1/chat/completions",
    kind: "openai-compatible",
    defaultModel: "openai/gpt-oss-20b"
  },
  deepseek: {
    label: "DeepSeek",
    endpoint: "https://api.deepseek.com/chat/completions",
    kind: "openai-compatible",
    defaultModel: "deepseek-flash"
  }
};

function providerConfig(provider) {
  const key = String(provider || "").trim().toLowerCase();
  return PROVIDER_CONFIG[key] || null;
}

async function generateWithSessionProvider(provider, apiKey, model, input, options = {}) {
  const config = providerConfig(provider);
  const key = String(apiKey || "").trim();
  if (!config) throw new Error("Nhà cung cấp AI không được hỗ trợ.");
  if (!key) throw new Error("API key đang trống.");
  const finalModel = String(model || config.defaultModel).trim();
  if (!finalModel) throw new Error("Model đang trống.");

  const instruction = `You are the senior prompt engineer for DUNG NGUYEN PROMPTS.\nReturn one polished, ready-to-paste AI prompt in Vietnamese unless the user explicitly asks for English or bilingual output.\nStructure the answer with clear headings such as MASTER PROMPT, CAMERA, LIGHTING, MOTION, AUDIO, NEGATIVE PROMPT when relevant.\nDo not add meta commentary. Do not wrap the answer in JSON or code fences.\nPreserve user intent while making the prompt specific, production-ready, and technically useful.`;
  const userText = [
    `Chủ đề: ${String(input.topic || "").trim()}`,
    `Mục tiêu: ${String(input.goal || "Tạo nội dung").trim()}`,
    `Công cụ AI: ${String(input.tool || "").trim()}`,
    `Phong cách: ${String(input.style || "").trim()}`,
    `Tông cảm xúc: ${String(input.tone || "").trim()}`,
    `Tỷ lệ/format: ${String(input.format || "").trim()}`,
    `Thời lượng: ${String(input.duration || "").trim()}`,
    `Ngôn ngữ: ${String(input.language || "Vietnamese").trim()}`,
    `Chi tiết bổ sung: ${String(input.details || "").trim()}`
  ].join("\n");

  const testMode = Boolean(options.test);

  let endpoint = config.endpoint.replace("{model}", encodeURIComponent(finalModel));
  let headers = { "content-type": "application/json" };
  let body;

  if (config.kind === "gemini") {
    headers["x-goog-api-key"] = key;
    body = {
      contents: [{ parts: [{ text: testMode ? "Reply with exactly: OK" : userText }] }],
      system_instruction: { parts: [{ text: testMode ? "Reply with exactly: OK" : instruction }] },
      generationConfig: { temperature: testMode ? 0 : 0.8, maxOutputTokens: testMode ? 16 : 4096 }
    };
  } else if (config.kind === "anthropic") {
    headers["x-api-key"] = key;
    headers["anthropic-version"] = "2023-06-01";
    body = {
      model: finalModel,
      max_tokens: testMode ? 16 : 4096,
      temperature: testMode ? 0 : 0.8,
      system: testMode ? "Reply with exactly: OK" : instruction,
      messages: [{ role: "user", content: testMode ? "Reply with exactly: OK" : userText }]
    };
  } else {
    headers["authorization"] = `Bearer ${key}`;
    if (provider === "openrouter") {
      headers["http-referer"] = "https://shareprompt.dungnguyen.pp.ua";
      headers["x-title"] = "DUNG NGUYEN PROMPTS";
    }
    body = {
      model: finalModel,
      messages: [
        { role: "system", content: testMode ? "Reply with exactly: OK" : instruction },
        { role: "user", content: testMode ? "Reply with exactly: OK" : userText }
      ],
      temperature: testMode ? 0 : 0.8,
      max_tokens: testMode ? 16 : 4096
    };
    if (provider === "deepseek" && !testMode) {
      body.thinking = { type: "enabled" };
    }
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error("Nhà cung cấp AI trả về lỗi. Hãy kiểm tra API key, model hoặc quota.");
    error.status = response.status;
    error.provider = provider;
    error.upstream = String(data?.error?.message || data?.message || "").slice(0, 240);
    throw error;
  }

  let result = "";
  if (config.kind === "gemini") {
    result = data?.candidates?.[0]?.content?.parts?.map(p => p?.text || "").join("\n").trim() || "";
  } else if (config.kind === "anthropic") {
    result = (data?.content || []).map(part => part?.text || "").join("\n").trim();
  } else {
    result = String(data?.choices?.[0]?.message?.content || "").trim();
  }
  if (!result) throw new Error("Nhà cung cấp AI không trả về nội dung.");
  return { configured: true, text: result, model: finalModel, provider, testMode, fallback: false };
}

async function generateWithGemini(env, input) {
  const apiKey=String(env.GEMINI_API_KEY||"").trim();
  if (!apiKey) return {configured:false,text:smartTemplatePrompt(input),model:null,fallback:true};
  const model=String(env.GEMINI_MODEL||"gemini-3.8-flash").trim();
  const instruction=`You are the senior prompt engineer for DUNG NGUYEN PROMPTS.\nReturn one polished, ready-to-paste AI prompt in Vietnamese unless the user explicitly asks for English or bilingual output.\nStructure the answer with clear headings such as MASTER PROMPT, CAMERA, LIGHTING, MOTION, AUDIO, NEGATIVE PROMPT when relevant.\nDo not add meta commentary. Do not wrap the answer in JSON or code fences.\nPreserve user intent while making the prompt specific, production-ready, and technically useful.`;
  const userText=[`Chủ đề: ${String(input.topic||"").trim()}`,`Mục tiêu: ${String(input.goal||"Tạo nội dung").trim()}`,`Công cụ AI: ${String(input.tool||"").trim()}`,`Phong cách: ${String(input.style||"").trim()}`,`Tông cảm xúc: ${String(input.tone||"").trim()}`,`Tỷ lệ/format: ${String(input.format||"").trim()}`,`Thời lượng: ${String(input.duration||"").trim()}`,`Ngôn ngữ: ${String(input.language||"Vietnamese").trim()}`,`Chi tiết bổ sung: ${String(input.details||"").trim()}`].join("\n");
  const endpoint=`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const response=await fetch(endpoint,{method:"POST",headers:{"content-type":"application/json","x-goog-api-key":apiKey},body:JSON.stringify({system_instruction:{parts:[{text:instruction}]},contents:[{role:"user",parts:[{text:userText}]}],generationConfig:{temperature:0.8,maxOutputTokens:4096}})});
  const data=await response.json().catch(()=>({}));
  if (!response.ok) { const err=new Error(data?.error?.message||"Gemini API trả về lỗi."); err.status=response.status; throw err; }
  const text=data?.candidates?.[0]?.content?.parts?.map(p=>p?.text||"").join("\n").trim();
  if (!text) throw new Error("Gemini không trả về nội dung prompt.");
  return {configured:true,text,model,fallback:false};
}

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: withSecurityHeaders({ ...JSON_HEADERS, ...extra })
  });
}

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: withSecurityHeaders({
      "content-type": "text/html; charset=UTF-8",
      "cache-control": "no-store"
    })
  });
}

function xml(body, status = 200) {
  return new Response(body, {
    status,
    headers: withSecurityHeaders({
      "content-type": "application/xml; charset=UTF-8",
      "cache-control": "public, max-age=3600"
    })
  });
}

function text(body, status = 200) {
  return new Response(body, {
    status,
    headers: withSecurityHeaders({
      "content-type": "text/plain; charset=UTF-8",
      "cache-control": "no-store"
    })
  });
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeJsonForHtml(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\\u2028/g, "\\u2028")
    .replace(/\\u2029/g, "\\u2029");
}

function getCookie(request, name) {
  const cookie = request.headers.get("Cookie") || "";
  for (const part of cookie.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

function toBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromBase64Url(value) {
  const padded = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function hmac(value, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(value)
  );
  return toBase64Url(new Uint8Array(signature));
}

async function verifyHmac(value, signature, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );

  return crypto.subtle.verify(
    "HMAC",
    key,
    fromBase64Url(signature),
    new TextEncoder().encode(value)
  );
}

async function createSession(secret) {
  const payload = JSON.stringify({
    iat: Date.now(),
    exp: Date.now() + 1000 * 60 * 60 * 24 * 7
  });

  const encoded = toBase64Url(
    new TextEncoder().encode(payload)
  );

  return `${encoded}.${await hmac(encoded, secret)}`;
}

async function verifySession(request, secret) {
  if (!secret) return false;

  try {
    const token = getCookie(
      request,
      "dn_admin_session"
    );

    if (!token) return false;

    const [encoded, signature] = token.split(".");

    if (!encoded || !signature) return false;

    if (!(await verifyHmac(encoded, signature, secret))) {
      return false;
    }

    const payload = JSON.parse(
      new TextDecoder().decode(
        fromBase64Url(encoded)
      )
    );

    return Number(payload.exp || 0) > Date.now();
  } catch {
    return false;
  }
}

async function requireAdmin(request, env) {
  return verifySession(
    request,
    env.ADMIN_SESSION_SECRET
  );
}

function slugify(text) {
  return String(text)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
}

async function uniqueSlug(env, title, excludeId = null) {
  const base = slugify(title) || `prompt-${Date.now()}`;
  let slug = base;
  let n = 2;

  while (true) {
    const row = await env.DB
      .prepare(`SELECT id FROM prompts WHERE slug = ?`)
      .bind(slug)
      .first();

    if (!row || (excludeId && Number(row.id) === Number(excludeId))) {
      return slug;
    }

    slug = `${base}-${n++}`;
  }
}

async function uniqueCategorySlug(env, value, excludeId = null) {
  const base = slugify(value) || `category-${Date.now()}`;
  let slug = base;
  let n = 2;

  while (true) {
    const row = await env.DB
      .prepare(`SELECT id FROM categories WHERE slug = ?`)
      .bind(slug)
      .first();

    if (!row || (excludeId && Number(row.id) === Number(excludeId))) {
      return slug;
    }

    slug = `${base}-${n++}`;
  }
}

async function getPrompts(env, url, admin = false) {
  const q = (url.searchParams.get("q") || "").trim();
  const category = (url.searchParams.get("category") || "").trim();
  const featured = url.searchParams.get("featured");
  const requestedLimit = Number(url.searchParams.get("limit") || 200);
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(Math.floor(requestedLimit), 1), 500)
    : 200;

  let sql = `
    SELECT
      p.id,
      p.title,
      p.slug,
      p.description,
      p.category_id,
      p.content,
      p.tags,
      p.featured,
      p.published,
      p.views,
      p.copies,
      p.created_at,
      p.updated_at,
      c.name AS category_name,
      c.slug AS category_slug
    FROM prompts p
    LEFT JOIN categories c ON c.id = p.category_id
    WHERE 1=1
  `;

  const params = [];

  if (!admin) {
    sql += ` AND p.published = 1 `;
  }

  if (q) {
    sql += `
      AND (
        p.title LIKE ?
        OR p.description LIKE ?
        OR p.content LIKE ?
        OR p.tags LIKE ?
      )
    `;

    const needle = `%${q}%`;
    params.push(
      needle,
      needle,
      needle,
      needle
    );
  }

  if (category) {
    sql += ` AND c.slug = ? `;
    params.push(category);
  }

  if (featured === "1") {
    sql += ` AND p.featured = 1 `;
  }

  if (featured === "1") {
    sql += ` ORDER BY p.featured DESC, p.created_at DESC `;
  } else {
    sql += ` ORDER BY p.created_at DESC `;
  }

  sql += ` LIMIT ${limit}`;

  const result = await env.DB
    .prepare(sql)
    .bind(...params)
    .all();

  return result.results || [];
}

async function getCategories(env, includeAllPromptCounts = false) {
  const joinFilter = includeAllPromptCounts
    ? ""
    : "AND p.published = 1";

  const result = await env.DB
    .prepare(`
      SELECT
        c.id,
        c.name,
        c.slug,
        c.description,
        c.created_at,
        COUNT(p.id) AS prompt_count
      FROM categories c
      LEFT JOIN prompts p
        ON p.category_id = c.id
        ${joinFilter}
      GROUP BY
        c.id,
        c.name,
        c.slug,
        c.description,
        c.created_at
      ORDER BY c.name ASC
    `)
    .all();

  return result.results || [];
}

async function findPrompt(env, key) {
  const numeric = /^\d+$/.test(key);

  if (numeric) {
    return env.DB
      .prepare(`
        SELECT
          p.*,
          c.name AS category_name,
          c.slug AS category_slug
        FROM prompts p
        LEFT JOIN categories c ON c.id = p.category_id
        WHERE p.id = ?
          AND p.published = 1
        LIMIT 1
      `)
      .bind(Number(key))
      .first();
  }

  return env.DB
    .prepare(`
      SELECT
        p.*,
        c.name AS category_name,
        c.slug AS category_slug
      FROM prompts p
      LEFT JOIN categories c ON c.id = p.category_id
      WHERE p.slug = ?
        AND p.published = 1
      LIMIT 1
    `)
    .bind(key)
    .first();
}

async function getRelatedPrompts(env, prompt, limit = 6) {
  const safeLimit = Math.min(
    Math.max(Number(limit) || 6, 1),
    12
  );

  if (prompt?.category_id) {
    const result = await env.DB
      .prepare(`
        SELECT
          p.id,
          p.title,
          p.slug,
          p.description,
          p.category_id,
          p.tags,
          p.featured,
          p.published,
          p.views,
          p.copies,
          p.created_at,
          p.updated_at,
          c.name AS category_name,
          c.slug AS category_slug
        FROM prompts p
        LEFT JOIN categories c
          ON c.id = p.category_id
        WHERE p.published = 1
          AND p.category_id = ?
          AND p.id != ?
        ORDER BY
          p.featured DESC,
          p.created_at DESC
        LIMIT ${safeLimit}
      `)
      .bind(
        Number(prompt.category_id),
        Number(prompt.id)
      )
      .all();

    if ((result.results || []).length) {
      return result.results;
    }
  }

  const fallback = await env.DB
    .prepare(`
      SELECT
        p.id,
        p.title,
        p.slug,
        p.description,
        p.category_id,
        p.tags,
        p.featured,
        p.published,
        p.views,
        p.copies,
        p.created_at,
        p.updated_at,
        c.name AS category_name,
        c.slug AS category_slug
      FROM prompts p
      LEFT JOIN categories c
        ON c.id = p.category_id
      WHERE p.published = 1
        AND p.id != ?
      ORDER BY
        p.featured DESC,
        p.created_at DESC
      LIMIT ${safeLimit}
    `)
    .bind(Number(prompt.id))
    .all();

  return fallback.results || [];
}

async function renderPromptHtml(env, request, prompt) {
  try {
    const assetRequest = new Request(
      new URL("/prompt.html", request.url),
      {
        method: "GET",
        headers: request.headers
      }
    );

    const asset = await env.ASSETS.fetch(assetRequest);

    if (!asset.ok) {
      return text(
        "Không thể tải giao diện prompt.",
        500
      );
    }

    let body = await asset.text();

    const canonical = new URL(
      `/prompt/${encodeURIComponent(prompt.slug)}`,
      request.url
    ).href;

    const image = new URL(
      "/icons/og-shareprompt.png",
      request.url
    ).href;

    const titleText =
      `${prompt.title} · DUNG NGUYEN PROMPTS`;

    const descriptionText =
      prompt.description ||
      "DUNG NGUYEN PROMPTS — Thư viện prompt AI";

    const tags = String(prompt.tags || "")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);

    const structuredData = {
      "@context": "https://schema.org",
      "@type": "CreativeWork",
      name: prompt.title,
      description: descriptionText,
      url: canonical,
      author: {
        "@type": "Person",
        name: "DUNG NGUYEN"
      },
      isPartOf: {
        "@type": "WebSite",
        name: "DUNG NGUYEN PROMPTS",
        url: new URL("/", request.url).href
      },
      ...(prompt.category_name
        ? { genre: prompt.category_name }
        : {}),
      ...(tags.length
        ? { keywords: tags.join(", ") }
        : {}),
      ...(prompt.created_at
        ? { dateCreated: String(prompt.created_at).replace(" ", "T") }
        : {}),
      ...(prompt.updated_at
        ? { dateModified: String(prompt.updated_at).replace(" ", "T") }
        : {})
    };

    body = body
      .replaceAll(
        "__PROMPT_TITLE__",
        escapeHtml(titleText)
      )
      .replaceAll(
        "__PROMPT_DESCRIPTION__",
        escapeHtml(descriptionText)
      )
      .replaceAll(
        "__PROMPT_CANONICAL__",
        escapeHtml(canonical)
      )
      .replaceAll(
        "__PROMPT_OG_IMAGE__",
        escapeHtml(image)
      )
      .replaceAll(
        "__PROMPT_SLUG__",
        escapeHtml(prompt.slug)
      )
      .replaceAll(
        "__PROMPT_JSONLD__",
        escapeJsonForHtml(structuredData)
      );

    return html(body);
  } catch (error) {
    return text(
      `Không thể mở prompt: ${error?.message || "Unknown error"}`,
      500
    );
  }
}

async function renderSitemap(env, request) {
  const rows = await env.DB
    .prepare(`
      SELECT slug, updated_at
      FROM prompts
      WHERE published = 1
      ORDER BY created_at DESC
    `)
    .all();

  const base = new URL("/", request.url).origin;

  const staticUrls = [
    `${base}/`,
    `${base}/builder.html`,
    `${base}/saved.html`
  ];

  const entries = staticUrls
    .map(
      (url) =>
        `<url><loc>${escapeHtml(url)}</loc></url>`
    )
    .join("");

  const promptEntries =
    (rows.results || [])
      .map((prompt) => {
        const loc =
          `${base}/prompt/${encodeURIComponent(prompt.slug)}`;

        const lastmod = prompt.updated_at
          ? `<lastmod>${escapeHtml(
              String(prompt.updated_at).replace(" ", "T")
            )}</lastmod>`
          : "";

        return `<url><loc>${escapeHtml(loc)}</loc>${lastmod}</url>`;
      })
      .join("");

  return xml(
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
    entries +
    promptEntries +
    `</urlset>`
  );
}

async function exportBackup(env) {
  const categories = await getCategories(env, true);
  const prompts = await env.DB.prepare(`
    SELECT p.id,p.title,p.slug,p.description,p.content,p.tags,p.featured,p.published,p.views,p.copies,p.created_at,p.updated_at,c.name AS category_name,c.slug AS category_slug
    FROM prompts p LEFT JOIN categories c ON c.id=p.category_id
    ORDER BY p.created_at DESC
  `).all();
  await backfillAllPromptVersions(env);
  const versions = await env.DB.prepare(`
    SELECT v.id,v.prompt_id,p.slug AS prompt_slug,v.version,v.title,v.slug,v.description,v.content,v.category_id,c.slug AS category_slug,v.tags,v.featured,v.published,v.created_at,v.note
    FROM prompt_versions v LEFT JOIN prompts p ON p.id=v.prompt_id LEFT JOIN categories c ON c.id=v.category_id
    ORDER BY v.prompt_id ASC,v.version ASC
  `).all();
  return {backup_format:"shareprompt",backup_version:"1.5-stage4",app:"DUNG NGUYEN PROMPTS",exported_at:new Date().toISOString(),counts:{categories:categories.length,prompts:(prompts.results||[]).length,versions:(versions.results||[]).length},categories,prompts:prompts.results||[],versions:versions.results||[]};
}

async function importBackup(env, body) {
  if (!body || typeof body !== "object") throw new Error("Backup không hợp lệ.");
  const categories=Array.isArray(body.categories)?body.categories:[];
  const prompts=Array.isArray(body.prompts)?body.prompts:[];
  const versions=Array.isArray(body.versions)?body.versions:[];
  if (categories.length>200) throw new Error("Backup có quá nhiều category.");
  if (prompts.length>5000) throw new Error("Backup có quá nhiều prompt.");
  if (versions.length>20000) throw new Error("Backup có quá nhiều phiên bản.");
  const mode=body.mode==="replace"?"replace":"merge";
  await ensureVersionSchema(env);
  if (mode==="replace") { await env.DB.prepare(`DELETE FROM prompt_versions`).run(); await env.DB.prepare(`DELETE FROM prompts`).run(); await env.DB.prepare(`DELETE FROM categories`).run(); }
  for (const category of categories) {
    const name=String(category?.name||"").trim(); if(!name) continue;
    const sourceSlug=String(category?.slug||"").trim();
    if(mode==="merge"&&sourceSlug){const existing=await env.DB.prepare(`SELECT id FROM categories WHERE slug=? LIMIT 1`).bind(sourceSlug).first();if(existing)continue;}
    const slug=await uniqueCategorySlug(env,sourceSlug||name,null);
    await env.DB.prepare(`INSERT INTO categories(name,slug,description) VALUES(?,?,?)`).bind(name,slug,String(category?.description||"")).run();
  }
  for (const prompt of prompts) {
    const title=String(prompt?.title||"").trim(), content=String(prompt?.content||"").trim(); if(!title||!content) continue;
    const sourceSlug=String(prompt?.slug||"").trim();
    if(mode==="merge"&&sourceSlug){const existing=await env.DB.prepare(`SELECT id FROM prompts WHERE slug=? LIMIT 1`).bind(sourceSlug).first();if(existing)continue;}
    const slug=sourceSlug||await uniqueSlug(env,title); let categoryId=null; const categorySlug=String(prompt?.category_slug||"").trim();
    if(categorySlug){const category=await env.DB.prepare(`SELECT id FROM categories WHERE slug=? LIMIT 1`).bind(categorySlug).first();categoryId=category?.id||null;}
    const result=await env.DB.prepare(`INSERT INTO prompts(title,slug,description,content,category_id,tags,featured,published,views,copies) VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(title,slug,String(prompt?.description||""),content,categoryId,String(prompt?.tags||""),prompt?.featured?1:0,prompt?.published===false?0:1,Number(prompt?.views||0),Number(prompt?.copies||0)).run();
    const newId=Number(result.meta?.last_row_id||0); if(newId){await savePromptVersion(env,{id:newId,title,slug,description:String(prompt?.description||""),content,category_id:categoryId,tags:String(prompt?.tags||""),featured:prompt?.featured?1:0,published:prompt?.published===false?0:1},"Import backup");}
  }
  if(versions.length){
    const rows=await env.DB.prepare(`SELECT id,slug FROM prompts`).all();
    const promptIdBySlug=new Map((rows.results||[]).map(row=>[String(row.slug),Number(row.id)]));
    for(const version of versions){
      const promptId=promptIdBySlug.get(String(version?.prompt_slug||"")); const versionNumber=Number(version?.version||0); if(!promptId||!versionNumber)continue;
      const exists=await env.DB.prepare(`SELECT id FROM prompt_versions WHERE prompt_id=? AND version=? LIMIT 1`).bind(promptId,versionNumber).first(); if(exists)continue;
      let categoryId=null; const categorySlug=String(version?.category_slug||"").trim();
      if(categorySlug){const category=await env.DB.prepare(`SELECT id FROM categories WHERE slug=? LIMIT 1`).bind(categorySlug).first();categoryId=category?.id||null;}
      await env.DB.prepare(`INSERT INTO prompt_versions(prompt_id,version,title,slug,description,content,category_id,tags,featured,published,created_at,note) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).bind(promptId,versionNumber,String(version?.title||""),String(version?.slug||""),String(version?.description||""),String(version?.content||""),categoryId,String(version?.tags||""),version?.featured?1:0,version?.published===false?0:1,String(version?.created_at||new Date().toISOString()),String(version?.note||"")).run();
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // SEO and clean prompt URLs.
    if (path === "/sitemap.xml" && method === "GET") {
      return renderSitemap(env, request);
    }

    const cleanPrompt =
      path.match(/^\/prompt\/([^/]+)\/?$/);

    if (cleanPrompt && method === "GET") {
      const prompt = await findPrompt(
        env,
        decodeURIComponent(cleanPrompt[1])
      );

      if (!prompt) {
        return serveAsset(env, request);
      }

      return renderPromptHtml(
        env,
        request,
        prompt
      );
    }

    if (
      path === "/prompt.html" &&
      method === "GET" &&
      url.searchParams.get("id")
    ) {
      const prompt = await findPrompt(
        env,
        url.searchParams.get("id")
      );

      if (!prompt) {
        return serveAsset(env, request);
      }

      return renderPromptHtml(
        env,
        request,
        prompt
      );
    }

    // Public API.
    if (
      path === "/api/health" &&
      method === "GET"
    ) {
      return json({
        ok: true,
        app: "DUNG NGUYEN PROMPTS",
        database: "connected",
        version: "1.5-multiprovider"
      });
    }

    if (path === "/api/ai/status" && method === "GET") {
      return json({configured:Boolean(String(env.GEMINI_API_KEY||"").trim()),model:String(env.GEMINI_MODEL||"gemini-3.8-flash")});
    }

    if (path === "/api/ai/providers" && method === "GET") {
      return json({
        providers: Object.entries(PROVIDER_CONFIG).map(([id, config]) => ({
          id,
          label: config.label,
          defaultModel: config.defaultModel
        }))
      });
    }

    if (path === "/api/ai/session" && method === "POST") {
      if (!sameOrigin(request, url)) return json({ error: "Yêu cầu không hợp lệ" }, 403);
      const limit = consumeRateLimit(clientKey(request, "ai-session"), 12, 60 * 1000);
      if (!limit.allowed) return json({ error: "Quá nhiều yêu cầu AI. Vui lòng thử lại sau một phút." }, 429, { "retry-after": String(limit.retryAfter || 60) });
      try {
        const body = await readJsonBody(request, 96 * 1024);
        const provider = String(body?.provider || "").trim().toLowerCase();
        const apiKey = String(body?.apiKey || "").trim();
        const model = String(body?.model || "").trim();
        const test = Boolean(body?.test);
        const input = {
          topic: String(body?.topic || (test ? "API key test" : "")).trim().slice(0, 6000),
          goal: String(body?.goal || "Tạo nội dung").trim().slice(0, 200),
          tool: String(body?.tool || "").trim().slice(0, 200),
          style: String(body?.style || "").trim().slice(0, 1000),
          tone: String(body?.tone || "").trim().slice(0, 1000),
          format: String(body?.format || "").trim().slice(0, 100),
          duration: String(body?.duration || "").trim().slice(0, 100),
          language: String(body?.language || "Vietnamese").trim().slice(0, 100),
          details: String(body?.details || "").trim().slice(0, 5000)
        };
        if (!provider) return json({ error: "Provider là bắt buộc." }, 400);
        if (!apiKey) return json({ error: "API key là bắt buộc." }, 400);
        if (!test && !input.topic) return json({ error: "Chủ đề là bắt buộc." }, 400);
        const result = await generateWithSessionProvider(provider, apiKey, model, input, { test });
        return json({ ok: true, provider: result.provider, model: result.model, prompt: result.text, testMode: test });
      } catch (error) {
        const status = Number(error?.status || 500);
        const publicStatus = status >= 400 && status < 600 ? status : 500;
        return json({
          error: publicStatus === 401 || publicStatus === 403
            ? "API key không hợp lệ hoặc không có quyền dùng model hiện tại."
            : publicStatus === 429
              ? "Nhà cung cấp AI đang giới hạn quota. Vui lòng thử lại sau."
              : "Không thể kết nối nhà cung cấp AI.",
          code: publicStatus === 429 ? "AI_QUOTA" : "AI_PROVIDER_ERROR"
        }, publicStatus);
      }
    }

    if (path === "/api/ai/generate" && method === "POST") {
      if (!sameOrigin(request, url)) return json({error:"Yêu cầu không hợp lệ"},403);
      const limit=consumeRateLimit(clientKey(request,"ai-generate"),8,60*1000);
      if(!limit.allowed) return json({error:"AI Builder đang có quá nhiều yêu cầu. Vui lòng thử lại sau một phút."},429,{"retry-after":String(limit.retryAfter||60)});
      try {
        const body=await readJsonBody(request,64*1024);
        const input={topic:String(body?.topic||"").trim().slice(0,6000),goal:String(body?.goal||"Tạo nội dung").trim().slice(0,200),tool:String(body?.tool||"").trim().slice(0,200),style:String(body?.style||"").trim().slice(0,1000),tone:String(body?.tone||"").trim().slice(0,1000),format:String(body?.format||"").trim().slice(0,100),duration:String(body?.duration||"").trim().slice(0,100),language:String(body?.language||"Vietnamese").trim().slice(0,100),details:String(body?.details||"").trim().slice(0,5000)};
        if(!input.topic) return json({error:"Chủ đề là bắt buộc."},400);
        const result=await generateWithGemini(env,input);
        return json({ok:true,configured:result.configured,fallback:result.fallback,model:result.model,prompt:result.text});
      } catch(error) {
        const status=Number(error?.status||500); const publicStatus=(status>=400&&status<600)?status:500;
        return json({error:publicStatus===401||publicStatus===403?"Gemini API key không hợp lệ hoặc không có quyền dùng model hiện tại.":publicStatus===429?"Gemini đang giới hạn quota. Vui lòng thử lại sau.":"Không thể tạo prompt bằng AI.",code:publicStatus===429?"AI_QUOTA":"AI_ERROR",detail:String(error?.message||"Unknown error").slice(0,300)},publicStatus);
      }
    }

    if (
      path === "/api/categories" &&
      method === "GET"
    ) {
      return json({
        categories: await getCategories(
          env,
          false
        )
      });
    }

    if (
      path === "/api/prompts" &&
      method === "GET"
    ) {
      return json({
        prompts: await getPrompts(
          env,
          url,
          false
        )
      });
    }

    const relatedMatch =
      path.match(/^\/api\/prompts\/([^/]+)\/related$/);

    if (
      relatedMatch &&
      method === "GET"
    ) {
      const key = decodeURIComponent(
        relatedMatch[1]
      );

      const prompt = await findPrompt(
        env,
        key
      );

      if (!prompt) {
        return json({
          error: "Không tìm thấy prompt"
        }, 404);
      }

      return json({
        prompts: await getRelatedPrompts(
          env,
          prompt,
          url.searchParams.get("limit") || 6
        )
      });
    }

    const promptMatch =
      path.match(/^\/api\/prompts\/([^/]+)$/);

    if (
      promptMatch &&
      method === "GET"
    ) {
      const prompt = await findPrompt(
        env,
        decodeURIComponent(promptMatch[1])
      );

      if (!prompt) {
        return json({
          error: "Không tìm thấy prompt"
        }, 404);
      }

      return json({
        prompt
      });
    }

    const viewMatch =
      path.match(/^\/api\/prompts\/([^/]+)\/view$/);

    if (
      viewMatch &&
      method === "POST"
    ) {
      const key = decodeURIComponent(
        viewMatch[1]
      );

      await env.DB
        .prepare(`
          UPDATE prompts
          SET
            views = views + 1
          WHERE id = ?
             OR slug = ?
        `)
        .bind(
          /^\d+$/.test(key)
            ? Number(key)
            : -1,
          key
        )
        .run();

      return json({ ok: true });
    }

    const copyMatch =
      path.match(/^\/api\/prompts\/([^/]+)\/copy$/);

    if (
      copyMatch &&
      method === "POST"
    ) {
      const key = decodeURIComponent(
        copyMatch[1]
      );

      await env.DB
        .prepare(`
          UPDATE prompts
          SET
            copies = copies + 1
          WHERE id = ?
             OR slug = ?
        `)
        .bind(
          /^\d+$/.test(key)
            ? Number(key)
            : -1,
          key
        )
        .run();

      return json({ ok: true });
    }

    // Admin authentication.
    if (
      path === "/api/admin/login" &&
      method === "POST"
    ) {
      if (!sameOrigin(request, url)) return json({ error: "Yêu cầu không hợp lệ" }, 403);
      const loginLimit = consumeRateLimit(clientKey(request, "admin-login"), 8, 10 * 60 * 1000);
      if (!loginLimit.allowed) return json({ error: "Quá nhiều lần đăng nhập. Vui lòng thử lại sau." }, 429, { "retry-after": String(loginLimit.retryAfter || 60) });
      try {
        const body = await readJsonBody(request, 16 * 1024);
        const password = String(
          body?.password || ""
        );

        if (!password) {
          return json({
            error: "Vui lòng nhập mật khẩu"
          }, 400);
        }

        if (
          !env.ADMIN_PASSWORD ||
          !env.ADMIN_SESSION_SECRET
        ) {
          return json({
            error: "Admin secrets chưa được cấu hình"
          }, 500);
        }

        if (!(await safeEqual(password, env.ADMIN_PASSWORD))) {
          return json({
            error: "Mật khẩu không đúng"
          }, 401);
        }
        resetRateLimit(clientKey(request, "admin-login"));
        const token = await createSession(
          env.ADMIN_SESSION_SECRET
        );

        return json(
          { ok: true },
          200,
          {
            "Set-Cookie":
              `dn_admin_session=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=604800`
          }
        );
      } catch {
        return json({
          error: "Yêu cầu đăng nhập không hợp lệ"
        }, 400);
      }
    }

    if (
      path === "/api/admin/logout" &&
      method === "POST"
    ) {
      return json(
        { ok: true },
        200,
        {
          "Set-Cookie":
            "dn_admin_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0"
        }
      );
    }

    if (
      path === "/api/admin/me" &&
      method === "GET"
    ) {
      return json({
        authenticated:
          await requireAdmin(request, env)
      });
    }

    if (
      path === "/api/admin/stats" &&
      method === "GET"
    ) {
      if (!(await requireAdmin(request, env))) {
        return json({ error: "Unauthorized" }, 401);
      }

      const result = await env.DB
        .prepare(`
          SELECT
            COUNT(*) AS total_prompts,
            SUM(CASE WHEN published = 1 THEN 1 ELSE 0 END) AS published_prompts,
            SUM(CASE WHEN featured = 1 THEN 1 ELSE 0 END) AS featured_prompts,
            SUM(views) AS total_views,
            SUM(copies) AS total_copies
          FROM prompts
        `)
        .first();

      const categories = await env.DB
        .prepare(`SELECT COUNT(*) AS total FROM categories`)
        .first();

      const topViews = await env.DB
        .prepare(`
          SELECT
            id,
            title,
            slug,
            views,
            copies,
            featured,
            published
          FROM prompts
          ORDER BY
            views DESC,
            copies DESC,
            created_at DESC
          LIMIT 10
        `)
        .all();

      const topCopies = await env.DB
        .prepare(`
          SELECT
            id,
            title,
            slug,
            views,
            copies,
            featured,
            published
          FROM prompts
          ORDER BY
            copies DESC,
            views DESC,
            created_at DESC
          LIMIT 10
        `)
        .all();

      const categoryStats =
        await getCategories(
          env,
          true
        );

      const recent = await env.DB
        .prepare(`
          SELECT
            p.id,
            p.title,
            p.slug,
            p.views,
            p.copies,
            p.featured,
            p.published,
            p.created_at,
            c.name AS category_name
          FROM prompts p
          LEFT JOIN categories c
            ON c.id = p.category_id
          ORDER BY p.created_at DESC
          LIMIT 8
        `)
        .all();

      const latestUpdate = await env.DB
        .prepare(`
          SELECT MAX(updated_at) AS latest_update
          FROM prompts
        `)
        .first();

      return json({
        stats: {
          total_prompts: Number(result?.total_prompts || 0),
          published_prompts: Number(result?.published_prompts || 0),
          featured_prompts: Number(result?.featured_prompts || 0),
          total_views: Number(result?.total_views || 0),
          total_copies: Number(result?.total_copies || 0),
          total_categories: Number(categories?.total || 0),
          latest_update: latestUpdate?.latest_update || null
        },
        analytics: {
          top_views: topViews.results || [],
          top_copies: topCopies.results || [],
          category_stats: categoryStats,
          recent_prompts: recent.results || []
        }
      });
    }

    if (
      path === "/api/admin/export" &&
      method === "GET"
    ) {
      if (!(await requireAdmin(request, env))) {
        return json({ error: "Unauthorized" }, 401);
      }

      return json(
        await exportBackup(env)
      );
    }

    if (
      path === "/api/admin/import" &&
      method === "POST"
    ) {
      if (!(await requireAdmin(request, env))) {
        return json({ error: "Unauthorized" }, 401);
      }
      if (!sameOrigin(request,url)) return json({error:"Yêu cầu không hợp lệ"},403);

      try {
        const body = await readJsonBody(request,2*1024*1024);
        await importBackup(env, body);
        return json({ ok: true });
      } catch (error) {
        return json({
          error: "Không thể import backup",
          detail: error?.message || "Unknown error"
        }, 500);
      }
    }

    if (
      path === "/api/admin/prompts" &&
      method === "GET"
    ) {
      if (!(await requireAdmin(request, env))) {
        return json({ error: "Unauthorized" }, 401);
      }

      return json({
        prompts: await getPrompts(
          env,
          url,
          true
        )
      });
    }

    if (
      path === "/api/admin/prompts" &&
      method === "POST"
    ) {
      if (!(await requireAdmin(request, env))) {
        return json({ error: "Unauthorized" }, 401);
      }

      if (!sameOrigin(request,url)) return json({error:"Yêu cầu không hợp lệ"},403);
      try {
        const body = await readJsonBody(request,256*1024);
        const title = String(
          body?.title || ""
        ).trim();

        const content = String(
          body?.content || ""
        ).trim();

        if (!title || !content) {
          return json({
            error: "Tiêu đề và nội dung là bắt buộc"
          }, 400);
        }
        if (title.length > 200 || content.length > 100000 || String(body?.description || "").length > 1000 || String(body?.tags || "").length > 1000) return json({error:"Dữ liệu prompt vượt giới hạn cho phép."},400);

        const slug = await uniqueSlug(
          env,
          title
        );

        const categoryId = body?.category_id
          ? Number(body.category_id)
          : null;

        const result = await env.DB
          .prepare(`
            INSERT INTO prompts
            (
              title,
              slug,
              description,
              content,
              category_id,
              tags,
              featured,
              published
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `)
          .bind(
            title,
            slug,
            String(body?.description || ""),
            content,
            categoryId,
            String(body?.tags || ""),
            body?.featured ? 1 : 0,
            body?.published === false ? 0 : 1
          )
          .run();

        const newId=Number(result.meta?.last_row_id||0);
        if(newId) await savePromptVersion(env,{id:newId,title,slug,description:String(body?.description||""),content,category_id:categoryId,tags:String(body?.tags||""),featured:body?.featured?1:0,published:body?.published===false?0:1},"Initial version");
        return json({ok:true,id:newId||null,slug},201);
      } catch (error) {
        return json({
          error: "Không thể tạo prompt",
          detail: error?.message || "Unknown error"
        }, 500);
      }
    }

    const adminPromptVersionsMatch = path.match(/^\/api\/admin\/prompts\/(\d+)\/versions$/);
    if (adminPromptVersionsMatch && method === "GET") {
      if (!(await requireAdmin(request, env))) return json({error:"Unauthorized"},401);
      return json({versions:await getPromptVersions(env,Number(adminPromptVersionsMatch[1]))});
    }
    const adminPromptRestoreMatch = path.match(/^\/api\/admin\/prompts\/(\d+)\/restore$/);
    if (adminPromptRestoreMatch && method === "POST") {
      if (!(await requireAdmin(request, env))) return json({error:"Unauthorized"},401);
      if (!sameOrigin(request,url)) return json({error:"Yêu cầu không hợp lệ"},403);
      try { const body=await readJsonBody(request,16*1024); const version=Number(body?.version||0); if(!version)return json({error:"Phiên bản không hợp lệ"},400); const prompt=await restorePromptVersion(env,Number(adminPromptRestoreMatch[1]),version); return json({ok:true,prompt}); }
      catch(error){ return json({error:"Không thể khôi phục phiên bản",detail:String(error?.message||"Unknown error")},500); }
    }
    const adminPromptMatch =
      path.match(/^\/api\/admin\/prompts\/(\d+)$/);

    if (
      adminPromptMatch &&
      method === "PUT"
    ) {
      if (!(await requireAdmin(request, env))) {
        return json({ error: "Unauthorized" }, 401);
      }

      const id = Number(
        adminPromptMatch[1]
      );

      if (!sameOrigin(request,url)) return json({error:"Yêu cầu không hợp lệ"},403);
      try {
        const body = await readJsonBody(request,256*1024);

        const title = String(
          body?.title || ""
        ).trim();

        const content = String(
          body?.content || ""
        ).trim();

        if (!title || !content) {
          return json({
            error: "Tiêu đề và nội dung là bắt buộc"
          }, 400);
        }

        if (title.length > 200 || content.length > 100000 || String(body?.description || "").length > 1000 || String(body?.tags || "").length > 1000) return json({error:"Dữ liệu prompt vượt giới hạn cho phép."},400);
        const existing = await getPromptRow(env,id);
        if(!existing) return json({error:"Không tìm thấy prompt"},404);
        await savePromptVersion(env,existing,"Snapshot trước khi cập nhật");
        // Keep the existing slug stable so existing shared links do not break.
        const slug = existing?.slug ||
          await uniqueSlug(
            env,
            title,
            id
          );

        await env.DB
          .prepare(`
            UPDATE prompts
            SET
              title = ?,
              slug = ?,
              description = ?,
              content = ?,
              category_id = ?,
              tags = ?,
              featured = ?,
              published = ?,
              updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `)
          .bind(
            title,
            slug,
            String(body?.description || ""),
            content,
            body?.category_id
              ? Number(body.category_id)
              : null,
            String(body?.tags || ""),
            body?.featured ? 1 : 0,
            body?.published === false ? 0 : 1,
            id
          )
          .run();

        return json({
          ok: true,
          slug
        });
      } catch (error) {
        return json({
          error: "Không thể cập nhật prompt",
          detail: error?.message || "Unknown error"
        }, 500);
      }
    }

    if (
      adminPromptMatch &&
      method === "DELETE"
    ) {
      if (!(await requireAdmin(request, env))) {
        return json({ error: "Unauthorized" }, 401);
      }
      if (!sameOrigin(request,url)) return json({error:"Yêu cầu không hợp lệ"},403);

      await ensureVersionSchema(env);
      await env.DB
        .prepare(`DELETE FROM prompt_versions WHERE prompt_id = ?`)
        .bind(Number(adminPromptMatch[1]))
        .run();

      await env.DB
        .prepare(`DELETE FROM prompts WHERE id = ?`)
        .bind(Number(adminPromptMatch[1]))
        .run();

      return json({ ok: true });
    }

    // Admin categories.
    if (
      path === "/api/admin/categories" &&
      method === "GET"
    ) {
      if (!(await requireAdmin(request, env))) {
        return json({ error: "Unauthorized" }, 401);
      }

      return json({
        categories: await getCategories(
          env,
          true
        )
      });
    }

    if (
      path === "/api/admin/categories" &&
      method === "POST"
    ) {
      if (!(await requireAdmin(request, env))) {
        return json({ error: "Unauthorized" }, 401);
      }
      if (!sameOrigin(request,url)) return json({error:"Yêu cầu không hợp lệ"},403);

      try {
        const body = await readJsonBody(request,32*1024);
        const name = String(
          body?.name || ""
        ).trim();

        if (!name) {
          return json({
            error: "Tên danh mục là bắt buộc"
          }, 400);
        }

        const slug = await uniqueCategorySlug(
          env,
          String(body?.slug || name)
        );

        const result = await env.DB
          .prepare(`
            INSERT INTO categories
            (name, slug, description)
            VALUES (?, ?, ?)
          `)
          .bind(
            name,
            slug,
            String(body?.description || "")
          )
          .run();

        return json({
          ok: true,
          id: result.meta?.last_row_id || null,
          slug
        }, 201);
      } catch (error) {
        return json({
          error: "Không thể tạo danh mục",
          detail: error?.message || "Unknown error"
        }, 500);
      }
    }

    const adminCategoryMatch =
      path.match(/^\/api\/admin\/categories\/(\d+)$/);

    if (
      adminCategoryMatch &&
      method === "PUT"
    ) {
      if (!(await requireAdmin(request, env))) {
        return json({ error: "Unauthorized" }, 401);
      }
      if (!sameOrigin(request,url)) return json({error:"Yêu cầu không hợp lệ"},403);

      try {
        const id = Number(
          adminCategoryMatch[1]
        );

        const body = await readJsonBody(request,32*1024);
        const name = String(
          body?.name || ""
        ).trim();

        if (!name) {
          return json({
            error: "Tên danh mục là bắt buộc"
          }, 400);
        }

        const slug = await uniqueCategorySlug(
          env,
          String(body?.slug || name),
          id
        );

        await env.DB
          .prepare(`
            UPDATE categories
            SET
              name = ?,
              slug = ?,
              description = ?
            WHERE id = ?
          `)
          .bind(
            name,
            slug,
            String(body?.description || ""),
            id
          )
          .run();

        return json({
          ok: true,
          slug
        });
      } catch (error) {
        return json({
          error: "Không thể cập nhật danh mục",
          detail: error?.message || "Unknown error"
        }, 500);
      }
    }

    if (
      adminCategoryMatch &&
      method === "DELETE"
    ) {
      if (!(await requireAdmin(request, env))) {
        return json({ error: "Unauthorized" }, 401);
      }
      if (!sameOrigin(request,url)) return json({error:"Yêu cầu không hợp lệ"},403);

      const id = Number(
        adminCategoryMatch[1]
      );

      // Keep prompts; deleting a category simply uncategorizes them.
      await env.DB
        .prepare(`
          UPDATE prompts
          SET category_id = NULL,
              updated_at = CURRENT_TIMESTAMP
          WHERE category_id = ?
        `)
        .bind(id)
        .run();

      await env.DB
        .prepare(`DELETE FROM categories WHERE id = ?`)
        .bind(id)
        .run();

      return json({ ok: true });
    }

    // Static assets.
    if (!path.startsWith("/api/")) {
      return serveAsset(env, request);
    }

    return json({
      error: "API route not found"
    }, 404);
  }
};
