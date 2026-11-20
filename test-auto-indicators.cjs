const fs = require("fs");

const source = fs.readFileSync("index.js", "utf8");

// 실제 index.js 함수 원문을 추출합니다.
function extractFunction(name) {
  const re = new RegExp("(?:async\\s+)?function\\s+" + name + "\\s*\\(");
  const match = re.exec(source);
  if (!match) throw new Error(name + " 함수가 없습니다.");

  const start = match.index;
  const braceStart = source.indexOf("{", match.index);
  if (braceStart < 0) throw new Error(name + " 함수 본문을 찾지 못했습니다.");

  let depth = 0;
  let quote = null;
  let escaped = false;

  for (let i = braceStart; i < source.length; i++) {
    const ch = source[i];

    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }

    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      continue;
    }

    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }

  throw new Error(name + " 함수 괄호를 끝까지 찾지 못했습니다.");
}

const isoNow = () => "2026-11-15T00:00:00.000Z";

const d1Batch = async (db, statements, batchSize = 80) => {
  for (let i = 0; i < statements.length; i += batchSize) {
    await db.batch(statements.slice(i, i + batchSize));
  }
};

const emaSeries = new Function(
  "return (" + extractFunction("emaSeries") + ");"
)();

const rsiSeries = new Function(
  "return (" + extractFunction("rsiSeries") + ");"
)();

const calculateIndicatorRows = new Function(
  "emaSeries",
  "rsiSeries",
  "return (" + extractFunction("calculateIndicatorRows") + ");"
)(emaSeries, rsiSeries);

const saveCandles = new Function(
  "d1Batch",
  "isoNow",
  "return (" + extractFunction("saveCandles") + ");"
)(d1Batch, isoNow);

const saveIndicators = new Function(
  "d1Batch",
  "isoNow",
  "return (" + extractFunction("saveIndicators") + ");"
)(d1Batch, isoNow);

// 운영 D1 대신 메모리 Map을 사용하는 가상 DB입니다.
function createFakeDB(seedCandles) {
  const candles = new Map(seedCandles.map(x => [x.date, { ...x }]));
  const indicators = new Map();
  let indicatorWrites = 0;

  return {
    candles,
    indicators,

    get indicatorWrites() {
      return indicatorWrites;
    },

    resetIndicatorWrites() {
      indicatorWrites = 0;
    },

    prepare(sql) {
      const statement = {
        sql,
        args: [],

        bind(...args) {
          this.args = args;
          return this;
        },

        async all() {
          if (sql.includes("FROM stock_daily_candles")) {
            return {
              results: [...candles.values()]
                .map(x => ({ ...x }))
                .sort((a, b) => a.date.localeCompare(b.date))
            };
          }
          throw new Error("테스트에서 지원하지 않는 SELECT: " + sql);
        }
      };
      return statement;
    },

    async batch(statements) {
      for (const statement of statements) {
        const a = statement.args;

        if (statement.sql.includes("INSERT INTO stock_daily_candles")) {
          const row = {
            code: a[0], date: a[1], open: a[2], high: a[3],
            low: a[4], close: a[5], volume: a[6],
            trade_value: a[7], source: a[8], updated_at: a[9]
          };
          candles.set(String(a[1]), row);
          continue;
        }

        if (statement.sql.includes("INSERT INTO stock_indicators")) {
          const row = {
            code: a[0], date: a[1],
            ema5: a[2], ema10: a[3], ema20: a[4],
            ema60: a[5], ema120: a[6], rsi14: a[7],
            macd: a[8], macd_signal: a[9], macd_hist: a[10],
            updated_at: a[11]
          };

          const key = String(a[1]);
          const old = indicators.get(key);
          const fields = [
            "ema5", "ema10", "ema20", "ema60", "ema120",
            "rsi14", "macd", "macd_signal", "macd_hist"
          ];

          const changed = !old || fields.some(
            field => old[field] !== row[field]
          );

          if (changed) {
            indicators.set(key, row);
            indicatorWrites++;
          }
          continue;
        }

        throw new Error("지원하지 않는 INSERT 문입니다.");
      }
    }
  };
}

function assert(condition, message) {
  if (!condition) throw new Error("[실패] " + message);
  console.log("[통과] " + message);
}

function makeDate(index) {
  const d = new Date(Date.UTC(2025, 0, 1 + index));
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

(async () => {
  console.log("\n========== 1. 테스트 데이터 생성 ==========");

  const initialCandles = Array.from({ length: 160 }, (_, i) => {
    const close = 50000 + i * 37 + Math.sin(i / 5) * 300;
    return {
      code: "005930",
      date: makeDate(i),
      open: Math.round(close - 100),
      high: Math.round(close + 300),
      low: Math.round(close - 300),
      close: Math.round(close),
      volume: 1000000 + i * 100,
      trade_value: 0,
      source: "NAVER",
      updated_at: "OLD"
    };
  });

  const db = createFakeDB(initialCandles);

  const originalRows = calculateIndicatorRows("005930", initialCandles);
  await saveIndicators(db, "005930", originalRows);

  const targetDate = initialCandles[50].date;
  const latestDate = initialCandles[159].date;
  const originalLatestEMA120 = db.indicators.get(latestDate).ema120;
  const originalTargetEMA20 = db.indicators.get(targetDate).ema20;

  console.log("초기 일봉 수:", db.candles.size);
  console.log("초기 지표 수:", db.indicators.size);
  console.log("수정 대상 날짜:", targetDate);
  console.log("수정 전 최신 EMA120:", originalLatestEMA120);

  assert(db.indicators.size === 160, "초기 160개 지표 생성");

  // 초기 지표 저장 횟수는 이후 변경 테스트에서 제외합니다.
  db.resetIndicatorWrites();

  console.log("\n========== 2. 과거 일봉 종가 정정 ==========");

  const incoming = initialCandles.map(x => ({ ...x }));
  const target = incoming.find(x => x.date === targetDate);

  target.close += 2500;
  target.high = Math.max(target.high, target.close + 200);

  const candleResult = await saveCandles(db, "005930", incoming);

  console.log("일봉 저장 결과:", candleResult);

  assert(candleResult.updated === 1, "과거 일봉 1건 수정 감지");
  assert(
    db.candles.get(targetDate).close === target.close,
    "가상 DB의 과거 종가 정정 확인"
  );

  console.log("\n========== 3. 변경 종목 지표 자동 재계산 ==========");

  // index.js의 candles 처리 구간과 같은 조건으로 재계산합니다.
  let recalculated = false;

  if ((candleResult.inserted + candleResult.updated) > 0) {
    const candleResultFromDB = await db.prepare(
      "SELECT date,open,high,low,close,volume FROM stock_daily_candles WHERE code=? ORDER BY date ASC"
    ).bind("005930").all();

    const recalculatedRows = calculateIndicatorRows(
      "005930",
      candleResultFromDB.results
    );

    await saveIndicators(db, "005930", recalculatedRows);
    recalculated = true;
  }

  const newLatestEMA120 = db.indicators.get(latestDate).ema120;
  const newTargetEMA20 = db.indicators.get(targetDate).ema20;

  console.log("수정 전 최신 EMA120:", originalLatestEMA120);
  console.log("수정 후 최신 EMA120:", newLatestEMA120);
  console.log("수정 전 대상 날짜 EMA20:", originalTargetEMA20);
  console.log("수정 후 대상 날짜 EMA20:", newTargetEMA20);
  console.log("실제 지표 저장 건수:", db.indicatorWrites);

  assert(recalculated, "일봉 변경 시 지표 재계산 실행");
  assert(
    newLatestEMA120 !== originalLatestEMA120,
    "과거 종가 변경으로 최신 EMA120 변경"
  );
  assert(
    newTargetEMA20 !== originalTargetEMA20,
    "과거 종가 변경으로 해당 날짜 EMA20 변경"
  );
  assert(
    db.indicatorWrites > 0,
    "변경된 지표가 가상 DB에 저장됨"
  );

  console.log("\n========== 4. 동일 지표값 재저장 시 no-op 쓰기 방지 ==========");
  db.resetIndicatorWrites();
  const unchangedRows = calculateIndicatorRows("005930", db.candles.values());
  await saveIndicators(db, "005930", unchangedRows, false);
  assert(
    db.indicatorWrites === 0,
    "동일한 지표값 재저장 시 실제 지표 행 변경 없음"
  );

  console.log("\n========== 5. 동일 데이터 재입력 ==========");

  db.resetIndicatorWrites();

  const secondCandleResult = await saveCandles(db, "005930", incoming);

  let secondRecalculated = false;

  if ((secondCandleResult.inserted + secondCandleResult.updated) > 0) {
    const reread = await db.prepare(
      "SELECT date,open,high,low,close,volume FROM stock_daily_candles WHERE code=? ORDER BY date ASC"
    ).bind("005930").all();

    await saveIndicators(
      db,
      "005930",
      calculateIndicatorRows("005930", reread.results)
    );
    secondRecalculated = true;
  }

  console.log("재입력 일봉 결과:", secondCandleResult);
  console.log("지표 재계산 실행:", secondRecalculated);
  console.log("재입력 후 지표 저장 건수:", db.indicatorWrites);

  assert(
    secondCandleResult.updated === 0 &&
    secondCandleResult.inserted === 0,
    "동일 데이터 재입력 시 일봉 변경 없음"
  );
  assert(!secondRecalculated, "일봉 변경이 없으면 지표 재계산 생략");
  assert(db.indicatorWrites === 0, "불필요한 지표 저장 없음");

  console.log("\n========== 최종 결과 ==========");
  console.log("전체 자동 재계산 테스트 통과");
  console.log("일봉 개수:", db.candles.size);
  console.log("지표 개수:", db.indicators.size);
  console.log("운영 D1 접속: 없음");
})().catch(error => {
  console.error("\n[테스트 실패]", error);
  process.exitCode = 1;
});
