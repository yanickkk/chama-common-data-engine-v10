const fs = require("node:fs");
const vm = require("node:vm");
const assert = require("node:assert/strict");

const source = fs.readFileSync("index.js", "utf8");
const match = source.match(/function historyBudgetDecision\s*\(/);
if (!match) throw new Error("historyBudgetDecision 함수가 없습니다.");

const start = match.index;
const open = source.indexOf("{", start);
let depth = 0, quote = null, escaped = false;
for (let i = open; i < source.length; i++) {
  const ch = source[i];
  if (quote) {
    if (escaped) escaped = false;
    else if (ch === "\\") escaped = true;
    else if (ch === quote) quote = null;
    continue;
  }
  if (ch === "'" || ch === '"') { quote = ch; continue; }
  if (ch === "{") depth++;
  if (ch === "}" && --depth === 0) {
    const fn = source.slice(start, i + 1);
    const sandbox = { module: { exports: {} } };
    vm.runInNewContext(fn + "\nmodule.exports = historyBudgetDecision;", sandbox);
    module.exports = sandbox.module.exports;
    break;
  }
}
const decide = module.exports;
assert.equal(typeof decide, "function");

function check(reserved, actual, reserve, budget, expected, label) {
  const result = decide(reserved, actual, reserve, budget);
  assert.equal(result.allowed, expected, label);
  console.log("[통과]", label, result);
}

check(0, 0, 5000, 25000, true, "첫 종목 예약 허용");
check(20000, 12000, 5000, 25000, true, "예약량이 실제량보다 클 때 한도 내 허용");
check(20000, 23000, 5000, 25000, false, "실제 누적량이 예약량보다 크면 다음 종목 차단");
check(25000, 20000, 5000, 25000, false, "일일 예약 한도 도달 후 차단");
check(0, 26000, 5000, 25000, false, "계측 실제량이 한도를 초과하면 차단");
check(1000, 0, 5000, 25000, true, "초기 대기열 예약량 포함 후에도 허용");
check(75000, 60000, 5000, 80000, true, "임시 8만 행 예산에서 마지막 예약 허용");
check(80000, 60000, 5000, 80000, false, "임시 8만 행 예산 도달 후 차단");
check(70000, 81000, 5000, 80000, false, "실제 기록량이 8만 행 한도를 넘으면 차단");

console.log("\n모든 D1 백필 예산 가드 테스트 통과");
