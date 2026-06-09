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
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
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
  if (activation.status !== "used" && activation.buyer_email && activation.buyer_email !== email) {
    return errorResponse("EMAIL_MISMATCH", env);
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
  if (request.method !== "POST") return errorResponse("METHOD_NOT_ALLOWED", env);

  const url = new URL(request.url);
  if (url.pathname === "/api/license/activate") return activateLicense(request, env);
  if (url.pathname === "/api/license/verify") return verifyLicense(request, env);
  if (url.pathname === "/api/license/renew") return renewLicense(request, env);
  if (url.pathname === "/api/feedback") return submitFeedback(request, env);
  return errorResponse("BAD_REQUEST", env);
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
