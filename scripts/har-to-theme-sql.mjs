#!/usr/bin/env node
/**
 * Convert a Chrome DevTools HAR capture into additive D1 SQL files.
 * Only theme-related Supabase app_data keys are imported.
 * Authentication/session/profile/watchlist traffic is ignored.
 *
 * Usage:
 *   node scripts/har-to-theme-sql.mjs ./02_theme_detail.har --out ./generated
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const input = args[0];
const outArg = args.indexOf('--out');
const outDir = outArg >= 0 ? args[outArg + 1] : './generated';
if (!input) {
  console.error('Usage: node scripts/har-to-theme-sql.mjs <file.har|file.har.txt> [--out directory]');
  process.exit(2);
}

const ALLOWED = key => key === 'cm_calendar_daily' || key === 'cm_theme_history' ||
  key === 'cm_keyword_map' || /^cm_(theme_issue_auto|schedule_week|step3_date|news_material)_20\\d{2}-\\d{2}-\\d{2}$/.test(key);
const sql = v => v == null ? 'NULL' : `'${String(v).replaceAll("'", "''")}'`;
const asText = v => typeof v === 'string' ? v : JSON.stringify(v);
const sha = v => crypto.createHash('sha256').update(asText(v)).digest('hex');
const dateFrom = row => {
  const candidates = [row?.date, row?.base_date, row?.data_date, row?.trade_date, row?.ymd, row?.week_start, row?.start_date];
  for (const x of candidates) {
    if (typeof x !== 'string') continue;
    const m = x.match(/(20\\d{2})[-.]?(\\d{2})[-.]?(\\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  }
  return '';
};
const keyFrom = row => String(row?.key ?? row?.data_key ?? row?.app_key ?? row?.name ?? '');
const entries = [];
const har = JSON.parse(fs.readFileSync(input, 'utf8').replace(/^\\uFEFF/, ''));
for (const entry of har?.log?.entries ?? []) {
  const reqUrl = entry?.request?.url ?? '';
  if (!/\\/rest\\/v1\\/app_data(?:\\?|$)/i.test(reqUrl)) continue;
  const content = entry?.response?.content;
  if (!content?.text) continue;
  let bodyText = content.text;
  if (content.encoding === 'base64') bodyText = Buffer.from(bodyText, 'base64').toString('utf8');
  let body;
  try { body = JSON.parse(bodyText); } catch { continue; }
  const rows = Array.isArray(body) ? body : [body];
  for (const row of rows) {
    const key = keyFrom(row);
    if (!ALLOWED(key)) continue;
    const payload = row?.value ?? row?.data ?? row?.json_data ?? row;
    const payloadRows = Array.isArray(payload) ? payload : [payload];
    payloadRows.forEach((item, idx) => {
      const date = dateFrom(item) || dateFrom(row);
      const recordId = String(item?.id ?? item?.record_id ?? item?.keyword ?? item?.theme_code ?? idx);
      const payloadJson = asText(item);
      entries.push({ key, date, recordId, payloadJson, sourceUrl: reqUrl, hash: sha(payloadJson) });
    });
  }
}

if (!entries.length) {
  console.error('No allowlisted app_data rows found. Check the HAR Supabase /rest/v1/app_data responses.');
  process.exit(1);
}
fs.mkdirSync(outDir, { recursive: true });
const seen = new Set();
const unique = entries.filter(x => {
  const k = `${x.key}\\u0000${x.date}\\u0000${x.recordId}`;
  if (seen.has(k)) return false;
  seen.add(k); return true;
});
const statements = unique.map(x => `INSERT OR REPLACE INTO theme_source_records (source_name,source_key,source_date,record_id,payload_json,source_url,payload_sha256,imported_at) VALUES ('SUPABASE_APP_DATA',${sql(x.key)},${sql(x.date)},${sql(x.recordId)},${sql(x.payloadJson)},${sql(x.sourceUrl)},${sql(x.hash)},CURRENT_TIMESTAMP);`);
const maxBytes = 400_000;
let part = 1, buffer = '';
for (const statement of statements) {
  if (Buffer.byteLength(buffer + statement + '\\n') > maxBytes && buffer) {
    fs.writeFileSync(path.join(outDir, `theme-source-${String(part++).padStart(3,'0')}.sql`), buffer);
    buffer = '';
  }
  buffer += statement + '\\n';
}
if (buffer) fs.writeFileSync(path.join(outDir, `theme-source-${String(part).padStart(3,'0')}.sql`), buffer);
const dates = unique.map(x=>x.date).filter(Boolean).sort();
const report = { input: path.resolve(input), entriesInHar: har?.log?.entries?.length ?? 0,
  matchingRows: entries.length, uniqueRecords: unique.length, keys: [...new Set(unique.map(x=>x.key))].sort(),
  dateRange: { from: dates[0] ?? null, to: dates.at(-1) ?? null }, sqlFiles: part };
fs.writeFileSync(path.join(outDir, 'import-report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
