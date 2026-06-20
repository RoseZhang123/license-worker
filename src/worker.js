const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};

const ERROR_STATUS = {
  BAD_REQUEST: 400,
  METHOD_NOT_ALLOWED: 405,
  INVALID_CODE: 404,
  CODE_ALREADY_USED: 409,
  CODE_REVOKED: 403,
  LICENSE_NOT_FOUND: 404,
  LICENSE_REVOKED: 403,
  LICENSE_EXPIRED: 403,
  EMAIL_MISMATCH: 403,
  RATE_LIMITED: 429,
  SERVER_ERROR: 500
};

const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX = 30;
const FEEDBACK_MESSAGE_MAX = 2000;
const FEEDBACK_CONTACT_MAX = 160;
const rateBuckets = new Map();

function corsHeaders(env = {}) {
  const origin = env.ALLOWED_ORIGIN || "*";
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "authorization, content-type, if-none-match, x-applyease-device-id",
    "access-control-expose-headers": "etag, x-applyease-schema-version",
    "access-control-max-age": "86400"
  };
}

function json(data, status = 200, env = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...corsHeaders(env) }
  });
}

function normalizeCode(raw) {
  return String(raw || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function normalizeEmail(raw) {
  const value = String(raw || "").trim().toLowerCase().slice(0, 160);
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value) ? value : "";
}

function normalizeFeedbackType(raw) {
  const value = String(raw || "").trim().toLowerCase();
  return value === "bug" || value === "suggestion" ? value : "";
}

function sanitizeText(raw, maxLength) {
  return String(raw || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function sanitizeMultiline(raw, maxLength) {
  return String(raw || "")
    .replace(/\r/g, "")
    .trim()
    .slice(0, maxLength);
}

function escapeHtml(raw) {
  return String(raw || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizeFeedbackPayload(body = {}) {
  const type = normalizeFeedbackType(body.type);
  const message = sanitizeMultiline(body.message, FEEDBACK_MESSAGE_MAX);
  const contact = sanitizeText(body.contact, FEEDBACK_CONTACT_MAX);
  const accountMode = sanitizeText(body.account_mode, 40);
  const licenseId = sanitizeText(body.license_id, 120);
  const pageUrl = sanitizeText(body.page_url, 500);
  const extensionVersion = sanitizeText(body.extension_version, 40);
  const school = sanitizeText(body.page?.school, 40);
  const isApplicationForm = Boolean(body.page?.isApplicationForm);
  const diagnostic = body.diagnostic && typeof body.diagnostic === "object" ? body.diagnostic : null;
  return { type, message, contact, accountMode, licenseId, pageUrl, extensionVersion, school, isApplicationForm, diagnostic };
}

function addCalendarMonths(date, months) {
  const next = new Date(date.getTime());
  const targetMonth = next.getUTCMonth() + Number(months || 0);
  const originalDay = next.getUTCDate();

  next.setUTCDate(1);
  next.setUTCMonth(targetMonth);

  const daysInTargetMonth = new Date(Date.UTC(
    next.getUTCFullYear(),
    next.getUTCMonth() + 1,
    0
  )).getUTCDate();
  next.setUTCDate(Math.min(originalDay, daysInTargetMonth));
  return next;
}

function addPlanPeriod(date, plan) {
  if (String(plan || "").endsWith("_YEARLY")) {
    return addCalendarMonths(date, 12);
  }
  if (String(plan || "").endsWith("_MONTHLY")) {
    return addCalendarMonths(date, 1);
  }
  return addCalendarMonths(date, 1);
}

function publicLicense(row) {
  if (!row) return null;
  return {
    license_id: row.license_id,
    mode: row.mode,
    plan: row.plan,
    buyer_email: row.buyer_email || "",
    activated_at: row.activated_at,
    expires_at: row.expires_at,
    status: row.status
  };
}

function errorResponse(error, env = {}, details = {}) {
  return json({ ok: false, error, ...details }, ERROR_STATUS[error] || 400, env);
}

function getClientKey(request) {
  return request.headers.get("cf-connecting-ip")
    || request.headers.get("x-forwarded-for")
    || "unknown";
}

function checkRateLimit(request, now = Date.now()) {
  const key = getClientKey(request);
  const bucket = rateBuckets.get(key) || { startedAt: now, count: 0 };
  if (now - bucket.startedAt > RATE_LIMIT_WINDOW_MS) {
    bucket.startedAt = now;
    bucket.count = 0;
  }
  bucket.count += 1;
  rateBuckets.set(key, bucket);
  return bucket.count <= RATE_LIMIT_MAX;
}

async function readJson(request) {
  try {
    return await request.json();
  } catch (e) {
    return null;
  }
}

async function findActivationCode(db, code) {
  return db.prepare(
    "SELECT code, plan, mode, status, used_at, license_id, buyer_email, device_id FROM activation_codes WHERE code = ?"
  ).bind(code).first();
}

async function findLicense(db, licenseId) {
  return db.prepare(
    "SELECT license_id, code, plan, mode, activated_at, expires_at, buyer_email, device_id, status FROM licenses WHERE license_id = ?"
  ).bind(licenseId).first();
}

async function findLicenseByCode(db, code) {
  return db.prepare(
    "SELECT license_id, code, plan, mode, activated_at, expires_at, buyer_email, device_id, status FROM licenses WHERE code = ?"
  ).bind(code).first();
}

async function activateLicense(request, env) {
  if (!checkRateLimit(request)) return errorResponse("RATE_LIMITED", env);
  const body = await readJson(request);
  const code = normalizeCode(body?.code);
  const email = normalizeEmail(body?.email);

  if (!code || !email) return errorResponse("BAD_REQUEST", env);

  const activation = await findActivationCode(env.DB, code);
  if (!activation) return errorResponse("INVALID_CODE", env);
  if (activation.status === "revoked") return errorResponse("CODE_REVOKED", env);
  if (activation.status !== "used") {
    if (!activation.buyer_email || activation.buyer_email !== email) {
      return errorResponse("EMAIL_MISMATCH", env);
    }
  }

  if (activation.status === "used") {
    const existing = activation.license_id
      ? await findLicense(env.DB, activation.license_id)
      : await findLicenseByCode(env.DB, code);
    if (existing?.buyer_email === email && existing.status === "active") {
      return json({ ok: true, license: publicLicense(existing), reused: true }, 200, env);
    }
    return errorResponse("CODE_ALREADY_USED", env);
  }

  const activatedAt = new Date();
  const expiresAt = addPlanPeriod(activatedAt, activation.plan);
  const licenseId = `lic_${crypto.randomUUID()}`;

  const update = await env.DB.prepare(
    "UPDATE activation_codes SET status = 'used', used_at = ?, license_id = ?, buyer_email = ?, device_id = ? WHERE code = ? AND status = 'unused'"
  ).bind(activatedAt.toISOString(), licenseId, email, "", code).run();

  if ((update.meta?.changes ?? 0) !== 1) {
    return errorResponse("CODE_ALREADY_USED", env);
  }

  await env.DB.prepare(
    "INSERT INTO licenses (license_id, code, plan, mode, activated_at, expires_at, buyer_email, device_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')"
  ).bind(
    licenseId,
    code,
    activation.plan,
    activation.mode,
    activatedAt.toISOString(),
    expiresAt.toISOString(),
    email,
    ""
  ).run();

  const license = await findLicense(env.DB, licenseId);
  return json({ ok: true, license: publicLicense(license) }, 200, env);
}

async function verifyLicense(request, env) {
  if (!checkRateLimit(request)) return errorResponse("RATE_LIMITED", env);
  const body = await readJson(request);
  const licenseId = String(body?.license_id || "").trim();
  const email = normalizeEmail(body?.email);

  if (!licenseId || !email) return errorResponse("BAD_REQUEST", env);

  const license = await findLicense(env.DB, licenseId);
  if (!license) return errorResponse("LICENSE_NOT_FOUND", env);
  if (license.buyer_email !== email) return errorResponse("EMAIL_MISMATCH", env);
  if (license.status === "revoked") return errorResponse("LICENSE_REVOKED", env);

  const now = new Date();
  if (new Date(license.expires_at).getTime() <= now.getTime()) {
    if (license.status !== "expired") {
      await env.DB.prepare("UPDATE licenses SET status = 'expired' WHERE license_id = ?")
        .bind(licenseId)
        .run();
    }
    return errorResponse("LICENSE_EXPIRED", env, {
      license: { ...publicLicense(license), status: "expired" }
    });
  }

  if (license.status !== "active") return errorResponse("LICENSE_EXPIRED", env);
  return json({ ok: true, license: publicLicense(license) }, 200, env);
}

async function renewLicense(request, env) {
  if (!checkRateLimit(request)) return errorResponse("RATE_LIMITED", env);
  const body = await readJson(request);
  const licenseId = String(body?.license_id || "").trim();
  const code = normalizeCode(body?.code);
  const email = normalizeEmail(body?.email);

  if (!licenseId || !code || !email) return errorResponse("BAD_REQUEST", env);

  const license = await findLicense(env.DB, licenseId);
  if (!license) return errorResponse("LICENSE_NOT_FOUND", env);
  if (license.buyer_email !== email) return errorResponse("EMAIL_MISMATCH", env);
  if (license.status === "revoked") return errorResponse("LICENSE_REVOKED", env);

  const activation = await findActivationCode(env.DB, code);
  if (!activation) return errorResponse("INVALID_CODE", env);
  if (activation.status === "revoked") return errorResponse("CODE_REVOKED", env);
  if (activation.status === "used") return errorResponse("CODE_ALREADY_USED", env);
  if (activation.buyer_email && activation.buyer_email !== email) return errorResponse("EMAIL_MISMATCH", env);
  if (activation.mode !== license.mode) return errorResponse("BAD_REQUEST", env);

  const now = new Date();
  const currentExpiry = new Date(license.expires_at);
  const baseDate = currentExpiry.getTime() > now.getTime() ? currentExpiry : now;
  const nextExpiry = addPlanPeriod(baseDate, activation.plan);

  const update = await env.DB.prepare(
    "UPDATE activation_codes SET status = 'used', used_at = ?, license_id = ?, buyer_email = ?, device_id = ? WHERE code = ? AND status = 'unused'"
  ).bind(now.toISOString(), licenseId, email, "", code).run();

  if ((update.meta?.changes ?? 0) !== 1) {
    return errorResponse("CODE_ALREADY_USED", env);
  }

  await env.DB.prepare(
    "UPDATE licenses SET plan = ?, expires_at = ?, status = 'active' WHERE license_id = ?"
  ).bind(activation.plan, nextExpiry.toISOString(), licenseId).run();

  const renewed = await findLicense(env.DB, licenseId);
  return json({ ok: true, license: publicLicense(renewed), renewed: true }, 200, env);
}

function buildFeedbackEmail(feedback) {
  const label = feedback.type === "bug" ? "Bug report" : "Improvement suggestion";
  const subject = `[ApplyEase] ${label}`;
  const text = [
    `${label}`,
    "",
    `Contact: ${feedback.contact}`,
    `Account mode: ${feedback.accountMode || "unknown"}`,
    `License ID: ${feedback.licenseId || "not provided"}`,
    `Extension version: ${feedback.extensionVersion || "unknown"}`,
    `Page: ${feedback.pageUrl || "not provided"}`,
    `School: ${feedback.school || "unknown"}`,
    `Application form: ${feedback.isApplicationForm ? "yes" : "no"}`,
    `Diagnostic summary included: ${feedback.diagnostic ? "yes" : "no"}`,
    "",
    "Message:",
    feedback.message
  ].join("\n");
  const html = `
    <h2>${escapeHtml(label)}</h2>
    <p><strong>Contact:</strong> ${escapeHtml(feedback.contact)}</p>
    <p><strong>Account mode:</strong> ${escapeHtml(feedback.accountMode || "unknown")}</p>
    <p><strong>License ID:</strong> ${escapeHtml(feedback.licenseId || "not provided")}</p>
    <p><strong>Extension version:</strong> ${escapeHtml(feedback.extensionVersion || "unknown")}</p>
    <p><strong>Page:</strong> ${escapeHtml(feedback.pageUrl || "not provided")}</p>
    <p><strong>School:</strong> ${escapeHtml(feedback.school || "unknown")}</p>
    <p><strong>Application form:</strong> ${feedback.isApplicationForm ? "yes" : "no"}</p>
    <p><strong>Diagnostic summary included:</strong> ${feedback.diagnostic ? "yes" : "no"}</p>
    <h3>Message</h3>
    <pre style="white-space:pre-wrap;font-family:system-ui,sans-serif">${escapeHtml(feedback.message)}</pre>
    ${feedback.diagnostic ? `<h3>Diagnostic summary</h3><pre style="white-space:pre-wrap;font-family:ui-monospace,monospace">${escapeHtml(JSON.stringify(feedback.diagnostic, null, 2)).slice(0, 12000)}</pre>` : ""}
  `;
  return { subject, text, html };
}

async function submitFeedback(request, env) {
  if (!checkRateLimit(request)) return errorResponse("RATE_LIMITED", env);
  const body = await readJson(request);
  if (!body) return errorResponse("BAD_REQUEST", env);

  const feedback = normalizeFeedbackPayload(body);
  if (!feedback.type || feedback.message.length < 10 || !feedback.contact) {
    return errorResponse("BAD_REQUEST", env);
  }

  const email = buildFeedbackEmail(feedback);
  const to = env.SUPPORT_EMAIL || "support@applyease.cn";
  const from = env.FEEDBACK_FROM_EMAIL || "support@applyease.cn";
  let emailed = false;

  if (env.EMAIL?.send) {
    const emailPayload = {
      to,
      from: { email: from, name: "ApplyEase Feedback" },
      subject: email.subject,
      text: email.text,
      html: email.html
    };
    if (feedback.contact.includes("@")) emailPayload.replyTo = feedback.contact;
    await env.EMAIL.send(emailPayload);
    emailed = true;
  } else {
    console.log("applyease feedback received", {
      ...feedback,
      messageLength: feedback.message.length,
      message: undefined
    });
  }

  return json({ ok: true, emailed }, 200, env);
}

async function route(request, env) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(env) });
  }

  const url = new URL(request.url);

  // GET /api/config — 配置下发(轨7 step1-5,2026-06-20 真 deploy)
  if (request.method === "GET" && url.pathname === "/api/config") {
    return getConfig(request, env);
  }

  if (request.method !== "POST") return errorResponse("METHOD_NOT_ALLOWED", env);

  if (url.pathname === "/api/license/activate") return activateLicense(request, env);
  if (url.pathname === "/api/license/verify") return verifyLicense(request, env);
  if (url.pathname === "/api/license/renew") return renewLicense(request, env);
  if (url.pathname === "/api/feedback") return submitFeedback(request, env);
  return errorResponse("BAD_REQUEST", env);
}

// /api/config: 从 CONFIG_KV 读 bundle 并返回(支持 If-None-Match → 304)。
// KV key 约定:
//   - "bundle"          → 完整 bundle JSON 字符串
//   - "etag"            → 内容指纹(configVersion sha256)
//   - "schemaVersion"   → bundle 的 schemaVersion 数字
async function getConfig(request, env) {
  if (!env?.CONFIG_KV) {
    return new Response(JSON.stringify({ status: "unavailable", reason: "kv_not_bound" }), {
      status: 503,
      headers: { ...JSON_HEADERS, ...corsHeaders(env) }
    });
  }

  // ⭐ Authorization 检查是 prefix-only(产品决定,非 BUG,Codex review #2):
  // 只检查 `ApplyEase ` 前缀,不严格 verify license_id in D1(本端点宽松)。理由:
  //   ① bundle 内容是 mapping(非敏感,已 ship 在 extension 包内)
  //   ② 真正的填表 gate 在 extension-side verifyStoredLicense(6h 节流 + Start Filling
  //     前必 verify license_id 真实有效;PR #119 D1 batch 已 gate)
  //   ③ 带宽/成本风险:未来如有滥用,可加 Cloudflare Worker rate limit
  // 严格 license 校验流程见 verifyLicense();此端点不复用以避免每次配置拉取都打 D1。
  const auth = request.headers.get("authorization") || "";
  if (!auth.startsWith("ApplyEase ")) {
    return new Response(JSON.stringify({ status: "unauthorized" }), {
      status: 401,
      headers: { ...JSON_HEADERS, ...corsHeaders(env) }
    });
  }

  const [bundleStr, etagKV, schemaVersionKV] = await Promise.all([
    env.CONFIG_KV.get("bundle"),
    env.CONFIG_KV.get("etag"),
    env.CONFIG_KV.get("schemaVersion")
  ]);

  if (!bundleStr) {
    return new Response(JSON.stringify({ status: "unavailable", reason: "kv_empty" }), {
      status: 503,
      headers: { ...JSON_HEADERS, ...corsHeaders(env) }
    });
  }

  const etag = etagKV || "no-etag";
  const schemaVersion = schemaVersionKV ? Number(schemaVersionKV) : 1;
  // ETag normalize: strip 双引号(HTTP 常见 "hash" vs hash;Codex review #2 NEEDS WORK ③)
  const normalizeEtag = (s) => String(s || "").replace(/^"|"$/g, "");
  const ifNoneMatch = normalizeEtag(request.headers.get("if-none-match"));
  const etagNormalized = normalizeEtag(etag);

  if (ifNoneMatch && ifNoneMatch === etagNormalized) {
    return new Response(null, {
      status: 304,
      headers: {
        ...corsHeaders(env),
        "etag": etag,
        "x-applyease-schema-version": String(schemaVersion)
      }
    });
  }

  // ⭐ Codex review #2 BLOCK ⑤ 修 + 嵌套 bug 二次修(2026-06-20):
  // KV 里 `bundle` key 存的是 build-config-bundle.mjs 完整 output,**已经是** wrapper format
  // `{schemaVersion, configVersion, bundle:{<school>:{<file>:...}}, fileCount, generatedAtPlaceholder}`。
  // 客户端 config-delivery.js:162 期望 `data.bundle` / `data.schemaVersion` — 直接对应 outer 的字段。
  // 所以 worker 只需 parse + validate + 返 parsed JSON,**不要再包一层**(我之前包了 outer.bundle = parsed 导致嵌套)。
  let parsed;
  try {
    parsed = JSON.parse(bundleStr);
  } catch (e) {
    return new Response(JSON.stringify({ status: "unavailable", reason: "kv_corrupt" }), {
      status: 503,
      headers: { ...JSON_HEADERS, ...corsHeaders(env) }
    });
  }
  // 确保返回的 wrapper 含客户端必需的 `bundle` + `schemaVersion`(防 build script 改 schema 时静默坏)
  if (!parsed.bundle || typeof parsed.schemaVersion !== "number") {
    return new Response(JSON.stringify({ status: "unavailable", reason: "kv_corrupt_shape" }), {
      status: 503,
      headers: { ...JSON_HEADERS, ...corsHeaders(env) }
    });
  }

  return new Response(JSON.stringify(parsed), {
    status: 200,
    headers: {
      ...JSON_HEADERS,
      ...corsHeaders(env),
      "etag": etag,
      "x-applyease-schema-version": String(schemaVersion),
      "cache-control": "no-cache"
    }
  });
}

export default {
  async fetch(request, env) {
    try {
      if (!env?.DB) return errorResponse("SERVER_ERROR", env);
      return await route(request, env);
    } catch (error) {
      console.error("license worker error", error);
      return errorResponse("SERVER_ERROR", env);
    }
  }
};

export const __TEST_HOOKS__ = {
  addCalendarMonths,
  addPlanPeriod,
  normalizeCode,
  normalizeEmail,
  publicLicense,
  route
};
