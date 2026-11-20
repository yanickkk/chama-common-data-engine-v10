const DART_BASE = 'https://opendart.fss.or.kr/api';

function decodeXml(value) {
  return String(value || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}
function xmlTag(block, name) {
  const m = block.match(new RegExp('<' + name + '>([\\s\\S]*?)</' + name + '>'));
  return m ? decodeXml(m[1].trim()) : '';
}
async function readZipXml(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('DART corpCode 응답에서 ZIP 중앙 디렉터리를 찾지 못했습니다.');
  const entries = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  for (let n = 0; n < entries; n++) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error('DART ZIP 중앙 디렉터리 형식이 올바르지 않습니다.');
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = new TextDecoder().decode(bytes.slice(offset + 46, offset + 46 + nameLength));
    if (name.toUpperCase().endsWith('CORPCODE.XML')) {
      const localNameLength = view.getUint16(localOffset + 26, true);
      const localExtraLength = view.getUint16(localOffset + 28, true);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = bytes.slice(dataStart, dataStart + compressedSize);
      let plain;
      if (method === 0) plain = compressed;
      else if (method === 8) {
        if (typeof DecompressionStream !== 'function') throw new Error('현재 Worker 런타임에서 ZIP 압축 해제를 지원하지 않습니다.');
        const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        plain = new Uint8Array(await new Response(stream).arrayBuffer());
      } else throw new Error('지원하지 않는 DART ZIP 압축 방식입니다.');
      return new TextDecoder('utf-8').decode(plain);
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error('DART ZIP 안에서 CORPCODE.xml 파일을 찾지 못했습니다.');
}
async function dartRequest(path, params, env) {
  if (!env.DART_API_KEY) throw new Error('DART_API_KEY Worker Secret이 설정되지 않았습니다.');
  const url = new URL(DART_BASE + path);
  for (const [key, value] of Object.entries(params || {})) if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  url.searchParams.set('crtfc_key', env.DART_API_KEY);
  const response = await fetch(url.toString(), { headers: { Accept: 'application/json, application/zip, application/octet-stream' } });
  if (!response.ok) throw new Error('DART API HTTP ' + response.status);
  return response;
}
export async function syncDartCorpMappings(env) {
  const db = env.DB;
  if (!db) throw new Error('D1 DB binding이 없습니다.');
  const response = await dartRequest('/corpCode.xml', {}, env);
  const xml = await readZipXml(await response.arrayBuffer());
  const blocks = xml.match(/<list>[\\s\\S]*?<\\/list>/g) || [];
  const listed = [];
  for (const block of blocks) {
    const corpCode = xmlTag(block, 'corp_code');
    const corpName = xmlTag(block, 'corp_name');
    const stockCode = xmlTag(block, 'stock_code');
    const modifyDate = xmlTag(block, 'modify_date');
    if (/^\\d{8}$/.test(corpCode) && /^\\d{6}$/.test(stockCode)) listed.push({ corpCode, corpName, stockCode, modifyDate });
  }
  const stockRows = await db.prepare("SELECT code,name,market,security_type,security_verified,active FROM stocks WHERE active=1 AND security_verified=1 AND security_type IN ('COMMON','PREFERRED') AND upper(market) IN ('KOSPI','KOSDAQ')").all();
  const eligible = new Map((stockRows.results || []).map(row => [row.code, row]));
  const now = new Date().toISOString();
  let mapped = 0, excluded = 0;
  const statements = [];
  for (const row of listed) {
    const stock = eligible.get(row.stockCode);
    const status = stock ? 'MAPPED' : 'REVIEW';
    if (stock) mapped++; else excluded++;
    statements.push(db.prepare(`INSERT INTO dart_corp_mappings
      (corp_code,corp_name,stock_code,modify_date,mapping_status,security_type,market,source_type,synced_at,updated_at)
      VALUES (?,?,?,?,?,?,?,'DART_CORPCODE',?,?)
      ON CONFLICT(corp_code) DO UPDATE SET corp_name=excluded.corp_name,stock_code=excluded.stock_code,
      modify_date=excluded.modify_date,mapping_status=excluded.mapping_status,security_type=excluded.security_type,
      market=excluded.market,synced_at=excluded.synced_at,updated_at=excluded.updated_at`)
      .bind(row.corpCode,row.corpName,row.stockCode,row.modifyDate,status,stock?.security_type || null,stock?.market || null,now,now));
  }
  for (let i = 0; i < statements.length; i += 50) await db.batch(statements.slice(i, i + 50));
  return { ok: true, source: 'DART_CORPCODE', parsedListedCompanies: listed.length, mappedEligibleStocks: mapped, reviewRequired: excluded, syncedAt: now, note: '검증된 KOSPI/KOSDAQ 보통주·우선주만 MAPPED로 연결했습니다. REVIEW 항목은 자동 종목 연결에 사용하지 않습니다.' };
}
export async function searchDartDisclosures(env, url) {
  const bgn = String(url.searchParams.get('bgn_de') || '').trim();
  const end = String(url.searchParams.get('end_de') || '').trim();
  const datePattern = /^\\d{8}$/;
  if (!datePattern.test(bgn) || !datePattern.test(end) || bgn > end) throw new Error('bgn_de와 end_de는 YYYYMMDD 형식이며 시작일은 종료일 이하여야 합니다.');
  const pageNo = Math.max(1, Math.min(10000, Number(url.searchParams.get('page_no') || 1)));
  const pageCount = Math.max(1, Math.min(100, Number(url.searchParams.get('page_count') || 30)));
  const params = { bgn_de: bgn, end_de: end, page_no: pageNo, page_count: pageCount, sort: 'date', sort_mth: 'desc' };
  for (const key of ['corp_code','pblntf_ty','pblntf_detail_ty','corp_cls']) {
    const value = String(url.searchParams.get(key) || '').trim();
    if (value) params[key] = value;
  }
  const response = await dartRequest('/list.json', params, env);
  const data = await response.json();
  if (data.status !== '000') {
    const safeMessage = data.status === '010' ? 'DART API 인증키가 유효하지 않습니다.' : (data.message || 'DART 공시목록 조회에 실패했습니다.');
    throw new Error('DART ' + data.status + ': ' + safeMessage);
  }
  const db = env.DB;
  const items = data.list || [];
  const corpCodes = [...new Set(items.map(x => x.corp_code).filter(x => /^\\d{8}$/.test(String(x || ''))))];
  const map = new Map();
  if (db && corpCodes.length) {
    for (const batch of Array.from({ length: Math.ceil(corpCodes.length / 80) }, (_, i) => corpCodes.slice(i * 80, (i + 1) * 80))) {
      const marks = batch.map(() => '?').join(',');
      const found = await db.prepare(`SELECT corp_code,corp_name,stock_code,mapping_status FROM dart_corp_mappings WHERE corp_code IN (${marks})`).bind(...batch).all();
      for (const row of found.results || []) map.set(row.corp_code, row);
    }
  }
  return { ok: true, source: 'DART', page_no: pageNo, page_count: pageCount, total_count: Number(data.total_count || 0), total_page: Number(data.total_page || 0),
    disclosures: items.map(item => {
      const link = map.get(item.corp_code);
      return { receipt_no: item.rcept_no, corp_code: item.corp_code, issuer: item.corp_name, report_name: item.report_nm, receipt_date: item.rcept_dt, filer: item.flr_nm, remark: item.rm, source_url: 'https://dart.fss.or.kr/dsaf001/main.do?rcpNo=' + encodeURIComponent(item.rcept_no), stock_code: link?.stock_code || null, mapping_status: link?.mapping_status || 'UNMAPPED', eligible_mapping: link?.mapping_status === 'MAPPED' };
    }) };
}
