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
  DEVICE_MISMATCH: 403,
  RATE_LIMITED: 429,
  PAYLOAD_TOO_LARGE: 413,
  FEEDBACK_SEND_FAILED: 502,
  FEEDBACK_UNAVAILABLE: 503,
  SERVER_ERROR: 500
};

const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX = 30;
const FEEDBACK_MESSAGE_MAX = 2000;
const FEEDBACK_CONTACT_MAX = 160;
// Bug / suggestion messages need some substance; a diagnostic report only needs a short note
// such as "保存不了", because the attached diagnostic carries the details.
const FEEDBACK_MESSAGE_MIN = 10;
const DIAGNOSTIC_MESSAGE_MIN = 2;
// The diagnostic is attached to the email as JSON. Cap it well under the 25 MiB message limit.
const FEEDBACK_DIAGNOSTIC_MAX_BYTES = 512 * 1024;
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

function normalizeDeviceId(raw) {
  const value = String(raw || "").trim();
  return /^dev_[0-9a-f]{32}$/.test(value) ? value : "";
}

function normalizeFeedbackType(raw) {
  const value = String(raw || "").trim().toLowerCase();
  return value === "bug" || value === "suggestion" || value === "diagnostic" ? value : "";
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

// Strip free text from the diagnostic before it is emailed (same rules as the extension's
// reportSafeDetails). `message` can contain profile values (e.g. a school or degree name inside an
// "option not available" warning) or raw runtime/portal errors; already-released extensions still
// send it. Drop every `message`, keep only the leading lowercase code of `error`
// ("constrained_no_match: student_profile..." -> "constrained_no_match"), keep `errorName` only if
// it is a plain type name. Applied recursively.
const DIAGNOSTIC_ERROR_CODE = /^[a-z][a-z0-9_]*/;

function scrubDiagnostic(value) {
  if (Array.isArray(value)) return value.map(scrubDiagnostic);
  if (!value || typeof value !== "object") return value;
  const safe = {};
  for (const [key, inner] of Object.entries(value)) {
    if (key === "message") continue;
    if (key === "error") {
      const code = String(inner ?? "").match(DIAGNOSTIC_ERROR_CODE)?.[0];
      if (code) safe.error = code;
      continue;
    }
    if (key === "errorName") {
      if (/^[A-Za-z]+$/.test(String(inner ?? ""))) safe.errorName = inner;
      continue;
    }
    safe[key] = scrubDiagnostic(inner);
  }
  return safe;
}

// Keep only origin + path, even if an older client sends a full URL.
function sanitizePageUrl(raw) {
  try {
    const url = new URL(String(raw || ""));
    return `${url.origin}${url.pathname}`.slice(0, 500);
  } catch (e) {
    return "";
  }
}

function normalizeFeedbackPayload(body = {}) {
  const type = normalizeFeedbackType(body.type);
  const message = sanitizeMultiline(body.message, FEEDBACK_MESSAGE_MAX);
  const contact = sanitizeText(body.contact, FEEDBACK_CONTACT_MAX);
  const accountMode = sanitizeText(body.account_mode, 40);
  const licenseId = sanitizeText(body.license_id, 120);
  const pageUrl = sanitizePageUrl(body.page_url);
  const extensionVersion = sanitizeText(body.extension_version, 40);
  const school = sanitizeText(body.page?.school, 40);
  const isApplicationForm = Boolean(body.page?.isApplicationForm);
  const diagnostic = body.diagnostic && typeof body.diagnostic === "object" && !Array.isArray(body.diagnostic)
    ? scrubDiagnostic(body.diagnostic)
    : null;
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
  const deviceId = normalizeDeviceId(body?.device_id);

  if (!code || !email || !deviceId) return errorResponse("BAD_REQUEST", env);

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
      if (existing.device_id !== deviceId) return errorResponse("DEVICE_MISMATCH", env);
      return json({ ok: true, license: publicLicense(existing), reused: true }, 200, env);
    }
    return errorResponse("CODE_ALREADY_USED", env);
  }

  const activatedAt = new Date();
  const expiresAt = addPlanPeriod(activatedAt, activation.plan);
  const licenseId = `lic_${crypto.randomUUID()}`;

  const update = await env.DB.prepare(
    "UPDATE activation_codes SET status = 'used', used_at = ?, license_id = ?, buyer_email = ?, device_id = ? WHERE code = ? AND status = 'unused'"
  ).bind(activatedAt.toISOString(), licenseId, email, deviceId, code).run();

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
    deviceId
  ).run();

  const license = await findLicense(env.DB, licenseId);
  return json({ ok: true, license: publicLicense(license) }, 200, env);
}

async function verifyLicense(request, env) {
  if (!checkRateLimit(request)) return errorResponse("RATE_LIMITED", env);
  const body = await readJson(request);
  const licenseId = String(body?.license_id || "").trim();
  const email = normalizeEmail(body?.email);
  const deviceId = normalizeDeviceId(body?.device_id);

  if (!licenseId || !email || !deviceId) return errorResponse("BAD_REQUEST", env);

  const license = await findLicense(env.DB, licenseId);
  if (!license) return errorResponse("LICENSE_NOT_FOUND", env);
  if (license.buyer_email !== email) return errorResponse("EMAIL_MISMATCH", env);
  if (license.device_id !== deviceId) return errorResponse("DEVICE_MISMATCH", env);
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

const FEEDBACK_LABELS = {
  bug: "Bug report",
  suggestion: "Improvement suggestion",
  diagnostic: "Diagnostic report"
};

// UTF-8 safe base64 (btoa only accepts Latin-1). The diagnostic can contain Chinese field labels.
function toBase64Utf8(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function diagnosticSummaryLine(diagnostic) {
  const schema = typeof diagnostic?.schema === "string" ? diagnostic.schema : "unknown schema";
  const events = Array.isArray(diagnostic?.events) ? diagnostic.events.length : 0;
  return `${schema}, ${events} events (full JSON attached)`;
}

function buildFeedbackEmail(feedback) {
  const label = FEEDBACK_LABELS[feedback.type] || "Feedback";
  const subject = `[ApplyEase] ${label}${feedback.licenseId ? ` (${feedback.licenseId})` : ""}`;
  const text = [
    `${label}`,
    "",
    `Contact: ${feedback.contact || "not provided"}`,
    `Account mode: ${feedback.accountMode || "unknown"}`,
    `License ID: ${feedback.licenseId || "not provided"}`,
    `Extension version: ${feedback.extensionVersion || "unknown"}`,
    `Page: ${feedback.pageUrl || "not provided"}`,
    `School: ${feedback.school || "unknown"}`,
    `Application form: ${feedback.isApplicationForm ? "yes" : "no"}`,
    `Diagnostic summary included: ${feedback.diagnostic ? "yes" : "no"}`,
    ...(feedback.diagnostic ? [`Diagnostic: ${diagnosticSummaryLine(feedback.diagnostic)}`] : []),
    "",
    "Message:",
    feedback.message
  ].join("\n");
  const html = `
    <h2>${escapeHtml(label)}</h2>
    <p><strong>Contact:</strong> ${escapeHtml(feedback.contact || "not provided")}</p>
    <p><strong>Account mode:</strong> ${escapeHtml(feedback.accountMode || "unknown")}</p>
    <p><strong>License ID:</strong> ${escapeHtml(feedback.licenseId || "not provided")}</p>
    <p><strong>Extension version:</strong> ${escapeHtml(feedback.extensionVersion || "unknown")}</p>
    <p><strong>Page:</strong> ${escapeHtml(feedback.pageUrl || "not provided")}</p>
    <p><strong>School:</strong> ${escapeHtml(feedback.school || "unknown")}</p>
    <p><strong>Application form:</strong> ${feedback.isApplicationForm ? "yes" : "no"}</p>
    <p><strong>Diagnostic summary included:</strong> ${feedback.diagnostic ? "yes" : "no"}</p>
    <h3>Message</h3>
    <pre style="white-space:pre-wrap;font-family:system-ui,sans-serif">${escapeHtml(feedback.message)}</pre>
    ${feedback.diagnostic ? `<p><strong>Diagnostic:</strong> ${escapeHtml(diagnosticSummaryLine(feedback.diagnostic))}</p>` : ""}
  `;
  return { subject, text, html };
}

function isValidFeedback(feedback) {
  if (!feedback.type) return false;
  if (feedback.type === "diagnostic") {
    // Contact is optional here: the license ID identifies the user. The diagnostic itself is the point.
    return feedback.message.length >= DIAGNOSTIC_MESSAGE_MIN && Boolean(feedback.diagnostic);
  }
  return feedback.message.length >= FEEDBACK_MESSAGE_MIN && Boolean(feedback.contact);
}

async function submitFeedback(request, env) {
  if (!checkRateLimit(request)) return errorResponse("RATE_LIMITED", env);
  const body = await readJson(request);
  if (!body) return errorResponse("BAD_REQUEST", env);

  const feedback = normalizeFeedbackPayload(body);
  if (!isValidFeedback(feedback)) return errorResponse("BAD_REQUEST", env);

  const diagnosticJson = feedback.diagnostic ? JSON.stringify(feedback.diagnostic, null, 2) : "";
  if (new TextEncoder().encode(diagnosticJson).length > FEEDBACK_DIAGNOSTIC_MAX_BYTES) {
    return errorResponse("PAYLOAD_TOO_LARGE", env);
  }

  // Fail closed. The recipient comes only from the SUPPORT_EMAIL secret (never from the request, and
  // never committed: this repo is public). Without email configured, tell the client instead of
  // returning ok and silently dropping the feedback.
  const to = env.SUPPORT_EMAIL;
  const from = env.FEEDBACK_FROM_EMAIL;
  if (!env.EMAIL?.send || !to || !from) {
    console.warn("applyease feedback not delivered: email is not configured", {
      type: feedback.type,
      hasBinding: Boolean(env.EMAIL?.send),
      hasRecipient: Boolean(to),
      hasSender: Boolean(from)
    });
    return errorResponse("FEEDBACK_UNAVAILABLE", env);
  }

  const email = buildFeedbackEmail(feedback);
  const emailPayload = {
    to,
    from: { email: from, name: "ApplyEase Feedback" },
    subject: email.subject,
    text: email.text,
    html: email.html
  };
  // The user's own contact only ever goes into Reply-To, never into the recipient list.
  if (feedback.contact.includes("@")) emailPayload.replyTo = feedback.contact;
  if (diagnosticJson) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    emailPayload.attachments = [{
      content: toBase64Utf8(diagnosticJson),
      filename: `applyease-diagnostic-${stamp}.json`,
      type: "application/json",
      disposition: "attachment"
    }];
  }

  try {
    await env.EMAIL.send(emailPayload);
  } catch (error) {
    console.error("applyease feedback email failed", { type: feedback.type, code: error?.code || error?.name || "unknown" });
    return errorResponse("FEEDBACK_SEND_FAILED", env);
  }

  return json({ ok: true, emailed: true }, 200, env);
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
  normalizeDeviceId,
  normalizeEmail,
  publicLicense,
  route
};
