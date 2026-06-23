import { execFileSync } from "node:child_process";

const PLAN_DEFS = {
  PERSONAL_MONTHLY: { mode: "consumer", months: 1 },
  PERSONAL_YEARLY: { mode: "consumer", months: 12 },
  ENTERPRISE_MONTHLY: { mode: "enterprise", months: 1 },
  ENTERPRISE_YEARLY: { mode: "enterprise", months: 12 }
};

function usage() {
  console.error([
    "Usage:",
    "  node scripts/renew-license.js --plan PERSONAL_YEARLY --email buyer@example.com",
    "",
    "Behavior:",
    "  Extends the customer's existing license directly in D1.",
    "  If the license is still active, the new period is added from current expires_at.",
    "  If the license is expired, the new period is added from now.",
    "",
    "Options:",
    "  --plan <PLAN>          Required.",
    "  --email <EMAIL>        Required. Purchase email on the existing license.",
    "  --license-id <ID>      Optional. Use when a customer has multiple licenses.",
    "  --db <NAME>            D1 database name. Default: applyease-license.",
    "  --local                Use local D1 instead of --remote.",
    "  --dry-run              Print SQL without calling wrangler.",
    "",
    "Plans:",
    `  ${Object.keys(PLAN_DEFS).join(", ")}`
  ].join("\n"));
}

function normalizeEmail(raw) {
  const value = String(raw || "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value) ? value : "";
}

function sqlString(value) {
  if (value === null || value === undefined) return "NULL";
  return `'${String(value).replaceAll("'", "''")}'`;
}

function parseArgs(argv) {
  const options = {
    db: "applyease-license",
    remote: true,
    dryRun: false,
    licenseId: ""
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--plan") {
      options.plan = String(argv[++i] || "").trim().toUpperCase();
    } else if (arg === "--email") {
      options.email = normalizeEmail(argv[++i]);
    } else if (arg === "--license-id") {
      options.licenseId = String(argv[++i] || "").trim();
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

function buildTargetWhere({ email, mode, licenseId }) {
  const filters = [
    `buyer_email = ${sqlString(email)}`,
    `mode = ${sqlString(mode)}`,
    "status != 'revoked'"
  ];
  if (licenseId) filters.push(`license_id = ${sqlString(licenseId)}`);
  return filters.join("\n    AND ");
}

function buildRenewSql(options, planDef) {
  const targetWhere = buildTargetWhere({
    email: options.email,
    mode: planDef.mode,
    licenseId: options.licenseId
  });
  const interval = `+${planDef.months} months`;

  return `
UPDATE licenses
SET
  plan = ${sqlString(options.plan)},
  expires_at = strftime(
    '%Y-%m-%dT%H:%M:%fZ',
    CASE
      WHEN datetime(expires_at) > datetime('now')
      THEN datetime(expires_at, ${sqlString(interval)})
      ELSE datetime('now', ${sqlString(interval)})
    END
  ),
  status = 'active'
WHERE license_id = (
  SELECT license_id
  FROM licenses
  WHERE ${targetWhere}
  ORDER BY datetime(activated_at) DESC, license_id DESC
  LIMIT 1
)
RETURNING license_id, buyer_email, mode, plan, expires_at, status;
`.trim();
}

function runWranglerSql(options, sql) {
  const args = ["d1", "execute", options.db, "--command", sql];
  if (options.remote) args.push("--remote");
  return execFileSync("wrangler", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function hasReturnedLicense(output) {
  return /\blic_[A-Za-z0-9_-]+\b/.test(String(output || ""));
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
  if (!planDef || !options.email || !options.db) {
    usage();
    process.exit(1);
  }

  const sql = buildRenewSql(options, planDef);
  if (options.dryRun) {
    console.log(sql);
    return;
  }

  const output = runWranglerSql(options, sql);
  if (!hasReturnedLicense(output)) {
    console.error(`No matching non-revoked ${planDef.mode} license found for ${options.email}.`);
    process.exit(1);
  }
  process.stdout.write(output);
}

main();
