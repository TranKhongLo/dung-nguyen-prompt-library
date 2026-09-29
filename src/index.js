const JSON_HEADERS = {
  "content-type": "application/json; charset=UTF-8",
  "cache-control": "no-store"
};

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...extra }
  });
}

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=UTF-8",
      "cache-control": "no-store"
    }
  });
}

function xml(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "application/xml; charset=UTF-8",
      "cache-control": "public, max-age=3600"
    }
  });
}

function text(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/plain; charset=UTF-8",
      "cache-control": "no-store"
    }
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
  const categories = await getCategories(
    env,
    true
  );

  const prompts = await env.DB
    .prepare(`
      SELECT
        p.id,
        p.title,
        p.slug,
        p.description,
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
      ORDER BY p.created_at DESC
    `)
    .all();

  return {
    backup_format: "shareprompt",
    backup_version: "1.3.1",
    app: "DUNG NGUYEN PROMPTS",
    exported_at: new Date().toISOString(),
    counts: {
      categories: categories.length,
      prompts: (prompts.results || []).length
    },
    categories,
    prompts: prompts.results || []
  };
}

async function importBackup(env, body) {
  if (!body || typeof body !== "object") {
    throw new Error("Backup không hợp lệ.");
  }

  const categories =
    Array.isArray(body.categories)
      ? body.categories
      : [];

  const prompts =
    Array.isArray(body.prompts)
      ? body.prompts
      : [];

  if (categories.length > 200) {
    throw new Error("Backup có quá nhiều category.");
  }

  if (prompts.length > 5000) {
    throw new Error("Backup có quá nhiều prompt.");
  }

  const mode =
    body.mode === "replace"
      ? "replace"
      : "merge";

  if (mode === "replace") {
    await env.DB
      .prepare(`DELETE FROM prompts`)
      .run();

    await env.DB
      .prepare(`DELETE FROM categories`)
      .run();
  }

  for (const category of categories) {
    const name = String(
      category?.name || ""
    ).trim();

    if (!name) continue;

    const sourceSlug = String(
      category?.slug || ""
    ).trim();

    const slug = await uniqueCategorySlug(
      env,
      sourceSlug || name,
      null
    );

    if (mode === "merge" && sourceSlug) {
      const existing = await env.DB
        .prepare(`SELECT id FROM categories WHERE slug = ? LIMIT 1`)
        .bind(sourceSlug)
        .first();

      if (existing) {
        continue;
      }
    }

    await env.DB
      .prepare(`
        INSERT INTO categories
        (name, slug, description)
        VALUES (?, ?, ?)
      `)
      .bind(
        name,
        slug,
        String(category?.description || "")
      )
      .run();
  }

  for (const prompt of prompts) {
    const title = String(
      prompt?.title || ""
    ).trim();

    const content = String(
      prompt?.content || ""
    ).trim();

    if (!title || !content) continue;

    const sourceSlug = String(
      prompt?.slug || ""
    ).trim();

    if (mode === "merge" && sourceSlug) {
      const existing = await env.DB
        .prepare(`SELECT id FROM prompts WHERE slug = ? LIMIT 1`)
        .bind(sourceSlug)
        .first();

      if (existing) {
        continue;
      }
    }

    const slug = sourceSlug ||
      await uniqueSlug(env, title);

    let categoryId = null;

    const categorySlug = String(
      prompt?.category_slug || ""
    ).trim();

    if (categorySlug) {
      const category = await env.DB
        .prepare(`
          SELECT id
          FROM categories
          WHERE slug = ?
          LIMIT 1
        `)
        .bind(categorySlug)
        .first();

      categoryId = category?.id || null;
    }

    await env.DB
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
          published,
          views,
          copies
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .bind(
        title,
        slug,
        String(prompt?.description || ""),
        content,
        categoryId,
        String(prompt?.tags || ""),
        prompt?.featured ? 1 : 0,
        prompt?.published === false ? 0 : 1,
        Number(prompt?.views || 0),
        Number(prompt?.copies || 0)
      )
      .run();
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
        return env.ASSETS.fetch(request);
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
        return env.ASSETS.fetch(request);
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
        version: "1.3.1-stage2"
      });
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
            views = views + 1,
            updated_at = CURRENT_TIMESTAMP
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
            copies = copies + 1,
            updated_at = CURRENT_TIMESTAMP
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
      try {
        const body = await request.json();
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

        if (password !== env.ADMIN_PASSWORD) {
          return json({
            error: "Mật khẩu không đúng"
          }, 401);
        }

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

      return json({
        stats: {
          total_prompts: Number(result?.total_prompts || 0),
          published_prompts: Number(result?.published_prompts || 0),
          featured_prompts: Number(result?.featured_prompts || 0),
          total_views: Number(result?.total_views || 0),
          total_copies: Number(result?.total_copies || 0),
          total_categories: Number(categories?.total || 0)
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

      try {
        const body = await request.json();
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

      try {
        const body = await request.json();
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

        return json({
          ok: true,
          id: result.meta?.last_row_id || null,
          slug
        }, 201);
      } catch (error) {
        return json({
          error: "Không thể tạo prompt",
          detail: error?.message || "Unknown error"
        }, 500);
      }
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

      try {
        const body = await request.json();

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

        const existing = await env.DB
          .prepare(`
            SELECT slug
            FROM prompts
            WHERE id = ?
            LIMIT 1
          `)
          .bind(id)
          .first();

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

      try {
        const body = await request.json();
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

      try {
        const id = Number(
          adminCategoryMatch[1]
        );

        const body = await request.json();
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
      return env.ASSETS.fetch(request);
    }

    return json({
      error: "API route not found"
    }, 404);
  }
};
