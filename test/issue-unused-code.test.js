import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { __TEST_HOOKS__ } from "../scripts/issue-unused-code.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = join(HERE, "..");
const FAKE_WRANGLER = join(HERE, "fake-wrangler.mjs");
const SCRIPT = join(WORKER_ROOT, "scripts", "issue-unused-code.js");

// 在临时目录造一个名为 `wrangler` 的可执行 shim,转发给 fake-wrangler.mjs,
// 再把该目录 prepend 到 PATH,让 issue-unused-code.js 的 execFileSync("wrangler")
// 命中假 wrangler。返回 { env, cleanup }。
function withFakeWrangler(fixture) {
  const dir = mkdtempSync(join(tmpdir(), "fake-wrangler-"));
  const fixturePath = join(dir, "fixture.json");
  writeFileSync(fixturePath, JSON.stringify(fixture));

  const shimPath = join(dir, "wrangler");
  writeFileSync(shimPath, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_WRANGLER}" "$@"\n`);
  chmodSync(shimPath, 0o755);

  const env = {
    ...process.env,
    PATH: `${dir}:${process.env.PATH}`,
    FAKE_WRANGLER_FIXTURE: fixturePath,
    FAKE_WRANGLER_CALLLOG: join(dir, "calls.log")
  };
  return { env, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// 运行 CLI,捕获 stdout/stderr/exit code(成功/失败都拿到 stderr)。
function runIssue(args, env) {
  const result = spawnSync("node", [SCRIPT, ...args], {
    cwd: WORKER_ROOT,
    encoding: "utf8",
    env
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout || "",
    stderr: result.stderr || ""
  };
}

// ---- 纯逻辑单测:evaluateEmailConflicts ----

test("evaluateEmailConflicts: 全新 email(无冲突行) → 放行", () => {
  const verdict = __TEST_HOOKS__.evaluateEmailConflicts([], {
    plan: "PERSONAL_YEARLY",
    email: "new@example.com"
  });
  assert.equal(verdict.blocked, false);
});

test("evaluateEmailConflicts: 同 plan 未用码不出现在冲突行 → 放行(幂等由 reserve 保留)", () => {
  // 冲突查询只回 active_license / other_plan_code / used_code;同 plan 未用码不查回。
  const verdict = __TEST_HOOKS__.evaluateEmailConflicts([], {
    plan: "PERSONAL_YEARLY",
    email: "same@example.com"
  });
  assert.equal(verdict.blocked, false);
});

test("evaluateEmailConflicts: 有 active license → 拒绝 + 提示 renew", () => {
  const rows = [{ kind: "active_license", plan: "PERSONAL_MONTHLY", ref: "lic_abc", status: "active" }];
  const verdict = __TEST_HOOKS__.evaluateEmailConflicts(rows, {
    plan: "PERSONAL_YEARLY",
    email: "has-license@example.com"
  });
  assert.equal(verdict.blocked, true);
  assert.match(verdict.message, /active license/);
  assert.match(verdict.message, /licenses:renew/);
  assert.match(verdict.message, /lic_abc/);
});

test("evaluateEmailConflicts: 有不同 plan 的未用码 → 拒绝", () => {
  const rows = [{ kind: "other_plan_code", plan: "PERSONAL_MONTHLY", ref: "AEPMXXXX", status: "unused" }];
  const verdict = __TEST_HOOKS__.evaluateEmailConflicts(rows, {
    plan: "PERSONAL_YEARLY",
    email: "other-plan@example.com"
  });
  assert.equal(verdict.blocked, true);
  assert.match(verdict.message, /一个邮箱只能一个 plan/);
  assert.match(verdict.message, /AEPMXXXX/);
});

test("evaluateEmailConflicts: 有 used 码但无 active license → 保守拒绝", () => {
  const rows = [{ kind: "used_code", plan: "PERSONAL_YEARLY", ref: "AEPYUSED1", status: "used" }];
  const verdict = __TEST_HOOKS__.evaluateEmailConflicts(rows, {
    plan: "PERSONAL_YEARLY",
    email: "used@example.com"
  });
  assert.equal(verdict.blocked, true);
  assert.match(verdict.message, /no active license|无 active license/);
});

test("evaluateEmailConflicts: active license 优先于 used/other-plan 报告", () => {
  const rows = [
    { kind: "used_code", plan: "PERSONAL_YEARLY", ref: "AEPYUSED1", status: "used" },
    { kind: "active_license", plan: "PERSONAL_YEARLY", ref: "lic_win", status: "active" }
  ];
  const verdict = __TEST_HOOKS__.evaluateEmailConflicts(rows, {
    plan: "PERSONAL_YEARLY",
    email: "both@example.com"
  });
  assert.equal(verdict.blocked, true);
  assert.match(verdict.message, /lic_win/);
});

test("parseWranglerJsonRows: 兼容数组包裹与单对象两种 wrangler 输出", () => {
  const arr = __TEST_HOOKS__.parseWranglerJsonRows('[{"results":[{"kind":"active_license"}]}]');
  assert.equal(arr.length, 1);
  const obj = __TEST_HOOKS__.parseWranglerJsonRows('{"results":[{"kind":"used_code"},{"kind":"active_license"}]}');
  assert.equal(obj.length, 2);
  const empty = __TEST_HOOKS__.parseWranglerJsonRows('[{"results":[]}]');
  assert.equal(empty.length, 0);
});

test("buildConflictCheckSql: 覆盖 active license / 不同 plan 未用码 / used 码三类", () => {
  const sql = __TEST_HOOKS__.buildConflictCheckSql({ plan: "PERSONAL_YEARLY", email: "x@y.com" });
  assert.match(sql, /FROM licenses[\s\S]*status = 'active'/);
  assert.match(sql, /FROM activation_codes[\s\S]*status = 'unused' AND plan != 'PERSONAL_YEARLY'/);
  assert.match(sql, /FROM activation_codes[\s\S]*status = 'used'/);
  assert.match(sql, /buyer_email = 'x@y\.com'/);
});

// ---- CLI 端到端(假 wrangler)单测 ----

test("CLI: ① 同 email + 同 plan 未用码 → 返回该码(幂等,退出 0)", () => {
  const { env, cleanup } = withFakeWrangler({
    conflictRows: [], // 同 plan 未用码不算冲突
    reserveCode: "AEPYEXISTINGCODE0"
  });
  try {
    const r = runIssue(["--plan", "PERSONAL_YEARLY", "--email", "same@example.com"], env);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /AE-PY-EXIS/); // reserve 命中的已存在码被打印
  } finally {
    cleanup();
  }
});

test("CLI: ② email 有 active license → 拒绝 + 非 0 退出", () => {
  const { env, cleanup } = withFakeWrangler({
    conflictRows: [{ kind: "active_license", plan: "PERSONAL_MONTHLY", ref: "lic_x", status: "active" }]
  });
  try {
    const r = runIssue(["--plan", "PERSONAL_YEARLY", "--email", "has@example.com"], env);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /拒绝发码/);
    assert.match(r.stderr, /licenses:renew/);
    assert.doesNotMatch(r.stdout, /AE-PY/); // 没有发出任何码
  } finally {
    cleanup();
  }
});

test("CLI: ③ email 有不同 plan 未用码 → 拒绝 + 非 0 退出", () => {
  const { env, cleanup } = withFakeWrangler({
    conflictRows: [{ kind: "other_plan_code", plan: "PERSONAL_MONTHLY", ref: "AEPMOTHER", status: "unused" }]
  });
  try {
    const r = runIssue(["--plan", "PERSONAL_YEARLY", "--email", "otherplan@example.com"], env);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /一个邮箱只能一个 plan/);
    assert.doesNotMatch(r.stdout, /AE-PY/);
  } finally {
    cleanup();
  }
});

test("CLI: ④ 全新 email → 正常发码(退出 0)", () => {
  const { env, cleanup } = withFakeWrangler({
    conflictRows: [],
    reserveCode: null,          // 无库存可 reserve
    createCode: "AEPYNEWCODE00001"
  });
  try {
    const r = runIssue(["--plan", "PERSONAL_YEARLY", "--email", "brandnew@example.com"], env);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /AE-PY-NEWC/);
  } finally {
    cleanup();
  }
});

test("CLI: ⑤ --force → 绕过冲突检查,即使有 active license 也发码", () => {
  const { env, cleanup } = withFakeWrangler({
    conflictRows: [{ kind: "active_license", plan: "PERSONAL_MONTHLY", ref: "lic_x", status: "active" }],
    reserveCode: null,
    createCode: "AEPYFORCED00001"
  });
  try {
    const r = runIssue(["--plan", "PERSONAL_YEARLY", "--email", "forced@example.com", "--force"], env);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /--force/);
    assert.match(r.stdout, /AE-PY-FORC/);
  } finally {
    cleanup();
  }
});
