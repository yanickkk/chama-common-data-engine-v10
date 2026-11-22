/**
 * Theme leadership and qualified TOP10 aggregation.
 *
 * This module is deliberately pure: it does not fetch data, write D1, or alter
 * the existing buildChama()/cmMatches() rules. It consumes a complete market
 * snapshot, theme membership rows, and the already-qualified ChamaZone/CM
 * candidates returned by the existing screener.
 */

const numberOrNull = value => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};

const normalizeCode = value => String(value ?? '').trim().toUpperCase();

function isEligibleQuote(row) {
  const market = String(row?.market ?? '').toUpperCase();
  const securityType = String(row?.securityType ?? row?.security_type ?? '').toUpperCase();
  const verified = row?.securityVerified === true ||
    Number(row?.securityVerified ?? row?.security_verified ?? 0) === 1;
  return verified &&
    ['KOSPI', 'KOSDAQ'].includes(market) &&
    ['COMMON', 'PREFERRED'].includes(securityType) &&
    normalizeCode(row?.code).length === 6;
}

function percentileScore(value, values, direction = 'desc') {
  const target = numberOrNull(value);
  const valid = values.map(numberOrNull).filter(v => v !== null);
  if (target === null || valid.length <= 1) return target === null ? 0 : 100;

  const sorted = [...valid].sort((a, b) => direction === 'asc' ? a - b : b - a);
  const first = sorted.findIndex(v => v === target);
  let last = first;
  while (last + 1 < sorted.length && sorted[last + 1] === target) last++;
  const midRank = (first + last) / 2;
  return Number((direction === 'asc'
    ? (midRank / (sorted.length - 1)) * 100
    : ((sorted.length - 1 - midRank) / (sorted.length - 1)) * 100
  ).toFixed(2));
}

function median(values) {
  const sorted = values.map(numberOrNull).filter(v => v !== null).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Build theme leadership from broad market quotes and existing theme mappings.
 * MARKET_ONLY mappings are valid for market grouping, but never treated as
 * business-verified membership and never weighted by allocation_weight.
 */
export function buildThemeLeadership(marketRows = [], membershipRows = [], options = {}) {
  const topN = Math.max(1, Math.min(30, Math.floor(Number(options.topN) || 10)));
  const minMembers = Math.max(2, Math.floor(Number(options.minMembers) || 3));
  const minCoveragePct = Math.max(0, Math.min(100, Number(options.minCoveragePct ?? 40)));

  const quotes = new Map();
  for (const row of marketRows) {
    if (!isEligibleQuote(row)) continue;
    const code = normalizeCode(row.code);
    const price = numberOrNull(row.price);
    const changePct = numberOrNull(row.changePct ?? row.change_pct);
    const tradeValue = numberOrNull(row.tradeValue ?? row.trade_value ?? row.value);
    if (price === null || price <= 0 || changePct === null) continue;
    quotes.set(code, {
      ...row,
      code,
      changePct,
      tradeValue: Math.max(0, tradeValue ?? 0),
      volume: Math.max(0, numberOrNull(row.volume) ?? 0)
    });
  }

  const groups = new Map();
  const seen = new Set();
  for (const row of membershipRows) {
    if (row?.active === 0 || row?.active === false) continue;
    const evidence = String(row.evidenceStatus ?? row.evidence_status ?? '').toUpperCase();
    if (evidence && !['MARKET_ONLY', 'CONFIRMED'].includes(evidence)) continue;
    const code = normalizeCode(row.code);
    const themeCode = String(row.themeCode ?? row.theme_code ?? '').trim();
    const themeName = String(row.themeName ?? row.theme_name ?? '').trim();
    if (!code || !themeCode || !themeName) continue;
    const key = themeCode + '|' + code;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!groups.has(themeCode)) groups.set(themeCode, {
      themeCode,
      themeName,
      members: new Map()
    });
    const quote = quotes.get(code);
    groups.get(themeCode).members.set(code, {
      code,
      name: String(row.name ?? row.stockName ?? quote?.name ?? code),
      market: String(row.market ?? quote?.market ?? ''),
      evidenceStatus: evidence || 'UNSPECIFIED',
      quote: quote || null
    });
  }

  const drafts = [];
  for (const group of groups.values()) {
    const allMembers = [...group.members.values()];
    const quoted = allMembers.map(x => x.quote).filter(Boolean);
    if (allMembers.length < minMembers || !quoted.length) continue;
    const coveragePct = allMembers.length ? quoted.length / allMembers.length * 100 : 0;
    if (coveragePct < minCoveragePct) continue;

    const changes = quoted.map(x => x.changePct);
    const tradeValues = quoted.map(x => x.tradeValue);
    const upCount = changes.filter(x => x > 0).length;
    const downCount = changes.filter(x => x < 0).length;
    const totalTradeValue = tradeValues.reduce((sum, x) => sum + x, 0);
    const positiveTradeValue = quoted
      .filter(x => x.changePct > 0)
      .reduce((sum, x) => sum + x.tradeValue, 0);
    drafts.push({
      themeCode: group.themeCode,
      themeName: group.themeName,
      memberCount: allMembers.length,
      quotedCount: quoted.length,
      coveragePct: Number(coveragePct.toFixed(2)),
      upCount,
      downCount,
      breadthPct: Number((upCount / quoted.length * 100).toFixed(2)),
      medianChangePct: Number(median(changes).toFixed(3)),
      averageChangePct: Number((changes.reduce((a, b) => a + b, 0) / changes.length).toFixed(3)),
      totalTradeValue,
      positiveTradeValuePct: totalTradeValue
        ? Number((positiveTradeValue / totalTradeValue * 100).toFixed(2))
        : 0,
      members: allMembers
    });
  }

  const tradeValues = drafts.map(x => x.totalTradeValue);
  const breadthValues = drafts.map(x => x.breadthPct);
  const medianChanges = drafts.map(x => x.medianChangePct);
  const positiveTradeValues = drafts.map(x => x.positiveTradeValuePct);

  const themes = drafts.map(theme => {
    const tradeValueScore = percentileScore(theme.totalTradeValue, tradeValues, 'desc');
    const breadthScore = percentileScore(theme.breadthPct, breadthValues, 'desc');
    const returnScore = percentileScore(theme.medianChangePct, medianChanges, 'desc');
    const positiveFlowScore = percentileScore(theme.positiveTradeValuePct, positiveTradeValues, 'desc');
    const leadershipScore = Number((
      tradeValueScore * 0.35 +
      breadthScore * 0.30 +
      returnScore * 0.25 +
      positiveFlowScore * 0.10
    ).toFixed(2));

    const members = theme.members
      .filter(x => x.quote)
      .map(x => ({
        code: x.code,
        name: x.name,
        market: x.market,
        changePct: x.quote.changePct,
        tradeValue: x.quote.tradeValue,
        price: numberOrNull(x.quote.price),
        evidenceStatus: x.evidenceStatus
      }))
      .sort((a, b) =>
        b.changePct - a.changePct ||
        b.tradeValue - a.tradeValue ||
        a.code.localeCompare(b.code)
      );

    return {
      ...theme,
      members: undefined,
      leadershipScore,
      scoreComponents: {
        tradeValue: tradeValueScore,
        breadth: breadthScore,
        medianReturn: returnScore,
        positiveTradeValue: positiveFlowScore
      },
      members
    };
  }).sort((a, b) =>
    b.leadershipScore - a.leadershipScore ||
    b.totalTradeValue - a.totalTradeValue ||
    a.themeCode.localeCompare(b.themeCode)
  );

  return {
    status: themes.length ? 'READY' : (membershipRows.length ? 'INSUFFICIENT_COVERAGE' : 'THEME_MAP_REQUIRED'),
    methodology: 'tradeValue 35% + advancing breadth 30% + median return 25% + positive-flow trade value 10%; rank-percentile based',
    themeCount: themes.length,
    themes: themes.slice(0, topN),
    dataQuality: {
      eligibleMarketQuotes: quotes.size,
      themeMembershipRows: membershipRows.length,
      themesWithSufficientCoverage: themes.length,
      minMembers,
      minCoveragePct
    }
  };
}

/**
 * Merge existing ChamaZone and CM-qualified stocks, then keep only stocks that
 * belong to the selected leading themes. Existing qualification rules are not
 * recalculated or relaxed here.
 */
export function buildQualifiedLeaderTop10(themeLeadership, chamaCandidates = [], cmCandidates = [], topN = 10) {
  const themes = Array.isArray(themeLeadership?.themes) ? themeLeadership.themes : [];
  if (!themes.length) return [];

  const themeByCode = new Map(themes.map(theme => [theme.themeCode, theme]));
  const memberToThemes = new Map();
  for (const theme of themes) {
    for (const member of theme.members || []) {
      if (!memberToThemes.has(member.code)) memberToThemes.set(member.code, []);
      memberToThemes.get(member.code).push(theme);
    }
  }

  const merged = new Map();
  const add = (candidate, signal) => {
    const code = normalizeCode(candidate?.code);
    if (!code || !memberToThemes.has(code)) return;
    if (!merged.has(code)) merged.set(code, { ...candidate, code, signals: [] });
    const row = merged.get(code);
    if (!row.signals.includes(signal)) row.signals.push(signal);
    for (const [key, value] of Object.entries(candidate || {})) {
      if (row[key] == null && value != null) row[key] = value;
    }
  };

  chamaCandidates.forEach(x => add(x, 'CHAMAZONE'));
  cmCandidates.forEach(x => add(x, 'CM'));

  const rows = [];
  for (const candidate of merged.values()) {
    const matchedThemes = (memberToThemes.get(candidate.code) || [])
      .sort((a, b) => b.leadershipScore - a.leadershipScore);
    const primaryTheme = matchedThemes[0];
    if (!primaryTheme) continue;
    rows.push({
      ...candidate,
      primaryThemeCode: primaryTheme.themeCode,
      primaryThemeName: primaryTheme.themeName,
      themeLeadershipScore: primaryTheme.leadershipScore,
      relatedThemes: matchedThemes.map(x => ({
        themeCode: x.themeCode,
        themeName: x.themeName,
        leadershipScore: x.leadershipScore
      }))
    });
  }

  return rows.sort((a, b) =>
    b.themeLeadershipScore - a.themeLeadershipScore ||
    (numberOrNull(b.score) ?? 0) - (numberOrNull(a.score) ?? 0) ||
    (numberOrNull(b.achievementRisePct) ?? 0) - (numberOrNull(a.achievementRisePct) ?? 0) ||
    (numberOrNull(b.tradeValue ?? b.value) ?? 0) - (numberOrNull(a.tradeValue ?? a.value) ?? 0) ||
    a.code.localeCompare(b.code)
  ).slice(0, Math.max(1, Math.min(50, Math.floor(Number(topN) || 10))));
}
