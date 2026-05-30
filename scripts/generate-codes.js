import { randomBytes } from "node:crypto";

const GROUPS = [
  { prefix: "AE-PM", plan: "PERSONAL_MONTHLY", mode: "consumer", duration_days: 30, count: 20 },
  { prefix: "AE-PY", plan: "PERSONAL_YEARLY", mode: "consumer", duration_days: 365, count: 20 },
  { prefix: "AE-EM", plan: "ENTERPRISE_MONTHLY", mode: "team", duration_days: 30, count: 20 },
  { prefix: "AE-EY", plan: "ENTERPRISE_YEARLY", mode: "team", duration_days: 365, count: 20 }
];

function token(bytes = 6) {
  return randomBytes(bytes).toString("hex").toUpperCase().match(/.{1,4}/g).join("-");
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function normalizeCode(value) {
  return String(value).replace(/[^A-Z0-9]/g, "");
}

const createdAt = new Date().toISOString();
const rows = [];
const seen = new Set();

for (const group of GROUPS) {
  for (let i = 0; i < group.count; i++) {
    let code;
    do {
      code = `${group.prefix}-${token()}`;
    } while (seen.has(code));
    seen.add(code);
    rows.push({
      code: normalizeCode(code),
      plan: group.plan,
      mode: group.mode,
      duration_days: group.duration_days,
      status: "unused",
      created_at: createdAt,
      note: `internal testing display_code=${code}`
    });
  }
}

console.log("-- ApplyEase internal testing activation codes");
console.log("-- Import with: wrangler d1 execute applyease-license --file ./seed-codes.sql --remote");
console.log("INSERT INTO activation_codes (code, plan, mode, duration_days, status, created_at, note) VALUES");
console.log(rows.map((row) => `  (${[
  row.code,
  row.plan,
  row.mode,
  row.duration_days,
  row.status,
  row.created_at,
  row.note
].map((value) => typeof value === "number" ? String(value) : sqlString(value)).join(", ")})`).join(",\n") + ";");
