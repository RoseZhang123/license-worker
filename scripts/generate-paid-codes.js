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
    "  node scripts/generate-paid-codes.js --plan PERSONAL_YEARLY --count 5 --note \"launch batch\" > paid-codes.sql",
    "",
    "Plans:",
    `  ${Object.keys(PLAN_DEFS).join(", ")}`,
    "",
    "Options:",
    "  --plan <PLAN>       Required unless --all is used.",
    "  --count <N>         Number of codes to generate per plan. Default: 1.",
    "  --all               Generate --count codes for every plan.",
    "  --note <TEXT>       Optional note stored in D1.",
    "",
    "Import:",
    "  wrangler d1 execute applyease-license --file ./paid-codes.sql --remote"
  ].join("\n"));
}

function parseArgs(argv) {
  const options = { count: 1, all: false, note: "", orderId: "" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--all") {
      options.all = true;
    } else if (arg === "--plan") {
      options.plan = argv[++i];
    } else if (arg === "--count") {
      options.count = Number(argv[++i]);
    } else if (arg === "--note") {
      options.note = argv[++i] || "";
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

function sqlString(value) {
  if (value === null || value === undefined || value === "") return "NULL";
  return `'${String(value).replaceAll("'", "''")}'`;
}

function token(bytes = 6) {
  return randomBytes(bytes).toString("hex").toUpperCase().match(/.{1,4}/g).join("-");
}

function normalizeCode(value) {
  return String(value).replace(/[^A-Z0-9]/g, "");
}

function generateRows(plans, count, note) {
  const createdAt = new Date().toISOString();
  const seen = new Set();
  const rows = [];

  for (const plan of plans) {
    const def = PLAN_DEFS[plan];
    for (let i = 0; i < count; i++) {
      let displayCode;
      do {
        displayCode = `${def.prefix}-${token()}`;
      } while (seen.has(displayCode));
      seen.add(displayCode);

      const normalized = normalizeCode(displayCode);
      const rowNote = [note, `display_code=${displayCode}`].filter(Boolean).join(" | ");
      rows.push({
        code: normalized,
        plan,
        mode: def.mode,
        status: "unused",
        created_at: createdAt,
        note: rowNote
      });
    }
  }

  return rows;
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

  if (!Number.isInteger(options.count) || options.count < 1 || options.count > 500) {
    console.error("--count must be an integer between 1 and 500.");
    process.exit(1);
  }

  const plans = options.all ? Object.keys(PLAN_DEFS) : [options.plan];
  if (!options.all && !PLAN_DEFS[options.plan]) {
    console.error("--plan is required and must be a known plan.");
    usage();
    process.exit(1);
  }

  const rows = generateRows(plans, options.count, options.note);
  console.log("-- ApplyEase paid activation codes");
  console.log("-- Keep this SQL/output outside the extension package.");
  console.log("-- Import with: wrangler d1 execute applyease-license --file ./paid-codes.sql --remote");
  console.log("INSERT INTO activation_codes (code, plan, mode, status, created_at, note) VALUES");
  console.log(rows.map((row) => `  (${[
    row.code,
    row.plan,
    row.mode,
    row.status,
    row.created_at,
    row.note
  ].map(sqlString).join(", ")})`).join(",\n") + ";");
}

main();
