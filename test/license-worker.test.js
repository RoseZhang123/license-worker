import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { __TEST_HOOKS__ } from "../src/worker.js";

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
      const [usedAt, licenseId, deviceId, code] = this.values;
      const row = this.db.activationCodes.get(code);
      if (!row || row.status !== "unused") return { meta: { changes: 0 } };
      Object.assign(row, {
        status: "used",
        used_at: usedAt,
        license_id: licenseId,
        device_id: deviceId
      });
      return { meta: { changes: 1 } };
    }
    if (sql.startsWith("INSERT INTO licenses")) {
      const [licenseId, code, plan, mode, activatedAt, expiresAt, deviceId] = this.values;
      this.db.licenses.set(licenseId, {
        license_id: licenseId,
        code,
        plan,
        mode,
        activated_at: activatedAt,
        expires_at: expiresAt,
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
      duration_days: 30,
      status: "unused",
      created_at: "2026-05-30T00:00:00.000Z",
      used_at: null,
      license_id: null,
      device_id: null,
      ...overrides
    });
  }
}

function env(db = new FakeD1()) {
  return { DB: db, ALLOWED_ORIGIN: "chrome-extension://test" };
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

test("normalizeCode removes spaces and hyphens", () => {
  assert.equal(__TEST_HOOKS__.normalizeCode(" ae-py-abcd-1234 "), "AEPYABCD1234");
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

test("activate redeems an unused code and creates a license", async () => {
  const db = new FakeD1();
  db.addCode("AEPYABCD1234", {
    plan: "PERSONAL_YEARLY",
    duration_days: 365
  });

  const response = await worker.fetch(post("/api/license/activate", {
    code: "AE-PY-ABCD-1234",
    device_id: "device-a"
  }), env(db));
  const body = await readJson(response);

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.license.plan, "PERSONAL_YEARLY");
  assert.equal(body.license.mode, "consumer");
  assert.equal(db.activationCodes.get("AEPYABCD1234").status, "used");
  assert.equal(db.activationCodes.get("AEPYABCD1234").device_id, "device-a");
  assert.equal(db.licenses.size, 1);
});

test("activate is idempotent for the same device but blocked for another device", async () => {
  const db = new FakeD1();
  db.addCode("AEPMCODE0001");

  const first = await readJson(await worker.fetch(post("/api/license/activate", {
    code: "AEPMCODE0001",
    device_id: "device-a"
  }, "10.0.0.1"), env(db)));
  const second = await readJson(await worker.fetch(post("/api/license/activate", {
    code: "AEPMCODE0001",
    device_id: "device-a"
  }, "10.0.0.2"), env(db)));
  const thirdResponse = await worker.fetch(post("/api/license/activate", {
    code: "AEPMCODE0001",
    device_id: "device-b"
  }, "10.0.0.3"), env(db));
  const third = await readJson(thirdResponse);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.reused, true);
  assert.equal(thirdResponse.status, 409);
  assert.equal(third.error, "CODE_ALREADY_USED");
  assert.equal(db.licenses.size, 1);
});

test("verify accepts matching active license and rejects mismatched device", async () => {
  const db = new FakeD1();
  db.addCode("AEPMVERIFY01");
  const activated = await readJson(await worker.fetch(post("/api/license/activate", {
    code: "AEPMVERIFY01",
    device_id: "device-a"
  }), env(db)));

  const okResponse = await worker.fetch(post("/api/license/verify", {
    license_id: activated.license.license_id,
    device_id: "device-a"
  }), env(db));
  const badResponse = await worker.fetch(post("/api/license/verify", {
    license_id: activated.license.license_id,
    device_id: "device-b"
  }), env(db));

  assert.equal(okResponse.status, 200);
  assert.equal((await readJson(okResponse)).ok, true);
  assert.equal(badResponse.status, 403);
  assert.equal((await readJson(badResponse)).error, "DEVICE_MISMATCH");
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
    device_id: "device-a",
    status: "active"
  });

  const response = await worker.fetch(post("/api/license/verify", {
    license_id: "lic_expired",
    device_id: "device-a"
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
    device_id: "device-a",
    status: "active"
  });
  db.addCode("AEPYRENEW001", {
    plan: "PERSONAL_YEARLY",
    mode: "consumer",
    duration_days: 365
  });

  const response = await worker.fetch(post("/api/license/renew", {
    license_id: "lic_active",
    code: "AE-PY-RENEW-001",
    device_id: "device-a"
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
    device_id: "device-a",
    status: "expired"
  });
  db.addCode("AEPMRENEW002", {
    plan: "PERSONAL_MONTHLY",
    mode: "consumer",
    duration_days: 30
  });

  const before = Date.now();
  const response = await worker.fetch(post("/api/license/renew", {
    license_id: "lic_old",
    code: "AE-PM-RENEW-002",
    device_id: "device-a"
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

test("renew rejects mismatched device and cross-mode renewal code", async () => {
  const db = new FakeD1();
  db.licenses.set("lic_enterprise", {
    license_id: "lic_enterprise",
    code: "ORIGINAL",
    plan: "ENTERPRISE_MONTHLY",
    mode: "enterprise",
    activated_at: "2026-01-01T00:00:00.000Z",
    expires_at: "2999-01-01T00:00:00.000Z",
    device_id: "device-a",
    status: "active"
  });
  db.addCode("AEPMBADMODE01", {
    plan: "PERSONAL_MONTHLY",
    mode: "consumer",
    duration_days: 30
  });

  const deviceResponse = await worker.fetch(post("/api/license/renew", {
    license_id: "lic_enterprise",
    code: "AE-PM-BADMODE-01",
    device_id: "device-b"
  }), env(db));
  const modeResponse = await worker.fetch(post("/api/license/renew", {
    license_id: "lic_enterprise",
    code: "AE-PM-BADMODE-01",
    device_id: "device-a"
  }), env(db));

  assert.equal(deviceResponse.status, 403);
  assert.equal((await readJson(deviceResponse)).error, "DEVICE_MISMATCH");
  assert.equal(modeResponse.status, 400);
  assert.equal((await readJson(modeResponse)).error, "BAD_REQUEST");
  assert.equal(db.activationCodes.get("AEPMBADMODE01").status, "unused");
});
