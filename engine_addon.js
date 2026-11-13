// ---- Shared market data engine v1 (KIS + Cloudflare D1) ----------------------
let kisTokenCache = { token: null, expiresAt: 0, base: '' };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const isoNow = () => new Date().toISOString();
const ymd = d => `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
function kisBase(env) { return String(env.KIS_MODE || 'paper').toLowerCase() === 'live' ? 'https://openapi.koreainvestment.com:9443' : 'https://openapivts.koreainvestment.com:29443'; }
function requireDb(env) { if (!env.DB) throw new Error('D1 데이터베이스가 연결되지 않았습니다. wrangler.jsonc의 DB binding과 database_id를 설정하세요.'); return env.DB; }
function requireKis(env) { if (!env.KIS_APP_KEY || !env.KIS_APP_SECRET) throw new Error('KIS_APP_KEY와 KIS_APP_SECRET Worker Secret을 먼저 등록하세요.'); }
async function kisToken(env) {
  requireKis(env);
  const base = kisBase(env);
  if (kisTokenCache.token && kisTokenCache.expiresAt > Date.now()+60000 && kisTokenCache.base===base) return kisTokenCache.token;
  const r = await fetch(`${base}/oauth2/tokenP`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({grant_type:'client_credentials',appkey:env.KIS_APP_KEY,appsecret:env.KIS_APP_SECRET}) });
  const d = await r.json().catch(()=>({}));
  if (!r.ok || !d.access_token) throw new Error(`KIS 토큰 발급 실패 HTTP ${r.status}: ${d.error_description||d.msg1||JSON.stringify(d).slice(0,300)}`);
  const expires = Number(d.expires_in || 86400);
  kisTokenCache = { token:d.access_token, expiresAt:Date.now()+Math.min(expires,86400)*1000-120000, base };
  return d.access_token;
}
async function kisGet(env, path, params, trId) {
  const token = await kisToken(env);
  const url = `${kisBase(env)}${path}?${new URLSearchParams(params)}`;
  const r = await fetch(url,{headers:{'authorization':`Bearer ${token}`,'appkey':env.KIS_APP_KEY,'appsecret':env.KIS_APP_SECRET,'tr_id':trId,'custtype':'P','accept':'application/json'}});
  const d = await r.json().catch(()=>({}));
  if (!r.ok || d.rt_cd==='1') throw new Error(`KIS ${trId} 실패 HTTP ${r.status}: ${d.msg1||JSON.stringify(d).slice(0,300)}`);
  return d;
}
function normalizeKisQuote(code,d) {
  const x=d.output||{};
  const price=num(x.stck_prpr), prev=num(x.stck_sdpr)||num(x.stck_prdy_clpr);
  return {code:code6(code),name:x.hts_kor_isnm||x.rprs_mrkt_kor_name||'',price,previousClose:prev,change:num(x.prdy_vrss)??(price!=null&&prev!=null?price-prev:null),changePct:num(x.prdy_ctrt)??(price&&prev?(price/prev-1)*100:0),volume:num(x.acml_vol)||0,tradeValue:num(x.acml_tr_pbmn)||0,open:num(x.stck_oprc),high:num(x.stck_hgpr),low:num(x.stck_lwpr),source:'KIS',updatedAt:isoNow()};
}
async function kisQuote(env,code) {
  const d=await kisGet(env,'/uapi/domestic-stock/v1/quotations/inquire-price',{FID_COND_MRKT_DIV_CODE:'J',FID_INPUT_ISCD:code6(code)},'FHKST01010100');
  return normalizeKisQuote(code,d);
}
async function kisCandles(env,code,days=700) {
  const end=new Date(),start=new Date(end.getTime()-days*86400000);
  const d=await kisGet(env,'/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice',{FID_COND_MRKT_DIV_CODE:'J',FID_INPUT_ISCD:code6(code),FID_INPUT_DATE_1:ymd(start),FID_INPUT_DATE_2:ymd(end),FID_PERIOD_DIV_CODE:'D',FID_ORG_ADJ_PRC:'0'},'FHKST03010100');
  const arr=Array.isArray(d.output2)?d.output2:[];
  return arr.map(x=>({code:code6(code),date:String(x.stck_bsop_date||''),open:num(x.stck_oprc),high:num(x.stck_hgpr),low:num(x.stck_lwpr),close:num(x.stck_clpr),volume:num(x.acml_vol)||0,tradeValue:num(x.acml_tr_pbmn)||0,source:'KIS'})).filter(x=>/^\d{8}$/.test(x.date)&&x.close!=null&&x.high!=null&&x.low!=null).sort((a,b)=>a.date.localeCompare(b.date));
}
function emaSeries(values,period) { if(!values.length)return[]; const k=2/(period+1); let e=values[0]; const out=[e]; for(let i=1;i<values.length;i++){e=values[i]*k+e*(1-k);out.push(e);} return out; }
function rsiSeries(values,period=14) {
  const out=Array(values.length).fill(null); if(values.length<=period)return out;
  let gain=0,loss=0; for(let i=1;i<=period;i++){const d=values[i]-values[i-1];if(d>0)gain+=d;else loss-=d;}
  let avgG=gain/period,avgL=loss/period; out[period]=avgL===0?100:100-100/(1+avgG/avgL);
  for(let i=period+1;i<values.length;i++){const d=values[i]-values[i-1];avgG=(avgG*(period-1)+Math.max(d,0))/period;avgL=(avgL*(period-1)+Math.max(-d,0))/period;out[i]=avgL===0?100:100-100/(1+avgG/avgL);}
  return out;
}
function calculateIndicatorRows(code,candles) {
  const rows=[...candles].sort((a,b)=>a.date.localeCompare(b.date)); const c=rows.map(x=>Number(x.close));
  const e5=emaSeries(c,5),e10=emaSeries(c,10),e20=emaSeries(c,20),e60=emaSeries(c,60),e120=emaSeries(c,120),rsi=rsiSeries(c,14),e12=emaSeries(c,12),e26=emaSeries(c,26);
  const macd=c.map((_,i)=>e12[i]-e26[i]),signal=emaSeries(macd,9),out=[];
  for(let i=0;i<rows.length;i++)out.push({code,date:rows[i].date,ema5:e5[i],ema10:e10[i],ema20:e20[i],ema60:e60[i],ema120:e120[i],rsi14:rsi[i],macd:macd[i],macdSignal:signal[i],macdHist:macd[i]-signal[i]});
  return out;
}
async function d1Batch(db,statements,batchSize=80){for(let i=0;i<statements.length;i+=batchSize)await db.batch(statements.slice(i,i+batchSize));}
async function saveUniverse(db,rows) {
  const stmts=rows.map(x=>db.prepare(`INSERT INTO stocks(code,name,market,market_cap,listed_shares,active,updated_at) VALUES(?,?,?,?,?,1,?) ON CONFLICT(code) DO UPDATE SET name=excluded.name,market=excluded.market,market_cap=COALESCE(excluded.market_cap,stocks.market_cap),listed_shares=COALESCE(excluded.listed_shares,stocks.listed_shares),active=1,updated_at=excluded.updated_at`).bind(x.code,x.name,x.market||'UNKNOWN',x.marketValue??null,x.listedShares??null,isoNow()));
  await d1Batch(db,stmts); return rows.length;
}
async function saveQuotes(db,rows) {
  const stmts=rows.filter(x=>x.price!=null).map(x=>db.prepare(`INSERT INTO stock_quotes(code,price,previous_close,change_value,change_pct,volume,trade_value,source,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(code) DO UPDATE SET price=excluded.price,previous_close=excluded.previous_close,change_value=excluded.change_value,change_pct=excluded.change_pct,volume=excluded.volume,trade_value=excluded.trade_value,source=excluded.source,updated_at=excluded.updated_at`).bind(x.code,x.price,x.previousClose??null,x.change??null,x.changePct??null,x.volume??0,x.tradeValue??x.value??0,x.source||'UNKNOWN',x.updatedAt||isoNow()));
  await d1Batch(db,stmts); return stmts.length;
}
async function saveCandles(db,code,rows) {
  const stmts=rows.map(x=>db.prepare(`INSERT INTO stock_daily_candles(code,date,open,high,low,close,volume,trade_value,source,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(code,date) DO UPDATE SET open=excluded.open,high=excluded.high,low=excluded.low,close=excluded.close,volume=excluded.volume,trade_value=excluded.trade_value,source=excluded.source,updated_at=excluded.updated_at`).bind(code,x.date,x.open,x.high,x.low,x.close,x.volume||0,x.tradeValue||0,x.source||'UNKNOWN',isoNow()));
  await d1Batch(db,stmts); return stmts.length;
}
async function saveIndicators(db,code,rows) {
  const stmts=rows.map(x=>db.prepare(`INSERT INTO stock_indicators(code,date,ema5,ema10,ema20,ema60,ema120,rsi14,macd,macd_signal,macd_hist,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(code,date) DO UPDATE SET ema5=excluded.ema5,ema10=excluded.ema10,ema20=excluded.ema20,ema60=excluded.ema60,ema120=excluded.ema120,rsi14=excluded.rsi14,macd=excluded.macd,macd_signal=excluded.macd_signal,macd_hist=excluded.macd_hist,updated_at=excluded.updated_at`).bind(code,x.date,x.ema5,x.ema10,x.ema20,x.ema60,x.ema120,x.rsi14,x.macd,x.macdSignal,x.macdHist,isoNow()));
  await d1Batch(db,stmts); return stmts.length;
}
async function dataStatus(env) {
  const db=env.DB; if(!db)return {dbConfigured:false,kisConfigured:!!(env.KIS_APP_KEY&&env.KIS_APP_SECRET),mode:env.KIS_MODE||'paper'};
  const [s,q,c,i]=await Promise.all(['stocks','stock_quotes','stock_daily_candles','stock_indicators'].map(t=>db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first()));
  return {dbConfigured:true,kisConfigured:!!(env.KIS_APP_KEY&&env.KIS_APP_SECRET),mode:env.KIS_MODE||'paper',counts:{stocks:s?.n||0,quotes:q?.n||0,candles:c?.n||0,indicators:i?.n||0}};
}
async function syncData(env,url) {
  const db=requireDb(env), type=url.searchParams.get('type')||'universe', limit=Math.min(200,Math.max(1,Number(url.searchParams.get('limit')||50))), offset=Math.max(0,Number(url.searchParams.get('offset')||0));
  if(type==='universe'){
    const market=(url.searchParams.get('market')||'ALL').toUpperCase(); const u=await fetchUniverse(market); const saved=await saveUniverse(db,u.rows);
    return {ok:true,type,market,found:u.rows.length,saved,errors:(u.errors||[]).slice(0,10),source:'NAVER-MARKET-MASTER',at:isoNow()};
  }
  const selected=await db.prepare(`SELECT code,name,market FROM stocks WHERE active=1 ORDER BY code LIMIT ? OFFSET ?`).bind(limit,offset).all();
  const stocks=selected.results||[]; if(!stocks.length)return {ok:true,type,offset,processed:0,message:'대상 종목이 없습니다.'};
  if(type==='quotes'){
    const provider=(url.searchParams.get('provider')||'auto').toLowerCase(), out=[],errors=[];
    for(const s of stocks){try{let q;if(provider==='naver'||(!env.KIS_APP_KEY&&!env.KIS_APP_SECRET)){const n=await fetchNaver([s.code]);q=n[s.code];if(!q)throw new Error('Naver 시세 없음');}else{q=await kisQuote(env,s.code);await sleep(String(env.KIS_MODE||'paper').toLowerCase()==='live'?100:550);}out.push({...q,name:q.name||s.name,market:s.market});}catch(e){errors.push({code:s.code,error:e.message});}}
    const saved=await saveQuotes(db,out); return {ok:true,type,provider:env.KIS_APP_KEY?'KIS':'NAVER-FALLBACK',offset,processed:stocks.length,saved,failed:errors.length,errors:errors.slice(0,20),at:isoNow()};
  }
  if(type==='candles'){
    const days=Math.min(2500,Math.max(120,Number(url.searchParams.get('days')||700))),provider=(url.searchParams.get('provider')||'auto').toLowerCase(),errors=[];let saved=0;
    for(const s of stocks){try{let rows;if(provider==='naver'||(!env.KIS_APP_KEY&&!env.KIS_APP_SECRET)){rows=await fetchHistory(s.code,days);rows=rows.map(x=>({...x,date:String(x.t||'').replace(/-/g,'')})).filter(x=>/^\d{8}$/.test(x.date)).map(x=>({...x,source:'NAVER'}));}else{rows=await kisCandles(env,s.code,days);await sleep(String(env.KIS_MODE||'paper').toLowerCase()==='live'?100:550);}saved+=await saveCandles(db,s.code,rows);}catch(e){errors.push({code:s.code,error:e.message});}}
    return {ok:true,type,provider:env.KIS_APP_KEY?'KIS':'NAVER-FALLBACK',offset,processed:stocks.length,candlesSaved:saved,failed:errors.length,errors:errors.slice(0,20),at:isoNow()};
  }
  if(type==='indicators'){
    let processed=0,saved=0,errors=[];
    for(const s of stocks){try{const r=await db.prepare('SELECT date,open,high,low,close,volume FROM stock_daily_candles WHERE code=? ORDER BY date').bind(s.code).all();const candles=r.results||[];if(candles.length<30){errors.push({code:s.code,error:'일봉 30개 미만'});continue;}const rows=calculateIndicatorRows(s.code,candles);saved+=await saveIndicators(db,s.code,rows);processed++;}catch(e){errors.push({code:s.code,error:e.message});}}
    return {ok:true,type,offset,processed,indicatorRowsSaved:saved,failed:errors.length,errors:errors.slice(0,20),at:isoNow()};
  }
  throw new Error('지원하지 않는 sync type입니다. universe, quotes, candles, indicators 중 하나를 사용하세요.');
}
async function dataRead(env,url,path) {
  const db=requireDb(env),code=code6(url.searchParams.get('code')||''); if(!/^\d{6}$/.test(code))throw new Error('유효한 code 파라미터가 필요합니다.');
  if(path==='/api/data/candles'){const limit=Math.min(2500,Math.max(1,Number(url.searchParams.get('limit')||700)));const r=await db.prepare('SELECT * FROM stock_daily_candles WHERE code=? ORDER BY date DESC LIMIT ?').bind(code,limit).all();return {ok:true,code,rows:(r.results||[]).reverse()};}
  if(path==='/api/data/indicators'){const limit=Math.min(2500,Math.max(1,Number(url.searchParams.get('limit')||700)));const r=await db.prepare('SELECT * FROM stock_indicators WHERE code=? ORDER BY date DESC LIMIT ?').bind(code,limit).all();return {ok:true,code,rows:(r.results||[]).reverse()};}
  if(path==='/api/data/quote'){const r=await db.prepare('SELECT s.code,s.name,s.market,q.* FROM stocks s LEFT JOIN stock_quotes q ON q.code=s.code WHERE s.code=?').bind(code).first();return {ok:true,quote:r||null};}
  throw new Error('Not Found');
}
// -----------------------------------------------------------------------------
