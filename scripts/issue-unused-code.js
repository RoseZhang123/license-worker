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
    "Behavior:",
    "  1. Return an unused code already bound to this email/plan if one exists.",
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
    dryRun: false
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

function issueCode(options, planDef) {
  const reserveSql = buildReserveExistingSql({
    plan: options.plan,
    mode: planDef.mode,
    email: options.email,
    note: options.note
  });

  if (options.dryRun) {
    const exampleCode = generateCode(options.plan);
    console.log("-- Step 1: return same-email unused code, or reserve an unassigned unused code");
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

main();
