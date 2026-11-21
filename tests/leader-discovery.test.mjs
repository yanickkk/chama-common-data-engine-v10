import assert from 'node:assert/strict';
import { buildThemeLeadership, buildQualifiedLeaderTop10 } from '../leader-discovery.js';

const marketRows = [
  { code: '000001', name: 'A', market: 'KOSPI', securityType: 'COMMON', securityVerified: 1, price: 1000, changePct: 12, tradeValue: 900 },
  { code: '000002', name: 'B', market: 'KOSDAQ', securityType: 'COMMON', securityVerified: 1, price: 2000, changePct: 8, tradeValue: 700 },
  { code: '000003', name: 'C', market: 'KOSPI', securityType: 'PREFERRED', securityVerified: 1, price: 3000, changePct: -1, tradeValue: 100 },
  { code: '000004', name: 'D', market: 'KOSPI', securityType: 'COMMON', securityVerified: 1, price: 4000, changePct: 5, tradeValue: 500 },
  { code: '000005', name: 'E', market: 'KOSDAQ', securityType: 'COMMON', securityVerified: 1, price: 5000, changePct: 3, tradeValue: 400 },
  { code: '000006', name: 'F', market: 'KOSPI', securityType: 'COMMON', securityVerified: 1, price: 6000, changePct: 2, tradeValue: 300 },
  { code: '000007', name: 'ETF', market: 'KOSPI', securityType: 'ETF', securityVerified: 1, price: 7000, changePct: 30, tradeValue: 9999 }
];

const membershipRows = [
  { code: '000001', themeCode: 'T1', themeName: '테마A', evidenceStatus: 'MARKET_ONLY' },
  { code: '000002', themeCode: 'T1', themeName: '테마A', evidenceStatus: 'MARKET_ONLY' },
  { code: '000003', themeCode: 'T1', themeName: '테마A', evidenceStatus: 'CONFIRMED' },
  { code: '000004', themeCode: 'T2', themeName: '테마B', evidenceStatus: 'MARKET_ONLY' },
  { code: '000005', themeCode: 'T2', themeName: '테마B', evidenceStatus: 'MARKET_ONLY' },
  { code: '000006', themeCode: 'T2', themeName: '테마B', evidenceStatus: 'MARKET_ONLY' },
  { code: '000007', themeCode: 'T2', themeName: '테마B', evidenceStatus: 'MARKET_ONLY' }
];

const result = buildThemeLeadership(marketRows, membershipRows, { topN: 5, minMembers: 3 });
assert.equal(result.status, 'READY');
assert.equal(result.themeCount, 2);
assert.equal(result.themes[0].themeCode, 'T1');
assert.equal(result.themes[0].quotedCount, 3);
assert.equal(result.themes[0].upCount, 2);
assert.equal(result.themes[0].members.some(x => x.code === '000007'), false, 'ETF must be excluded');

const top10 = buildQualifiedLeaderTop10(
  result,
  [{ code: '000001', score: 90, chama: true }],
  [{ code: '000002', achievementRisePct: 55 }, { code: '000004', achievementRisePct: 60 }],
  10
);
assert.deepEqual(top10.map(x => x.code), ['000001', '000002']);
assert.deepEqual(top10[0].signals, ['CHAMAZONE']);
assert.deepEqual(top10[1].signals, ['CM']);
assert.equal(top10[0].primaryThemeCode, 'T1');

const noMap = buildThemeLeadership(marketRows, [], {});
assert.equal(noMap.status, 'THEME_MAP_REQUIRED');
assert.deepEqual(buildQualifiedLeaderTop10(noMap, [{ code: '000001' }], [], 10), []);

console.log('leader-discovery tests passed');
