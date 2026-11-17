#!/usr/bin/env node
/**
 * Convert theme-related Supabase app_data HAR responses into additive D1 SQL.
 * Handles PostgREST object responses where key is present only in the request URL,
 * and JSON-stringified value payloads returned by the source app.
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
const datedPrefixes = ['cm_theme_issue_auto_', 'cm_schedule_week_', 'cm_step3_date_', 'cm_news_material_'];
const isAllowedKey = key =>
  key === 'cm_calendar_daily' || key === 'cm_theme_history' || key === 'cm_keyword_map' ||
  datedPrefixes.some(prefix => key.startsWith(prefix) && /^20[0-9]{2}-[0-9]{2}-[0-9]{2}$/.test(key.slice(prefix.length)));
const sql = v => v == null ? 'NULL' : "'" + String(v).replaceAll("'", "''") + "'";
const asText = v => typeof v === 'string' ? v : JSON.stringify(v);
const sha = v => crypto.createHash('sha256').update(asText(v)).digest('hex');
const dateFrom = row => {
  for (const x of [row?.date, row?.base_date, row?.data_date, row?.trade_date, row?.ymd, row?.week_start, row?.start_date]) {
    if (typeof x !== 'string') continue;
    const m = x.match(/(20[0-9]{2})[-.]?([0-9]{2})[-.]?([0-9]{2})/);
    if (m) return m[1] + '-' + m[2] + '-' + m[3];
  }
  return '';
};
const keyFromUrl = url => {
  const match = String(url).match(/[?&]key=eq\.([^&]+)/);
  if (!match) return '';
  try { return decodeURIComponent(match[1].replace(/\+/g, ' ')); } catch { return match[1]; }
};
const parsePayload = row => {
  let payload = row?.value ?? row?.data ?? row?.json_data ?? row;
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload); } catch { /* preserve original string */ }
  }
  return payload;
};
const harText = fs.readFileSync(input, 'utf8').replace(String.fromCharCode(0xFEFF), '');
const har = JSON.parse(harText);
const entries = [];
const skipped = { nonAppData: 0, non200: 0, unparsed: 0, disallowed: 0, unsupportedQuery: 0 };
for (const entry of har?.log?.entries ?? []) {
  const reqUrl = entry?.request?.url ?? '';
  if (!reqUrl.includes('/rest/v1/app_data')) { skipped.nonAppData++; continue; }
  if (entry?.response?.status !== 200) { skipped.non200++; continue; }
  const content = entry?.response?.content;
  if (!content?.text) { skipped.unparsed++; continue; }
  let bodyText = content.text;
  if (content.encoding === 'base64') bodyText = Buffer.from(bodyText, 'base64').toString('utf8');
  let body;
  try { body = JSON.parse(bodyText); } catch { skipped.unparsed++; continue; }
  const key = keyFromUrl(reqUrl) || String(body?.key ?? body?.data_key ?? body?.app_key ?? body?.name ?? '');
  if (!isAllowedKey(key)) { skipped.disallowed++; continue; }
  const payload = parsePayload(Array.isArray(body) ? (body[0] ?? {}) : body);
  if (payload == null) { skipped.unparsed++; continue; }

  // These source values are date-keyed maps, not arrays of records.
  const dateMap = key === 'cm_calendar_daily' || key.startsWith('cm_step3_date_') || key.startsWith('cm_schedule_week_');
  if (dateMap && payload && typeof payload === 'object' && !Array.isArray(payload)) {
    for (const [dateKey, item] of Object.entries(payload)) {
      if (!/^20[0-9]{2}-[0-9]{2}-[0-9]{2}$/.test(dateKey)) continue; // omit _meta
      const payloadJson = asText(item);
      entries.push({ key, date: dateKey, recordId: dateKey, payloadJson, sourceUrl: reqUrl, hash: sha(payloadJson) });
    }
  } else {
    const suffixDate = datedPrefixes.map(p => key.startsWith(p) ? key.slice(p.length) : '').find(Boolean) || '';
    const date = dateFrom(payload) || suffixDate;
    const recordId = String(payload?.id ?? payload?.record_id ?? payload?.keyword ?? payload?.theme_code ?? key);
    const payloadJson = asText(payload);
    entries.push({ key, date, recordId, payloadJson, sourceUrl: reqUrl, hash: sha(payloadJson) });
  }
}
if (!entries.length) {
  console.error('No allowlisted app_data rows found. Check the HAR request URL and response body format.');
  process.exit(1);
}
fs.mkdirSync(outDir, { recursive: true });
const seen = new Set();
const unique = entries.filter(x => {
  const k = [x.key, x.date, x.recordId].join('|');
  if (seen.has(k)) return false;
  seen.add(k); return true;
});
const statements = unique.map(x =>
  "INSERT OR REPLACE INTO theme_source_records (source_name,source_key,source_date,record_id,payload_json,source_url,payload_sha256,imported_at) VALUES ('SUPABASE_APP_DATA'," +
  [x.key, x.date, x.recordId, x.payloadJson, x.sourceUrl, x.hash].map(sql).join(',') +
  ',CURRENT_TIMESTAMP);'
);
const newline = String.fromCharCode(10);
const maxBytes = 400_000;
let part = 1, buffer = '';
for (const statement of statements) {
  if (Buffer.byteLength(buffer + statement + newline) > maxBytes && buffer) {
    fs.writeFileSync(path.join(outDir, 'theme-source-' + String(part++).padStart(3,'0') + '.sql'), buffer);
    buffer = '';
  }
  buffer += statement + newline;
}
if (buffer) fs.writeFileSync(path.join(outDir, 'theme-source-' + String(part).padStart(3,'0') + '.sql'), buffer);
const dates = unique.map(x=>x.date).filter(Boolean).sort();
const report = {
  input: path.resolve(input), entriesInHar: har?.log?.entries?.length ?? 0,
  matchingRecords: entries.length, uniqueRecords: unique.length,
  keys: [...new Set(unique.map(x=>x.key))].sort(),
  recordsByKey: Object.fromEntries([...new Set(unique.map(x=>x.key))].sort().map(k=>[k,unique.filter(x=>x.key===k).length])),
  dateRange: { from: dates[0] ?? null, to: dates.at(-1) ?? null }, sqlFiles: part, skipped
};
fs.writeFileSync(path.join(outDir, 'import-report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
