const fs = require("fs");

const source = fs.readFileSync("index.js", "utf8");
const startMatch = source.match(/async function saveCandles\s*\(/);\nconst start = startMatch ? startMatch.index : -1;
const end = source.indexOf("\nasync function saveIndicators", start);

if (start < 0 || end < 0) {
  throw new Error("saveCandles 함수 위치를 확인할 수 없습니다.");
}

const functionSource = source.slice(start, end).trim();
const createSaveCandles = new Function(
  "d1Batch",
  "isoNow",
  `return (${functionSource});`
);

const saveCandles = createSaveCandles(
  async (db, statements) => {
    if (statements.length) await db.batch(statements);
  },
  () => "2026-11-14T00:00:00.000Z"
);

function createFakeDB(seed) {
  const data = new Map(seed.map(x => [
    String(x.date), { ...x }
  ]));

  return {
    data,

    prepare(sql) {
      return {
        sql,
        args: [],

        bind(...args) {
          this.args = args;
          return this;
        },

        async all() {
          return {
            results: [...data.values()].map(x => ({ ...x }))
          };
        }
      };
    },

    async batch(statements) {
      for (const statement of statements) {
        const a = statement.args;
        const key = String(a[1]);

        const old = data.get(key);

        const row = {
          code: a[0],
          date: a[1],
          open: a[2],
          high: a[3],
          low: a[4],
          close: a[5],
          volume: a[6],
          trade_value: a[7],
          source: a[8],
          updated_at: a[9]
        };

        if (old) {
          Object.assign(old, row);
        } else {
          data.set(key, row);
        }
      }
    }
  };
}

function assert(condition, message) {
  if (!condition) throw new Error("검증 실패: " + message);
  console.log("[통과] " + message);
}

(async () => {
  const db = createFakeDB([
    {
      code: "005930",
      date: "20261109",
      open: 190000,
      high: 191000,
      low: 188000,
      close: 189200,
      volume: 19344382,
      trade_value: 987654321000,
      source: "KIS",
      updated_at: "OLD"
    },
    {
      code: "005930",
      date: "20261110",
      open: 188000,
      high: 190000,
      low: 187000,
      close: 189000,
      volume: 10000000,
      trade_value: 555555555000,
      source: "NAVER",
      updated_at: "OLD"
    }
  ]);

  const incoming = [
    {
      date: "20261109",
      open: 187000,
      high: 188000,
      low: 185000,
      close: 187000,
      volume: 19855892
    },
    {
      date: "20261110",
      open: 188000,
      high: 190000,
      low: 187000,
      close: 189000,
      volume: 10000000
    },
    {
      date: "20261111",
      open: 189000,
      high: 192000,
      low: 188000,
      close: 191000,
      volume: 12000000
    }
  ];

  console.log("\n========== 1차 저장 테스트 ==========");

  const result1 = await saveCandles(db, "005930", incoming);

  console.log("저장 결과:", result1);

  const corrected = db.data.get("20261109");
  const unchanged = db.data.get("20261110");
  const inserted = db.data.get("20261111");

  assert(result1.updated === 1, "과거 KIS 일봉 1건 갱신");
  assert(result1.inserted === 1, "신규 일봉 1건 삽입");
  assert(result1.unchanged === 1, "동일 일봉 1건 변경 없음");

  assert(corrected.close === 187000, "과거 종가가 NAVER 값으로 정정됨");
  assert(corrected.volume === 19855892, "과거 거래량이 NAVER 값으로 정정됨");
  assert(corrected.trade_value === 987654321000, "기존 거래대금 보존");
  assert(corrected.source === "NAVER", "기존 KIS 출처가 NAVER로 변경됨");

  assert(unchanged.trade_value === 555555555000, "변경 없는 일봉의 거래대금 보존");
  assert(inserted.trade_value === 0, "거래대금 없는 신규 일봉은 0으로 저장");
  assert(inserted.source === "NAVER", "신규 일봉 출처 NAVER 저장");

  console.log("\n========== 2차 동일 데이터 재입력 ==========");

  const result2 = await saveCandles(db, "005930", incoming);

  console.log("재입력 결과:", result2);

  assert(result2.inserted === 0, "중복 신규 삽입 없음");
  assert(result2.updated === 0, "불필요한 재갱신 없음");
  assert(result2.unchanged === 3, "세 날짜 모두 변경 없음");

  console.log("\n========== 최종 결과 ==========");
  console.log("전체 테스트 통과");
  console.log("최종 일봉 개수:", db.data.size);
  console.log("운영 D1 접속: 없음");
})().catch(error => {
  console.error("\n[테스트 실패]", error);
  process.exitCode = 1;
});
