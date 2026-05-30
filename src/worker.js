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
  DEVICE_MISMATCH: 403,
  RATE_LIMITED: 429,
  SERVER_ERROR: 500
};

const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX = 30;
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

function normalizeDeviceId(raw) {
  return String(raw || "").trim().slice(0, 120);
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
    "SELECT code, plan, mode, status, used_at, license_id, device_id FROM activation_codes WHERE code = ?"
  ).bind(code).first();
}

async function findLicense(db, licenseId) {
  return db.prepare(
    "SELECT license_id, code, plan, mode, activated_at, expires_at, device_id, status FROM licenses WHERE license_id = ?"
  ).bind(licenseId).first();
}

async function findLicenseByCode(db, code) {
  return db.prepare(
    "SELECT license_id, code, plan, mode, activated_at, expires_at, device_id, status FROM licenses WHERE code = ?"
  ).bind(code).first();
}

async function activateLicense(request, env) {
  if (!checkRateLimit(request)) return errorResponse("RATE_LIMITED", env);
  const body = await readJson(request);
  const code = normalizeCode(body?.code);
  const deviceId = normalizeDeviceId(body?.device_id);

  if (!code || !deviceId) return errorResponse("BAD_REQUEST", env);

  const activation = await findActivationCode(env.DB, code);
  if (!activation) return errorResponse("INVALID_CODE", env);
  if (activation.status === "revoked") return errorResponse("CODE_REVOKED", env);

  if (activation.status === "used") {
    const existing = activation.license_id
      ? await findLicense(env.DB, activation.license_id)
      : await findLicenseByCode(env.DB, code);
    if (existing?.device_id === deviceId && existing.status === "active") {
      return json({ ok: true, license: publicLicense(existing), reused: true }, 200, env);
    }
    return errorResponse("CODE_ALREADY_USED", env);
  }

  const activatedAt = new Date();
  const expiresAt = addPlanPeriod(activatedAt, activation.plan);
  const licenseId = `lic_${crypto.randomUUID()}`;

  const update = await env.DB.prepare(
    "UPDATE activation_codes SET status = 'used', used_at = ?, license_id = ?, device_id = ? WHERE code = ? AND status = 'unused'"
  ).bind(activatedAt.toISOString(), licenseId, deviceId, code).run();

  if ((update.meta?.changes ?? 0) !== 1) {
    return errorResponse("CODE_ALREADY_USED", env);
  }

  await env.DB.prepare(
    "INSERT INTO licenses (license_id, code, plan, mode, activated_at, expires_at, device_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'active')"
  ).bind(
    licenseId,
    code,
    activation.plan,
    activation.mode,
    activatedAt.toISOString(),
    expiresAt.toISOString(),
    deviceId
  ).run();

  const license = await findLicense(env.DB, licenseId);
  return json({ ok: true, license: publicLicense(license) }, 200, env);
}

async function verifyLicense(request, env) {
  if (!checkRateLimit(request)) return errorResponse("RATE_LIMITED", env);
  const body = await readJson(request);
  const licenseId = String(body?.license_id || "").trim();
  const deviceId = normalizeDeviceId(body?.device_id);

  if (!licenseId || !deviceId) return errorResponse("BAD_REQUEST", env);

  const license = await findLicense(env.DB, licenseId);
  if (!license) return errorResponse("LICENSE_NOT_FOUND", env);
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

async function renewLicense(request, env) {
  if (!checkRateLimit(request)) return errorResponse("RATE_LIMITED", env);
  const body = await readJson(request);
  const licenseId = String(body?.license_id || "").trim();
  const code = normalizeCode(body?.code);
  const deviceId = normalizeDeviceId(body?.device_id);

  if (!licenseId || !code || !deviceId) return errorResponse("BAD_REQUEST", env);

  const license = await findLicense(env.DB, licenseId);
  if (!license) return errorResponse("LICENSE_NOT_FOUND", env);
  if (license.device_id !== deviceId) return errorResponse("DEVICE_MISMATCH", env);
  if (license.status === "revoked") return errorResponse("LICENSE_REVOKED", env);

  const activation = await findActivationCode(env.DB, code);
  if (!activation) return errorResponse("INVALID_CODE", env);
  if (activation.status === "revoked") return errorResponse("CODE_REVOKED", env);
  if (activation.status === "used") return errorResponse("CODE_ALREADY_USED", env);
  if (activation.mode !== license.mode) return errorResponse("BAD_REQUEST", env);

  const now = new Date();
  const currentExpiry = new Date(license.expires_at);
  const baseDate = currentExpiry.getTime() > now.getTime() ? currentExpiry : now;
  const nextExpiry = addPlanPeriod(baseDate, activation.plan);

  const update = await env.DB.prepare(
    "UPDATE activation_codes SET status = 'used', used_at = ?, license_id = ?, device_id = ? WHERE code = ? AND status = 'unused'"
  ).bind(now.toISOString(), licenseId, deviceId, code).run();

  if ((update.meta?.changes ?? 0) !== 1) {
    return errorResponse("CODE_ALREADY_USED", env);
  }

  await env.DB.prepare(
    "UPDATE licenses SET plan = ?, expires_at = ?, status = 'active' WHERE license_id = ?"
  ).bind(activation.plan, nextExpiry.toISOString(), licenseId).run();

  const renewed = await findLicense(env.DB, licenseId);
  return json({ ok: true, license: publicLicense(renewed), renewed: true }, 200, env);
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
  normalizeDeviceId,
  publicLicense,
  route
};
