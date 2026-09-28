const JSON_HEADERS = {
  "content-type": "application/json; charset=UTF-8",
  "cache-control": "no-store"
};

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...JSON_HEADERS,
      ...extraHeaders
    }
  });
}

function getCookie(request, name) {
  const cookie = request.headers.get("Cookie") || "";
  const parts = cookie.split(";").map(v => v.trim());

  for (const part of parts) {
    const index = part.indexOf("=");
    if (index === -1) continue;

    const key = part.slice(0, index);
    const value = part.slice(index + 1);

    if (key === name) {
      return value;
    }
  }

  return null;
}

function toBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromBase64Url(value) {
  const base64 = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");

  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

async function sign(value, secret) {
  const encoder = new TextEncoder();

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    {
      name: "HMAC",
      hash: "SHA-256"
    },
    false,
    ["sign", "verify"]
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(value)
  );

  return toBase64Url(new Uint8Array(signature));
}

async function verify(value, signature, secret) {
  const encoder = new TextEncoder();

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    {
      name: "HMAC",
      hash: "SHA-256"
    },
    false,
    ["verify"]
  );

  return crypto.subtle.verify(
    "HMAC",
    key,
    fromBase64Url(signature),
    encoder.encode(value)
  );
}

async function createSession(secret) {
  const payload = {
    iat: Date.now(),
    exp: Date.now() + 1000 * 60 * 60 * 24 * 7
  };

  const raw = JSON.stringify(payload);
  const encoded = toBase64Url(
    new TextEncoder().encode(raw)
  );

  const signature = await sign(encoded, secret);

  return `${encoded}.${signature}`;
}

async function verifySession(request, secret) {
  try {
    const token = getCookie(request, "dn_admin_session");

    if (!token) {
      return false;
    }

    const [encoded, signature] = token.split(".");

    if (!encoded || !signature) {
      return false;
    }

    const valid = await verify(
      encoded,
      signature,
      secret
    );

    if (!valid) {
      return false;
    }

    const payload = JSON.parse(
      new TextDecoder().decode(
        fromBase64Url(encoded)
      )
    );

    if (!payload.exp || Date.now() > payload.exp) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

function createSlug(text) {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

async function requireAdmin(request, env) {
  return verifySession(
    request,
    env.ADMIN_SESSION_SECRET
  );
}

async function getPrompts(url, env) {
  const search = (url.searchParams.get("q") || "").trim();
  const category = (url.searchParams.get("category") || "").trim();

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
    LEFT JOIN categories c
      ON c.id = p.category_id
    WHERE p.published = 1
  `;

  const params = [];

  if (search) {
    sql += `
      AND (
        p.title LIKE ?
        OR p.description LIKE ?
        OR p.content LIKE ?
        OR p.tags LIKE ?
      )
    `;

    const q = `%${search}%`;
    params.push(q, q, q, q);
  }

  if (category) {
    sql += ` AND c.slug = ? `;
    params.push(category);
  }

  sql += `
    ORDER BY p.featured DESC, p.created_at DESC
  `;

  const result = await env.DB
    .prepare(sql)
    .bind(...params)
    .all();

  return result.results || [];
}

async function getCategories(env) {
  const result = await env.DB
    .prepare(`
      SELECT
        id,
        name,
        slug,
        description
      FROM categories
      ORDER BY name ASC
    `)
    .all();

  return result.results || [];
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    /*
     * API
     */

    if (path === "/api/health") {
      return json({
        ok: true,
        app: "DUNG NGUYEN PROMPTS",
        database: "connected"
      });
    }

    if (path === "/api/categories" && method === "GET") {
      try {
        return json({
          categories: await getCategories(env)
        });
      } catch (error) {
        return json({
          error: "Không thể tải categories",
          detail: error.message
        }, 500);
      }
    }

    if (path === "/api/prompts" && method === "GET") {
      try {
        return json({
          prompts: await getPrompts(url, env)
        });
      } catch (error) {
        return json({
          error: "Không thể tải prompts",
          detail: error.message
        }, 500);
      }
    }

    /*
     * Public prompt detail
     */

    const publicPromptMatch =
      path.match(/^\/api\/prompts\/(\d+)$/);

    if (
      publicPromptMatch &&
      method === "GET"
    ) {
      const id = Number(publicPromptMatch[1]);

      const result = await env.DB
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
          LEFT JOIN categories c
            ON c.id = p.category_id
          WHERE p.id = ?
            AND p.published = 1
          LIMIT 1
        `)
        .bind(id)
        .first();

      if (!result) {
        return json({
          error: "Không tìm thấy prompt"
        }, 404);
      }

      return json({
        prompt: result
      });
    }

    /*
     * Copy counter
     */

    const copyMatch =
      path.match(/^\/api\/prompts\/(\d+)\/copy$/);

    if (
      copyMatch &&
      method === "POST"
    ) {
      const id = Number(copyMatch[1]);

      await env.DB
        .prepare(`
          UPDATE prompts
          SET copies = copies + 1,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `)
        .bind(id)
        .run();

      return json({
        ok: true
      });
    }

    /*
     * View counter
     */

    const viewMatch =
      path.match(/^\/api\/prompts\/(\d+)\/view$/);

    if (
      viewMatch &&
      method === "POST"
    ) {
      const id = Number(viewMatch[1]);

      await env.DB
        .prepare(`
          UPDATE prompts
          SET views = views + 1,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `)
        .bind(id)
        .run();

      return json({
        ok: true
      });
    }

    /*
     * Admin login
     */

    if (
      path === "/api/admin/login" &&
      method === "POST"
    ) {
      try {
        const body = await request.json();
        const password = String(body?.password || "");

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

        const token =
          await createSession(
            env.ADMIN_SESSION_SECRET
          );

        return json(
          {
            ok: true,
            message: "Đăng nhập thành công"
          },
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

    /*
     * Admin logout
     */

    if (
      path === "/api/admin/logout" &&
      method === "POST"
    ) {
      return json(
        {
          ok: true
        },
        200,
        {
          "Set-Cookie":
            "dn_admin_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0"
        }
      );
    }

    /*
     * Admin current session
     */

    if (
      path === "/api/admin/me" &&
      method === "GET"
    ) {
      const authenticated =
        await requireAdmin(request, env);

      return json({
        authenticated
      });
    }

    /*
     * Admin prompt list
     */

    if (
      path === "/api/admin/prompts" &&
      method === "GET"
    ) {
      if (!(await requireAdmin(request, env))) {
        return json({
          error: "Unauthorized"
        }, 401);
      }

      const result = await env.DB
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
            p.category_id,
            p.created_at,
            p.updated_at,
            c.name AS category_name,
            c.slug AS category_slug
          FROM prompts p
          LEFT JOIN categories c
            ON c.id = p.category_id
          ORDER BY p.created_at DESC
        `)
        .all();

      return json({
        prompts: result.results || []
      });
    }

    /*
     * Admin create prompt
     */

    if (
      path === "/api/admin/prompts" &&
      method === "POST"
    ) {
      if (!(await requireAdmin(request, env))) {
        return json({
          error: "Unauthorized"
        }, 401);
      }

      try {
        const body = await request.json();

        const title = String(body.title || "").trim();
        const description = String(
          body.description || ""
        ).trim();
        const content = String(
          body.content || ""
        ).trim();

        if (!title || !content) {
          return json({
            error: "Title và content là bắt buộc"
          }, 400);
        }

        const slug =
          createSlug(title) +
          "-" +
          Date.now().toString(36);

        const categoryId =
          body.category_id
            ? Number(body.category_id)
            : null;

        const tags =
          String(body.tags || "").trim();

        const featured =
          body.featured ? 1 : 0;

        const published =
          body.published === false ? 0 : 1;

        const result = await env.DB
          .prepare(`
            INSERT INTO prompts (
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
            description,
            content,
            categoryId,
            tags,
            featured,
            published
          )
          .run();

        return json({
          ok: true,
          id: result.meta?.last_row_id || null
        }, 201);
      } catch (error) {
        return json({
          error: "Không thể tạo prompt",
          detail: error.message
        }, 500);
      }
    }

    /*
     * Admin update prompt
     */

    const adminPromptMatch =
      path.match(/^\/api\/admin\/prompts\/(\d+)$/);

    if (
      adminPromptMatch &&
      method === "PUT"
    ) {
      if (!(await requireAdmin(request, env))) {
        return json({
          error: "Unauthorized"
        }, 401);
      }

      const id = Number(adminPromptMatch[1]);

      try {
        const body = await request.json();

        const title = String(body.title || "").trim();
        const description = String(
          body.description || ""
        ).trim();
        const content = String(
          body.content || ""
        ).trim();

        if (!title || !content) {
          return json({
            error: "Title và content là bắt buộc"
          }, 400);
        }

        const categoryId =
          body.category_id
            ? Number(body.category_id)
            : null;

        const tags =
          String(body.tags || "").trim();

        const featured =
          body.featured ? 1 : 0;

        const published =
          body.published === false ? 0 : 1;

        await env.DB
          .prepare(`
            UPDATE prompts
            SET
              title = ?,
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
            description,
            content,
            categoryId,
            tags,
            featured,
            published,
            id
          )
          .run();

        return json({
          ok: true
        });
      } catch (error) {
        return json({
          error: "Không thể cập nhật prompt",
          detail: error.message
        }, 500);
      }
    }

    /*
     * Admin delete prompt
     */

    if (
      adminPromptMatch &&
      method === "DELETE"
    ) {
      if (!(await requireAdmin(request, env))) {
        return json({
          error: "Unauthorized"
        }, 401);
      }

      const id = Number(adminPromptMatch[1]);

      await env.DB
        .prepare(`
          DELETE FROM prompts
          WHERE id = ?
        `)
        .bind(id)
        .run();

      return json({
        ok: true
      });
    }

    /*
     * Static assets
     */

    if (!path.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    return json({
      error: "API route not found"
    }, 404);
  }
};
