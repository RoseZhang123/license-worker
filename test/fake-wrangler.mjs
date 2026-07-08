#!/usr/bin/env node
// 测试用的假 wrangler:根据 fixture(env FAKE_WRANGLER_FIXTURE 指向的 JSON)
// 对 issue-unused-code.js 发出的三类 SQL 返回可预测的输出:
//   1. 冲突检查 SELECT(带 --json) → 返回 { results: [...conflict rows] }
//   2. reserve UPDATE ... RETURNING → 返回一个已存在码(若 fixture 指定)或空
//   3. create INSERT ... RETURNING → 返回新建码
// fixture 结构:
//   {
//     "conflictRows": [{ "kind": "...", "plan": "...", "ref": "...", "status": "..." }],
//     "reserveCode": "AEPYEXISTINGCODE01" | null,   // reserve 命中的已存在码
//     "createCode":  "AEPYNEWCODE000001"            // create 返回的新码
//   }
import { readFileSync, appendFileSync } from "node:fs";

const argv = process.argv.slice(2);
const cmdIdx = argv.indexOf("--command");
const sql = cmdIdx >= 0 ? argv[cmdIdx + 1] : "";
const isJson = argv.includes("--json");

const fixturePath = process.env.FAKE_WRANGLER_FIXTURE;
const fixture = fixturePath ? JSON.parse(readFileSync(fixturePath, "utf8")) : {};

// 记录被调用的 SQL 类型,便于测试断言(可选)。
if (process.env.FAKE_WRANGLER_CALLLOG) {
  const type = sql.includes("UNION ALL") ? "conflict"
    : sql.startsWith("UPDATE activation_codes") ? "reserve"
    : sql.startsWith("INSERT INTO activation_codes") ? "create"
    : "other";
  appendFileSync(process.env.FAKE_WRANGLER_CALLLOG, type + "\n");
}

function emitJson(rows) {
  process.stdout.write(JSON.stringify([{ success: true, results: rows }]));
}

if (sql.includes("UNION ALL") && sql.includes("kind")) {
  // 冲突检查查询
  if (isJson) emitJson(fixture.conflictRows || []);
  else process.stdout.write("");
  process.exit(0);
}

if (sql.startsWith("UPDATE activation_codes")) {
  // reserve:命中已存在码则回一行(文本形态,和真实 wrangler 文本输出兼容,含码即可)
  const code = fixture.reserveCode;
  if (code) process.stdout.write(`code\n${code}\n`);
  else process.stdout.write("");
  process.exit(0);
}

if (sql.startsWith("INSERT INTO activation_codes")) {
  const code = fixture.createCode || "AEPYNEWCODE000001";
  process.stdout.write(`code\n${code}\n`);
  process.exit(0);
}

process.stdout.write("");
process.exit(0);
