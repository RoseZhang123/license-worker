import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";

const PLAN_DEFS = {
  PERSONAL_MONTHLY: { prefix: "AE-PM", mode: "consumer" },
  PERSONAL_YEARLY: { prefix: "AE-PY", mode: "consumer" },
  ENTERPRISE_MONTHLY: { prefix: "AE-EM", mode: "enterprise" },
  ENTERPRISE_YEARLY: { prefix: "AE-EY", mode: "enterprise" }
};

function usage() {
  console.error([
    "Usage:",
    "  node scripts/issue-unused-code.js --plan PERSONAL_YEARLY --email buyer@example.com",
    "",
    "Policy: one email = one plan / one license.",
    "  Before issuing, the email is checked. Issue is refused (non-zero exit) when the",
    "  email already has an active license (any plan) or an unused code for a different",
    "  plan. Use `npm run licenses:renew` to renew, or a different email for a new person.",
    "",
    "Behavior:",
    "  1. Return an unused code already bound to this email + SAME plan if one exists.",
    "  2. Otherwise reserve the oldest unused, unassigned code for this plan.",
    "  3. Otherwise create a new unused code for this plan.",
    "  4. Bind buyer_email immediately and print the code to send.",
    "",
    "Plans:",
    `  ${Object.keys(PLAN_DEFS).join(", ")}`,
    "",
    "Options:",
    "  --plan <PLAN>          Required.",
    "  --email <EMAIL>        Required. Purchase email to bind to this code.",
    "  --note <TEXT>          Optional support note.",
    "  --force                Bypass the one-email-one-plan conflict check.",
    "  --db <NAME>            D1 database name. Default: applyease-license.",
    "  --local                Use local D1 instead of --remote.",
    "  --dry-run             Print SQL without calling wrangler.",
    "",
    "Output:",
    "  Prints one hyphenated activation code on stdout. Diagnostics go to stderr."
  ].join("\n"));
}

function parseArgs(argv) {
  const options = {
    db: "applyease-license",
    remote: true,
    note: "",
    dryRun: false,
    force: false
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--plan") {
      options.plan = String(argv[++i] || "").trim().toUpperCase();
    } else if (arg === "--email") {
      options.email = normalizeEmail(argv[++i]);
    } else if (arg === "--note") {
      options.note = String(argv[++i] || "").trim();
    } else if (arg === "--force") {
      options.force = true;
    } else if (arg === "--db") {
      options.db = String(argv[++i] || "").trim();
    } else if (arg === "--local") {
      options.remote = false;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function normalizeEmail(raw) {
  const value = String(raw || "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value) ? value : "";
}

function sqlString(value) {
  if (value === null || value === undefined) return "NULL";
  return `'${String(value).replaceAll("'", "''")}'`;
}

function supportNote({ email, note, action }) {
  return [
    `${action}_at=${new Date().toISOString()}`,
    `issued_to=${email}`,
    note
  ].filter(Boolean).join(" ");
}

function normalizeCode(raw) {
  return String(raw || "").replace(/[^A-Z0-9]/g, "").toUpperCase();
}

function displayCode(normalizedCode) {
  const code = normalizeCode(normalizedCode);
  const prefix = code.slice(0, 4);
  const rest = code.slice(4).match(/.{1,4}/g)?.join("-") || code.slice(4);
  if (prefix === "AEPM") return `AE-PM-${rest}`;
  if (prefix === "AEPY") return `AE-PY-${rest}`;
  if (prefix === "AEEM") return `AE-EM-${rest}`;
  if (prefix === "AEEY") return `AE-EY-${rest}`;
  return code.match(/.{1,4}/g)?.join("-") || code;
}

function generateCode(plan) {
  const def = PLAN_DEFS[plan];
  const token = randomBytes(6).toString("hex").toUpperCase().match(/.{1,4}/g).join("-");
  return normalizeCode(`${def.prefix}-${token}`);
}

// 一邮箱一 plan/license 冲突检查用的只读查询:
//   - active_licenses:  该 email 名下任何 status='active' 的 license(任何 plan)
//   - other_plan_codes: 该 email 名下 status='unused'、但 plan != 目标 plan 的码
//   - used_codes:       该 email 名下 status='used' 的码(可能有已过期/异常 license)
// 用 UNION ALL 一次查回,每行带 kind 标签,便于结构化判定。
function buildConflictCheckSql({ plan, email }) {
  return `
SELECT 'active_license' AS kind, plan AS plan, license_id AS ref, status AS status
FROM licenses
WHERE buyer_email = ${sqlString(email)} AND status = 'active'
UNION ALL
SELECT 'other_plan_code' AS kind, plan AS plan, code AS ref, status AS status
FROM activation_codes
WHERE buyer_email = ${sqlString(email)} AND status = 'unused' AND plan != ${sqlString(plan)}
UNION ALL
SELECT 'used_code' AS kind, plan AS plan, code AS ref, status AS status
FROM activation_codes
WHERE buyer_email = ${sqlString(email)} AND status = 'used';
`.trim();
}

// 解析 wrangler d1 execute --json 的输出,拿回 results 行数组。
// wrangler 输出可能是 [{ results: [...] }] 或 { results: [...] };兼容两种。
function parseWranglerJsonRows(output) {
  const parsed = JSON.parse(String(output || "").trim());
  const blocks = Array.isArray(parsed) ? parsed : [parsed];
  const rows = [];
  for (const block of blocks) {
    if (block && Array.isArray(block.results)) rows.push(...block.results);
  }
  return rows;
}

// 根据冲突行判定是否拒绝发码。返回 { blocked, message }。
function evaluateEmailConflicts(rows, { plan, email }) {
  const activeLicenses = rows.filter((r) => r.kind === "active_license");
  const otherPlanCodes = rows.filter((r) => r.kind === "other_plan_code");
  const usedCodes = rows.filter((r) => r.kind === "used_code");

  if (activeLicenses.length) {
    const existing = activeLicenses[0];
    return {
      blocked: true,
      message: [
        `该邮箱 ${email} 已有 active license(plan=${existing.plan}, license_id=${existing.ref})。`,
        "This email already has an active license. To renew, run:",
        `  npm run licenses:renew -- --plan ${existing.plan} --email ${email}`,
        "换人请用别的邮箱;确需一邮箱多 license 才加 --force。"
      ].join("\n")
    };
  }

  if (otherPlanCodes.length) {
    const existing = otherPlanCodes[0];
    return {
      blocked: true,
      message: [
        `该邮箱 ${email} 已有未使用的 ${existing.plan} 码(code=${existing.ref}),一个邮箱只能一个 plan。`,
        `You requested plan=${plan} but an unused ${existing.plan} code already exists for this email.`,
        "换 plan 请先作废旧码或换邮箱;确需强制发码才加 --force。"
      ].join("\n")
    };
  }

  if (usedCodes.length) {
    const existing = usedCodes[0];
    return {
      blocked: true,
      message: [
        `该邮箱 ${email} 已有 used 码(code=${existing.ref}, plan=${existing.plan}) 但无 active license(可能已过期/异常)。`,
        "This email has a redeemed code but no active license. Do not silently issue a new one.",
        `续费请用:  npm run licenses:renew -- --plan ${existing.plan} --email ${email}`,
        "换人请用别的邮箱;确需强制发码才加 --force。"
      ].join("\n")
    };
  }

  return { blocked: false, message: "" };
}

// 执行冲突检查(dry-run 下跳过,因为不查库)。冲突时 process.exit(1)。
function enforceOneEmailOnePlan(options) {
  if (options.force) {
    console.error("--force 已启用:跳过一邮箱一 plan 冲突检查。");
    return;
  }
  if (options.dryRun) {
    console.error("-- Dry-run: skipping one-email-one-plan conflict check (no DB query).");
    return;
  }

  const conflictSql = buildConflictCheckSql({ plan: options.plan, email: options.email });
  let rows;
  try {
    const output = runWranglerSqlJson(options, conflictSql);
    rows = parseWranglerJsonRows(output);
  } catch (error) {
    const stderr = error.stderr ? String(error.stderr) : "";
    console.error(stderr.trim() || error.message);
    console.error("一邮箱一 plan 冲突检查失败(无法查询 D1)。请检查 wrangler 登录/网络后重试。");
    process.exit(error.status || 1);
  }

  const verdict = evaluateEmailConflicts(rows, { plan: options.plan, email: options.email });
  if (verdict.blocked) {
    console.error("🚫 拒绝发码(一个邮箱只能一个 plan/license):");
    console.error(verdict.message);
    console.error("如确需绕过,重跑并加 --force。");
    process.exit(2);
  }
}

function buildReserveExistingSql({ plan, mode, email, note }) {
  const issueNote = supportNote({ email, note, action: "issued" });
  return `
UPDATE activation_codes
SET
  buyer_email = ${sqlString(email)},
  note = trim(COALESCE(note || ' | ', '') || ${sqlString(issueNote)})
WHERE code = (
  SELECT code
  FROM activation_codes
  WHERE status = 'unused'
    AND plan = ${sqlString(plan)}
    AND mode = ${sqlString(mode)}
    AND (buyer_email = ${sqlString(email)} OR buyer_email IS NULL OR buyer_email = '')
  ORDER BY CASE WHEN buyer_email = ${sqlString(email)} THEN 0 ELSE 1 END, created_at ASC, code ASC
  LIMIT 1
)
RETURNING code, plan, mode, buyer_email, 'existing' AS source;
`.trim();
}

function buildCreateSql({ code, plan, mode, email, note }) {
  const display = displayCode(code);
  const createNote = [
    supportNote({ email, note, action: "created" }),
    `display_code=${display}`
  ].filter(Boolean).join(" | ");
  return `
INSERT INTO activation_codes (code, plan, mode, status, created_at, buyer_email, note)
VALUES (${sqlString(code)}, ${sqlString(plan)}, ${sqlString(mode)}, 'unused', ${sqlString(new Date().toISOString())}, ${sqlString(email)}, ${sqlString(createNote)})
RETURNING code, plan, mode, buyer_email, 'created' AS source;
`.trim();
}

function extractReturnedCode(output) {
  const match = String(output).match(/\bAE(?:PM|PY|EM|EY)[A-Z0-9]{8,24}\b/);
  return match?.[0] || "";
}

function runWranglerSql(options, sql) {
  const args = ["d1", "execute", options.db, "--command", sql];
  if (options.remote) args.push("--remote");
  return execFileSync("wrangler", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

// 冲突检查用 --json,方便结构化解析(不影响其它命令的文本解析路径)。
function runWranglerSqlJson(options, sql) {
  const args = ["d1", "execute", options.db, "--command", sql, "--json"];
  if (options.remote) args.push("--remote");
  return execFileSync("wrangler", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function issueCode(options, planDef) {
  // 一邮箱一 plan/license:发/建码前先做冲突检查(dry-run / --force 会在内部跳过)。
  enforceOneEmailOnePlan(options);

  const reserveSql = buildReserveExistingSql({
    plan: options.plan,
    mode: planDef.mode,
    email: options.email,
    note: options.note
  });

  if (options.dryRun) {
    const exampleCode = generateCode(options.plan);
    console.log("-- Step 0: one-email-one-plan conflict check (refuse if active license / other-plan unused / used code)");
    console.log(buildConflictCheckSql({ plan: options.plan, email: options.email }));
    console.log("\n-- Step 1: return same-email unused code, or reserve an unassigned unused code");
    console.log(reserveSql);
    console.log("\n-- Step 2: if step 1 returns no code, create and bind a new code");
    console.log(buildCreateSql({
      code: exampleCode,
      plan: options.plan,
      mode: planDef.mode,
      email: options.email,
      note: options.note
    }));
    return null;
  }

  const reserveOutput = runWranglerSql(options, reserveSql);
  const existingCode = extractReturnedCode(reserveOutput);
  if (existingCode) {
    console.error(`Reserved existing unused code for ${options.email}`);
    return existingCode;
  }

  for (let attempt = 1; attempt <= 5; attempt++) {
    const code = generateCode(options.plan);
    const createSql = buildCreateSql({
      code,
      plan: options.plan,
      mode: planDef.mode,
      email: options.email,
      note: options.note
    });
    try {
      const createOutput = runWranglerSql(options, createSql);
      const createdCode = extractReturnedCode(createOutput);
      if (createdCode) {
        console.error(`Created new code for ${options.email}`);
        return createdCode;
      }
    } catch (error) {
      const stderr = error.stderr ? String(error.stderr) : "";
      if (!/UNIQUE|constraint|already exists/i.test(stderr) || attempt === 5) throw error;
    }
  }

  throw new Error("No activation code was returned from D1.");
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    usage();
    process.exit(1);
  }

  if (options.help) {
    usage();
    return;
  }

  const planDef = PLAN_DEFS[options.plan];
  if (!planDef) {
    console.error("--plan is required and must be a known plan.");
    usage();
    process.exit(1);
  }
  if (!options.email) {
    console.error("--email is required and must be a valid email.");
    process.exit(1);
  }

  try {
    const code = issueCode(options, planDef);
    if (code) console.log(displayCode(code));
  } catch (error) {
    const stdout = error.stdout ? String(error.stdout) : "";
    const stderr = error.stderr ? String(error.stderr) : "";
    if (stdout.trim()) console.error(stdout.trim());
    console.error(stderr.trim() || error.message);
    console.error("Tip: run with --dry-run to inspect SQL, or install/login wrangler.");
    process.exit(error.status || 1);
  }
}

// 仅在直接执行时跑 CLI;被测试 import 时不自动运行。
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main();
}

// 纯逻辑导出,供单测直接验证冲突判定,无需真实 wrangler / D1。
export const __TEST_HOOKS__ = {
  buildConflictCheckSql,
  parseWranglerJsonRows,
  evaluateEmailConflicts,
  normalizeEmail
};
