/**
 * indicator_sync_state 재시도 테스트
 * 실행: node .\test-indicator-retry.cjs
 * index.js의 실제 함수를 추출해 실행하며, D1은 메모리 FakeD1로 대체합니다.
 */
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const assert = require("node:assert/strict");

const source = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");

function extractFunction(name) {
  const re = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const match = re.exec(source);
  if (!match) throw new Error(`index.js에서 ${name} 함수를 찾지 못했습니다.`);
  const start = match.index;
  const open = source.indexOf("{", start);
  let depth = 0, quote = null, escaped = false;
  let lineComment = false, blockComment = false, template = false;
  for (let i = open; i < source.length; i++) {
    const ch = source[i], next = source[i + 1];
    if (lineComment) { if (ch === "\n") lineComment = false; continue; }
    if (blockComment) {
      if (ch === "*" && next === "/") { blockComment = false; i++; }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (template) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === "`") template = false;
      continue;
    }
    if (ch === "/" && next === "/") { lineComment = true; i++; continue; }
    if (ch === "/" && next === "*") { blockComment = true; i++; continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === "`") { template = true; continue; }
    if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`${name} 함수의 끝을 찾지 못했습니다.`);
}

const names = [
  "addD1WriteMetrics", "saveIndicators", "markIndicatorsPending", "markIndicatorsCompleted",
  "markIndicatorsError", "indicatorsArePending", "saveIndicatorsWithState"
];

class FakeStatement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql.replace(/\s+/g, " ").trim().toUpperCase();
    this.values = [];
  }
  bind(...values) { this.values = values; return this; }
  async run() {
    if (this.sql.startsWith("INSERT INTO INDICATOR_SYNC_STATE")) {
      if (this.db.failPendingWrite) throw new Error("forced pending-state write failure");
      const [code, startedAt] = this.values;
      this.db.states.set(code, {
        status: "pending", started_at: startedAt, completed_at: null, last_error: null
      });
      return { success: true };
    }
    if (this.sql.startsWith("UPDATE INDICATOR_SYNC_STATE") &&
        this.sql.includes("STATUS='COMPLETED'")) {
      if (this.db.failCompletedWrite) throw new Error("forced completed-state write failure");
      const [completedAt, watermarkCode, code] = this.values;
      const state = this.db.states.get(code);
      if (!state) throw new Error(`state row missing: ${code}`);
      state.status = "completed";
      state.completed_at = completedAt;
      state.source_updated_at = this.db.candleWatermarks.get(watermarkCode) || null;
      state.last_error = null;
      return { success: true };
    }
    if (this.sql.startsWith("UPDATE INDICATOR_SYNC_STATE") &&
        this.sql.includes("LAST_ERROR=?")) {
      const [error, code] = this.values;
      const state = this.db.states.get(code);
      if (state && state.status === "pending") state.last_error = error;
      return { success: true };
    }
    throw new Error(`지원하지 않는 FakeD1 run SQL: ${this.sql}`);
  }
  async first() {
    if (this.sql.includes("FROM INDICATOR_SYNC_STATE") &&
        this.sql.includes("STATUS='PENDING'")) {
      const [code] = this.values;
      return this.db.states.get(code)?.status === "pending" ? { pending: 1 } : null;
    }
    throw new Error(`지원하지 않는 FakeD1 first SQL: ${this.sql}`);
  }
}

class FakeD1 {
  constructor() {
    this.states = new Map();
    this.candleWatermarks = new Map([["005930", "2026-11-20T00:00:00.000Z"], ["000660", "2026-11-20T00:00:00.000Z"], ["035420", "2026-11-20T00:00:00.000Z"]]);
    this.indicatorRows = new Map();
    this.batchCalls = 0;
    this.failBatchNumber = 0;
    this.failPendingWrite = false;
    this.failCompletedWrite = false;
  }
  prepare(sql) { return new FakeStatement(this, sql); }
  async batch(statements) {
    this.batchCalls++;
    if (this.failBatchNumber === this.batchCalls) {
      throw new Error(`forced indicator batch failure #${this.batchCalls}`);
    }
    for (const statement of statements) {
      const [code, date, ...values] = statement.values;
      this.indicatorRows.set(`${code}|${date}`, values);
    }
    return statements.map(() => ({ success: true }));
  }
}

// 프로젝트의 80건 단위 D1 batch 저장 동작을 모사합니다.
async function d1Batch(db, statements) {
  for (let i = 0; i < statements.length; i += 80) {
    await db.batch(statements.slice(i, i + 80));
  }
}
function isoNow() { return new Date().toISOString(); }

const sandbox = { module: { exports: {} }, console, Date, String, Error, d1Batch, isoNow };
vm.createContext(sandbox);
vm.runInContext(
  `${names.map(extractFunction).join("\n\n")}\nmodule.exports = { ${names.join(", ")} };`,
  sandbox
);
const { saveIndicatorsWithState, indicatorsArePending } = sandbox.module.exports;

function makeRows(count) {
  return Array.from({ length: count }, (_, i) => ({
    date: `2026-01-${String(i + 1).padStart(3, "0")}`,
    ema5: 5 + i, ema10: 10 + i, ema20: 20 + i,
    ema60: 60 + i, ema120: 120 + i, rsi14: 50,
    macd: 1, macdSignal: 0.5, macdHist: 0.5
  }));
}

async function main() {
  const rows = makeRows(160);
  const db = new FakeD1();

  console.log("[1/5] 두 번째 지표 저장 배치 실패");
  db.failBatchNumber = 2;
  await assert.rejects(
    () => saveIndicatorsWithState(db, "005930", rows, false),
    /forced indicator batch failure #2/
  );
  assert.equal(db.indicatorRows.size, 80);
  assert.equal(await indicatorsArePending(db, "005930"), true);
  assert.equal(db.states.get("005930").status, "pending");
  assert.match(db.states.get("005930").last_error, /batch failure/);
  console.log("  통과: 첫 80건 저장 후 실패, pending 유지");

  console.log("[2/5] 재시도 대상 판정");
  assert.equal(await indicatorsArePending(db, "005930"), true);
  console.log("  통과: 실패 종목을 재시도 대상으로 인식");

  console.log("[3/5] 재시도 성공");
  db.failBatchNumber = 0;
  db.batchCalls = 0;
  const saved = await saveIndicatorsWithState(db, "005930", rows, true);
  assert.equal(saved, 160);
  assert.equal(db.indicatorRows.size, 160);
  assert.equal(await indicatorsArePending(db, "005930"), false);
  assert.equal(db.states.get("005930").status, "completed");
  assert.ok(db.states.get("005930").completed_at);
  assert.equal(db.states.get("005930").source_updated_at, "2026-11-20T00:00:00.000Z");
  assert.equal(db.states.get("005930").last_error, null);
  console.log("  통과: 160건 저장 후 completed 전환");

  console.log("[4/5] pending 기록 실패 시 지표 저장 차단");
  const db2 = new FakeD1();
  db2.failPendingWrite = true;
  await assert.rejects(
    () => saveIndicatorsWithState(db2, "000660", rows, false),
    /pending-state write failure/
  );
  assert.equal(db2.batchCalls, 0);
  assert.equal(db2.indicatorRows.size, 0);
  console.log("  통과: pending 기록 실패 시 지표 batch 미실행");

  console.log("[5/5] completed 기록 실패 시 pending 유지");
  const db3 = new FakeD1();
  db3.failCompletedWrite = true;
  await assert.rejects(
    () => saveIndicatorsWithState(db3, "035420", rows, false),
    /completed-state write failure/
  );
  assert.equal(await indicatorsArePending(db3, "035420"), true);
  assert.equal(db3.states.get("035420").status, "pending");
  console.log("  통과: 완료 기록 실패 후 pending 유지");

  console.log("\n모든 indicator_sync_state 재시도 테스트 통과");
  console.log("운영 D1 접속 / 원격 Worker 배포: 수행하지 않음");
}
main().catch(error => {
  console.error("\n테스트 실패:", error);
  process.exitCode = 1;
});
