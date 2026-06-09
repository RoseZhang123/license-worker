import { execFileSync } from "node:child_process";

const PLAN_DEFS = {
  PERSONAL_MONTHLY: { mode: "consumer" },
  PERSONAL_YEARLY: { mode: "consumer" },
  ENTERPRISE_MONTHLY: { mode: "enterprise" },
  ENTERPRISE_YEARLY: { mode: "enterprise" }
};

function usage() {
  console.error([
    "Usage:",
    "  node scripts/issue-unused-code.js --plan PERSONAL_YEARLY --email buyer@example.com",
    "",
    "Options:",
    "  --plan <PLAN>          Required.",
    "  --email <EMAIL>        Required. Purchase email to reserve this code for.",
    "  --note <TEXT>          Optional support note.",
    "  --db <NAME>            D1 database name. Default: applyease-license.",
    "  --local                Use local D1 instead of --remote.",
    "  --dry-run             Print SQL instead of calling wrangler.",
    "",
    "Output:",
    "  Prints the normalized D1 code and the hyphenated code you can send."
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
      options.plan = argv[++i];
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
  return `'${String(value || "").replaceAll("'", "''")}'`;
}

function buildIssueSql({ plan, mode, email, note }) {
  const issuedAt = new Date().toISOString();
  const supportNote = [
    `issued_at=${issuedAt}`,
    `issued_to=${email}`,
    note
  ].filter(Boolean).join(" ");

  return `
UPDATE activation_codes
SET
  buyer_email = ${sqlString(email)},
  note = trim(COALESCE(note || ' | ', '') || ${sqlString(supportNote)})
WHERE code = (
  SELECT code
  FROM activation_codes
  WHERE status = 'unused'
    AND plan = ${sqlString(plan)}
    AND mode = ${sqlString(mode)}
    AND (buyer_email IS NULL OR buyer_email = '')
  ORDER BY created_at ASC, code ASC
  LIMIT 1
)
RETURNING code, plan, mode, buyer_email, note;
`.trim();
}

function displayCode(normalizedCode) {
  const code = String(normalizedCode || "").replace(/[^A-Z0-9]/g, "").toUpperCase();
  const prefix = code.slice(0, 4);
  const rest = code.slice(4).match(/.{1,4}/g)?.join("-") || code.slice(4);
  if (prefix === "AEPM") return `AE-PM-${rest}`;
  if (prefix === "AEPY") return `AE-PY-${rest}`;
  if (prefix === "AEEM") return `AE-EM-${rest}`;
  if (prefix === "AEEY") return `AE-EY-${rest}`;
  return code.match(/.{1,4}/g)?.join("-") || code;
}

function extractReturnedCode(output) {
  const match = String(output).match(/\bAE(?:PM|PY|EM|EY)[A-F0-9]{12}\b/);
  return match?.[0] || "";
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

  const sql = buildIssueSql({
    plan: options.plan,
    mode: planDef.mode,
    email: options.email,
    note: options.note
  });

  if (options.dryRun) {
    console.log(sql);
    return;
  }

  const args = ["d1", "execute", options.db, "--command", sql];
  if (options.remote) args.push("--remote");

  let output;
  try {
    output = execFileSync("wrangler", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    const stderr = error.stderr ? String(error.stderr) : "";
    const stdout = error.stdout ? String(error.stdout) : "";
    console.error(stdout);
    console.error(stderr || error.message);
    console.error("Tip: run with --dry-run to inspect the SQL, or install/login wrangler.");
    process.exit(error.status || 1);
  }

  const normalized = extractReturnedCode(output);
  if (!normalized) {
    console.log(output.trim());
    console.error("No unused code was returned. Check plan stock or whether all matching codes are already assigned.");
    process.exit(2);
  }

  console.log(output.trim());
  console.log("");
  console.log(`Send this activation code to customer: ${displayCode(normalized)}`);
  console.log(`Bound purchase email: ${options.email}`);
}

main();
