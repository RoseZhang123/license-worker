import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import worker, { __TEST_HOOKS__ } from "../src/worker.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = join(HERE, "..");
const SEED_SQL_PATH = join(WORKER_ROOT, "seed-codes.sql");

class FakeStatement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.values = [];
  }

  bind(...values) {
    this.values = values;
    return this;
  }

  async first() {
    const sql = this.sql;
    if (sql.includes("FROM activation_codes WHERE code = ?")) {
      const row = this.db.activationCodes.get(this.values[0]);
      return row ? { ...row } : null;
    }
    if (sql.includes("FROM licenses WHERE license_id = ?")) {
      const row = this.db.licenses.get(this.values[0]);
      return row ? { ...row } : null;
    }
    if (sql.includes("FROM licenses WHERE code = ?")) {
      return [...this.db.licenses.values()].find((row) => row.code === this.values[0]) || null;
    }
    throw new Error(`Unsupported first SQL: ${sql}`);
  }

  async run() {
    const sql = this.sql;
    if (sql.startsWith("UPDATE activation_codes SET status = 'used'")) {
      const [usedAt, licenseId, buyerEmail, deviceId, code] = this.values;
      const row = this.db.activationCodes.get(code);
      if (!row || row.status !== "unused") return { meta: { changes: 0 } };
      Object.assign(row, {
        status: "used",
        used_at: usedAt,
        license_id: licenseId,
        buyer_email: buyerEmail,
        device_id: deviceId
      });
      return { meta: { changes: 1 } };
    }
    if (sql.startsWith("INSERT INTO licenses")) {
      const [licenseId, code, plan, mode, activatedAt, expiresAt, buyerEmail, deviceId] = this.values;
      this.db.licenses.set(licenseId, {
        license_id: licenseId,
        code,
        plan,
        mode,
        activated_at: activatedAt,
        expires_at: expiresAt,
        buyer_email: buyerEmail,
        device_id: deviceId,
        status: "active"
      });
      return { meta: { changes: 1 } };
    }
    if (sql.startsWith("UPDATE licenses SET status = 'expired'")) {
      const row = this.db.licenses.get(this.values[0]);
      if (!row) return { meta: { changes: 0 } };
      row.status = "expired";
      return { meta: { changes: 1 } };
    }
    if (sql.startsWith("UPDATE licenses SET plan = ?")) {
      const [plan, expiresAt, licenseId] = this.values;
      const row = this.db.licenses.get(licenseId);
      if (!row) return { meta: { changes: 0 } };
      row.plan = plan;
      row.expires_at = expiresAt;
      row.status = "active";
      return { meta: { changes: 1 } };
    }
    throw new Error(`Unsupported run SQL: ${sql}`);
  }
}

class FakeD1 {
  constructor() {
    this.activationCodes = new Map();
    this.licenses = new Map();
  }

  prepare(sql) {
    return new FakeStatement(this, sql);
  }

  addCode(code, overrides = {}) {
    this.activationCodes.set(code, {
      code,
      plan: "PERSONAL_MONTHLY",
      mode: "consumer",
      status: "unused",
      created_at: "2026-05-30T00:00:00.000Z",
      used_at: null,
      license_id: null,
      buyer_email: null,
      device_id: null,
      ...overrides
    });
  }
}

function env(db = new FakeD1()) {
  return { DB: db, ALLOWED_ORIGIN: "chrome-extension://test" };
}

function envWithEmail(db = new FakeD1()) {
  const sent = [];
  return {
    env: {
      DB: db,
      ALLOWED_ORIGIN: "chrome-extension://test",
      SUPPORT_EMAIL: "owner@example.com",
      FEEDBACK_FROM_EMAIL: "support@example.com",
      EMAIL: {
        send: async (message) => {
          sent.push(message);
          return { messageId: "msg_test" };
        }
      }
    },
    sent
  };
}

function post(path, body, ip = "127.0.0.1") {
  return new Request(`https://license.applyease.test${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-connecting-ip": ip
    },
    body: JSON.stringify(body)
  });
}

async function readJson(response) {
  return response.json();
}

function splitSqlValues(valuesSql) {
  return valuesSql
    .split(/,(?=(?:[^']*'[^']*')*[^']*$)/)
    .map((value) => value.trim());
}

function assertActivationSeedSqlMatchesSchema(seedSql, label) {
  const schema = readFileSync(join(WORKER_ROOT, "schema.sql"), "utf8");
  const insert = seedSql.match(/INSERT INTO activation_codes \(([^)]+)\) VALUES\s*([\s\S]*);/);
  assert.ok(insert, `${label} 必须包含 activation_codes INSERT`);
  const schemaColumnSection = schema.match(/CREATE TABLE IF NOT EXISTS activation_codes \(([\s\S]*?)\);/);
  assert.ok(schemaColumnSection, "schema.sql 必须包含 activation_codes table");

  const schemaColumns = new Set();
  for (const line of schemaColumnSection[1].split("\n")) {
    const column = line.trim().match(/^([a-z_]+)/i)?.[1];
    if (column) schemaColumns.add(column);
  }

  const seedColumns = insert[1].split(",").map((column) => column.trim());
  assert.doesNotMatch(insert[1], /\bduration_days\b/,
    `${label} 不能再插入已从 schema 删除的 duration_days`);
  for (const column of seedColumns) {
    assert.ok(schemaColumns.has(column), `${label} 插入了 schema 不存在的列：${column}`);
  }

  const rows = insert[2].trim().split(/\),\s*\n\s*\(/);
  assert.ok(rows.length >= 80, `${label} 应包含 80 个 internal testing codes`);
  for (const row of rows) {
    const cleaned = row.replace(/^\(/, "").replace(/\),?$/, "");
    assert.equal(splitSqlValues(cleaned).length, seedColumns.length,
      `${label} 行字段数与列数不一致：${row.slice(0, 80)}`);
  }
}

test("generate-codes.js emits activation_codes SQL matching schema columns", () => {
  const generated = execFileSync("node", ["scripts/generate-codes.js"], {
    cwd: WORKER_ROOT,
    encoding: "utf8"
  });
  assertActivationSeedSqlMatchesSchema(generated, "generate-codes.js output");
});

test("local seed-codes.sql matches activation_codes schema columns", {
  skip: existsSync(SEED_SQL_PATH) ? false : "seed-codes.sql is locally generated and gitignored"
}, () => {
  assertActivationSeedSqlMatchesSchema(readFileSync(SEED_SQL_PATH, "utf8"), "seed-codes.sql");
});

test("issue-unused-code dry-run reserves existing code or creates a bound replacement", () => {
  const output = execFileSync("node", [
    "scripts/issue-unused-code.js",
    "--plan", "PERSONAL_YEARLY",
    "--email", "Buyer@Example.com",
    "--dry-run"
  ], {
    cwd: WORKER_ROOT,
    encoding: "utf8"
  });

  assert.match(output, /UPDATE activation_codes[\s\S]*buyer_email = 'buyer@example\.com'/,
    "script should first reserve an unused unassigned stock code for the purchase email");
  assert.match(output, /INSERT INTO activation_codes \(code, plan, mode, status, created_at, buyer_email, note\)/,
    "script should create a new bound code when no unused stock code is available");
  assert.match(output, /'PERSONAL_YEARLY'/);
  assert.match(output, /'consumer'/);
});

test("normalizeCode removes spaces and hyphens", () => {
  assert.equal(__TEST_HOOKS__.normalizeCode(" ae-py-abcd-1234 "), "AEPYABCD1234");
});

test("normalizeEmail lowercases valid purchase email and rejects invalid values", () => {
  assert.equal(__TEST_HOOKS__.normalizeEmail(" Student@Example.COM "), "student@example.com");
  assert.equal(__TEST_HOOKS__.normalizeEmail("not-an-email"), "");
});

test("plan period uses calendar month and calendar year", () => {
  const jan31 = new Date("2026-01-31T12:00:00.000Z");
  const leapDay = new Date("2024-02-29T12:00:00.000Z");

  assert.equal(
    __TEST_HOOKS__.addPlanPeriod(jan31, "PERSONAL_MONTHLY").toISOString(),
    "2026-02-28T12:00:00.000Z"
  );
  assert.equal(
    __TEST_HOOKS__.addPlanPeriod(leapDay, "PERSONAL_YEARLY").toISOString(),
    "2025-02-28T12:00:00.000Z"
  );
});

test("activate redeems an unused code and creates an email-bound license", async () => {
  const db = new FakeD1();
  db.addCode("AEPYABCD1234", {
    plan: "PERSONAL_YEARLY",
    buyer_email: "student@example.com"
  });

  const response = await worker.fetch(post("/api/license/activate", {
    code: "AE-PY-ABCD-1234",
    email: "Student@Example.com"
  }), env(db));
  const body = await readJson(response);

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.license.plan, "PERSONAL_YEARLY");
  assert.equal(body.license.mode, "consumer");
  assert.equal(body.license.buyer_email, "student@example.com");
  assert.equal(db.activationCodes.get("AEPYABCD1234").status, "used");
  assert.equal(db.activationCodes.get("AEPYABCD1234").buyer_email, "student@example.com");
  assert.equal(db.licenses.size, 1);
});

test("activate is idempotent for the same email but blocked for another email", async () => {
  const db = new FakeD1();
  db.addCode("AEPMCODE0001", { buyer_email: "student@example.com" });

  const first = await readJson(await worker.fetch(post("/api/license/activate", {
    code: "AEPMCODE0001",
    email: "student@example.com"
  }, "10.0.0.1"), env(db)));
  const second = await readJson(await worker.fetch(post("/api/license/activate", {
    code: "AEPMCODE0001",
    email: "STUDENT@example.com"
  }, "10.0.0.2"), env(db)));
  const thirdResponse = await worker.fetch(post("/api/license/activate", {
    code: "AEPMCODE0001",
    email: "other@example.com"
  }, "10.0.0.3"), env(db));
  const third = await readJson(thirdResponse);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.reused, true);
  assert.equal(thirdResponse.status, 409);
  assert.equal(third.error, "CODE_ALREADY_USED");
  assert.equal(db.licenses.size, 1);
});

test("activate rejects unused codes that were not pre-bound to a purchase email", async () => {
  const db = new FakeD1();
  db.addCode("AEPMUNBOUND1");

  const response = await worker.fetch(post("/api/license/activate", {
    code: "AE-PM-UNBOUND-1",
    email: "student@example.com"
  }), env(db));
  const body = await readJson(response);

  assert.equal(response.status, 403);
  assert.equal(body.error, "EMAIL_MISMATCH");
  assert.equal(db.activationCodes.get("AEPMUNBOUND1").status, "unused");
  assert.equal(db.licenses.size, 0);
});

test("activate enforces pre-assigned purchase email on unused codes", async () => {
  const db = new FakeD1();
  db.addCode("AEPYASSIGNED01", {
    plan: "PERSONAL_YEARLY",
    buyer_email: "buyer@example.com"
  });

  const wrongResponse = await worker.fetch(post("/api/license/activate", {
    code: "AE-PY-ASSIGNED-01",
    email: "other@example.com"
  }), env(db));
  const rightResponse = await worker.fetch(post("/api/license/activate", {
    code: "AE-PY-ASSIGNED-01",
    email: "BUYER@example.com"
  }), env(db));
  const right = await readJson(rightResponse);

  assert.equal(wrongResponse.status, 403);
  assert.equal((await readJson(wrongResponse)).error, "EMAIL_MISMATCH");
  assert.equal(rightResponse.status, 200);
  assert.equal(right.ok, true);
  assert.equal(right.license.buyer_email, "buyer@example.com");
});

test("verify accepts matching active license and rejects mismatched email", async () => {
  const db = new FakeD1();
  db.addCode("AEPMVERIFY01", { buyer_email: "student@example.com" });
  const activated = await readJson(await worker.fetch(post("/api/license/activate", {
    code: "AEPMVERIFY01",
    email: "student@example.com"
  }), env(db)));

  const okResponse = await worker.fetch(post("/api/license/verify", {
    license_id: activated.license.license_id,
    email: "student@example.com"
  }), env(db));
  const badResponse = await worker.fetch(post("/api/license/verify", {
    license_id: activated.license.license_id,
    email: "other@example.com"
  }), env(db));

  assert.equal(okResponse.status, 200);
  assert.equal((await readJson(okResponse)).ok, true);
  assert.equal(badResponse.status, 403);
  assert.equal((await readJson(badResponse)).error, "EMAIL_MISMATCH");
});

test("verify marks expired licenses as expired", async () => {
  const db = new FakeD1();
  db.licenses.set("lic_expired", {
    license_id: "lic_expired",
    code: "EXPIRED",
    plan: "PERSONAL_MONTHLY",
    mode: "consumer",
    activated_at: "2020-01-01T00:00:00.000Z",
    expires_at: "2020-02-01T00:00:00.000Z",
    buyer_email: "student@example.com",
    device_id: "device-a",
    status: "active"
  });

  const response = await worker.fetch(post("/api/license/verify", {
    license_id: "lic_expired",
    email: "student@example.com"
  }), env(db));
  const body = await readJson(response);

  assert.equal(response.status, 403);
  assert.equal(body.error, "LICENSE_EXPIRED");
  assert.equal(db.licenses.get("lic_expired").status, "expired");
});

test("renew extends an active license from its current expiry", async () => {
  const db = new FakeD1();
  db.licenses.set("lic_active", {
    license_id: "lic_active",
    code: "ORIGINAL",
    plan: "PERSONAL_MONTHLY",
    mode: "consumer",
    activated_at: "2026-01-01T00:00:00.000Z",
    expires_at: "2999-01-01T00:00:00.000Z",
    buyer_email: "student@example.com",
    device_id: "device-a",
    status: "active"
  });
  db.addCode("AEPYRENEW001", {
    plan: "PERSONAL_YEARLY",
    mode: "consumer"
  });

  const response = await worker.fetch(post("/api/license/renew", {
    license_id: "lic_active",
    code: "AE-PY-RENEW-001",
    email: "student@example.com"
  }), env(db));
  const body = await readJson(response);

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.renewed, true);
  assert.equal(body.license.license_id, "lic_active");
  assert.equal(body.license.plan, "PERSONAL_YEARLY");
  assert.equal(body.license.expires_at, "3000-01-01T00:00:00.000Z");
  assert.equal(db.activationCodes.get("AEPYRENEW001").status, "used");
  assert.equal(db.activationCodes.get("AEPYRENEW001").license_id, "lic_active");
  assert.equal(db.activationCodes.get("AEPYRENEW001").buyer_email, "student@example.com");
});

test("renew reactivates an expired license from now", async () => {
  const db = new FakeD1();
  db.licenses.set("lic_old", {
    license_id: "lic_old",
    code: "ORIGINAL",
    plan: "PERSONAL_MONTHLY",
    mode: "consumer",
    activated_at: "2020-01-01T00:00:00.000Z",
    expires_at: "2020-02-01T00:00:00.000Z",
    buyer_email: "student@example.com",
    device_id: "device-a",
    status: "expired"
  });
  db.addCode("AEPMRENEW002", {
    plan: "PERSONAL_MONTHLY",
    mode: "consumer"
  });

  const before = Date.now();
  const response = await worker.fetch(post("/api/license/renew", {
    license_id: "lic_old",
    code: "AE-PM-RENEW-002",
    email: "student@example.com"
  }), env(db));
  const after = Date.now();
  const body = await readJson(response);
  const expiresAt = new Date(body.license.expires_at).getTime();

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.license.status, "active");
  assert.ok(expiresAt >= before + 29 * 24 * 60 * 60 * 1000);
  assert.ok(expiresAt <= after + 31 * 24 * 60 * 60 * 1000);
});

test("renew rejects mismatched email and cross-mode renewal code", async () => {
  const db = new FakeD1();
  db.licenses.set("lic_enterprise", {
    license_id: "lic_enterprise",
    code: "ORIGINAL",
    plan: "ENTERPRISE_MONTHLY",
    mode: "enterprise",
    activated_at: "2026-01-01T00:00:00.000Z",
    expires_at: "2999-01-01T00:00:00.000Z",
    buyer_email: "buyer@example.com",
    device_id: "device-a",
    status: "active"
  });
  db.addCode("AEPMBADMODE01", {
    plan: "PERSONAL_MONTHLY",
    mode: "consumer"
  });

  const emailResponse = await worker.fetch(post("/api/license/renew", {
    license_id: "lic_enterprise",
    code: "AE-PM-BADMODE-01",
    email: "other@example.com"
  }), env(db));
  const modeResponse = await worker.fetch(post("/api/license/renew", {
    license_id: "lic_enterprise",
    code: "AE-PM-BADMODE-01",
    email: "buyer@example.com"
  }), env(db));

  assert.equal(emailResponse.status, 403);
  assert.equal((await readJson(emailResponse)).error, "EMAIL_MISMATCH");
  assert.equal(modeResponse.status, 400);
  assert.equal((await readJson(modeResponse)).error, "BAD_REQUEST");
  assert.equal(db.activationCodes.get("AEPMBADMODE01").status, "unused");
});

test("renew enforces pre-assigned purchase email on renewal codes", async () => {
  const db = new FakeD1();
  db.licenses.set("lic_consumer", {
    license_id: "lic_consumer",
    code: "ORIGINAL",
    plan: "PERSONAL_MONTHLY",
    mode: "consumer",
    activated_at: "2026-01-01T00:00:00.000Z",
    expires_at: "2999-01-01T00:00:00.000Z",
    buyer_email: "buyer@example.com",
    device_id: "",
    status: "active"
  });
  db.addCode("AEPYRENEWBUYER", {
    plan: "PERSONAL_YEARLY",
    mode: "consumer",
    buyer_email: "another@example.com"
  });

  const response = await worker.fetch(post("/api/license/renew", {
    license_id: "lic_consumer",
    code: "AE-PY-RENEW-BUYER",
    email: "buyer@example.com"
  }), env(db));

  assert.equal(response.status, 403);
  assert.equal((await readJson(response)).error, "EMAIL_MISMATCH");
  assert.equal(db.activationCodes.get("AEPYRENEWBUYER").status, "unused");
});

test("feedback endpoint validates payload and sends support email when configured", async () => {
  const { env: testEnv, sent } = envWithEmail();
  const response = await worker.fetch(post("/api/feedback", {
    type: "bug",
    message: "Autofill stopped on the NTU application page after clicking Start Filling.",
    contact: "student@example.com",
    account_mode: "consumer",
    license_id: "lic_feedback",
    page_url: "https://gradadmissions.ntu.edu.sg/apply/frm",
    page: { school: "ntu", isApplicationForm: true },
    extension_version: "0.1.0",
    diagnostic: {
      schema: "applyease_diagnostic_report_v1",
      context: { accountMode: "consumer", school: "ntu" },
      events: []
    }
  }), testEnv);
  const body = await readJson(response);

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.emailed, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "owner@example.com");
  assert.equal(sent[0].from.email, "support@example.com");
  assert.equal(sent[0].replyTo, "student@example.com");
  assert.match(sent[0].subject, /Bug report/);
  assert.match(sent[0].text, /lic_feedback/);
  assert.match(sent[0].text, /Diagnostic summary included: yes/);
  assert.match(sent[0].html, /Autofill stopped/);
  assert.match(sent[0].html, /applyease_diagnostic_report_v1/);
});

// /api/config endpoint tests (Codex review #2 NEEDS WORK: tests + Authorization 文档化)
// 覆盖 200 wrapper + 304 If-None-Match(raw/quoted) + 401(no auth / wrong prefix)
// + 503(kv_not_bound / kv_empty / kv_corrupt_shape)。
function makeKV(map) {
  return {
    get: async (key) => (map[key] !== undefined ? map[key] : null)
  };
}

function getConfigRequest(headers = {}) {
  return new Request("https://license.applyease.test/api/config", {
    method: "GET",
    headers
  });
}

function envWithConfigKV(kv, db = new FakeD1()) {
  return { DB: db, ALLOWED_ORIGIN: "chrome-extension://test", CONFIG_KV: kv };
}

const VALID_AUTH = { authorization: "ApplyEase lic_test_123" };

test("GET /api/config 200 returns wrapper shape with ETag header", async () => {
  const bundlePayload = {
    schemaVersion: 1,
    configVersion: "abc",
    bundle: { hku: { "hku_mapping.json": { pages: {} } } },
    fileCount: 1
  };
  const kv = makeKV({
    bundle: JSON.stringify(bundlePayload),
    etag: "abc",
    schemaVersion: "1"
  });
  const response = await worker.fetch(getConfigRequest(VALID_AUTH), envWithConfigKV(kv));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("etag"), "abc");
  assert.equal(response.headers.get("x-applyease-schema-version"), "1");
  const body = await readJson(response);
  assert.equal(body.schemaVersion, 1);
  assert.equal(body.configVersion, "abc");
  assert.equal(body.fileCount, 1);
  assert.ok(body.bundle && body.bundle.hku, "wrapper 必须含 bundle.<school>");
});

test("GET /api/config 304 when If-None-Match matches etag", async () => {
  const kv = makeKV({
    bundle: JSON.stringify({ schemaVersion: 1, configVersion: "abc", bundle: { hku: {} }, fileCount: 1 }),
    etag: "abc",
    schemaVersion: "1"
  });
  const response = await worker.fetch(
    getConfigRequest({ ...VALID_AUTH, "if-none-match": "abc" }),
    envWithConfigKV(kv)
  );
  assert.equal(response.status, 304);
  assert.equal(response.headers.get("etag"), "abc");
});

test("GET /api/config 304 normalizes quoted If-None-Match (\"abc\" matches abc)", async () => {
  const kv = makeKV({
    bundle: JSON.stringify({ schemaVersion: 1, configVersion: "abc", bundle: { hku: {} }, fileCount: 1 }),
    etag: "abc",
    schemaVersion: "1"
  });
  const response = await worker.fetch(
    getConfigRequest({ ...VALID_AUTH, "if-none-match": '"abc"' }),
    envWithConfigKV(kv)
  );
  assert.equal(response.status, 304);
});

test("GET /api/config 401 when Authorization header missing", async () => {
  const kv = makeKV({ bundle: JSON.stringify({ schemaVersion: 1, bundle: {} }), etag: "abc", schemaVersion: "1" });
  const response = await worker.fetch(getConfigRequest({}), envWithConfigKV(kv));
  assert.equal(response.status, 401);
  const body = await readJson(response);
  assert.equal(body.status, "unauthorized");
});

test("GET /api/config 401 when Authorization uses wrong prefix (Bearer)", async () => {
  const kv = makeKV({ bundle: JSON.stringify({ schemaVersion: 1, bundle: {} }), etag: "abc", schemaVersion: "1" });
  const response = await worker.fetch(
    getConfigRequest({ authorization: "Bearer lic_test_123" }),
    envWithConfigKV(kv)
  );
  assert.equal(response.status, 401);
});

test("GET /api/config 503 kv_not_bound when env.CONFIG_KV is missing", async () => {
  const response = await worker.fetch(getConfigRequest(VALID_AUTH), env(new FakeD1()));
  assert.equal(response.status, 503);
  const body = await readJson(response);
  assert.equal(body.status, "unavailable");
  assert.equal(body.reason, "kv_not_bound");
});

test("GET /api/config 503 kv_empty when bundle key is null", async () => {
  const kv = makeKV({ bundle: null, etag: "abc", schemaVersion: "1" });
  const response = await worker.fetch(getConfigRequest(VALID_AUTH), envWithConfigKV(kv));
  assert.equal(response.status, 503);
  const body = await readJson(response);
  assert.equal(body.reason, "kv_empty");
});

test("GET /api/config 503 kv_corrupt_shape when bundle JSON missing 'bundle' field", async () => {
  const kv = makeKV({
    bundle: JSON.stringify({ schemaVersion: 1 }), // 缺 bundle 字段
    etag: "abc",
    schemaVersion: "1"
  });
  const response = await worker.fetch(getConfigRequest(VALID_AUTH), envWithConfigKV(kv));
  assert.equal(response.status, 503);
  const body = await readJson(response);
  assert.equal(body.reason, "kv_corrupt_shape");
});

test("feedback endpoint rejects missing contact or too-short message", async () => {
  const badContact = await worker.fetch(post("/api/feedback", {
    type: "suggestion",
    message: "Please support more schools soon.",
    contact: ""
  }), env());
  const badMessage = await worker.fetch(post("/api/feedback", {
    type: "bug",
    message: "short",
    contact: "wechat-id"
  }), env());

  assert.equal(badContact.status, 400);
  assert.equal((await readJson(badContact)).error, "BAD_REQUEST");
  assert.equal(badMessage.status, 400);
  assert.equal((await readJson(badMessage)).error, "BAD_REQUEST");
});
