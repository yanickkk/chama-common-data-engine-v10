/**
 * 차마 족보 - 국내시장 자동 스크리너 Worker
 *
 * /api/market?codes=...
 * /api/analysis?codes=...
 * /api/screener?market=ALL&top=10
 *
 * 자동발굴 흐름:
 * 전체 KOSPI/KOSDAQ 유니버스 -> 실시간 1차 필터 -> 일봉 기술분석 ->
 * 차마존/CM 조건 -> 점수화 -> S급/A급 압축 -> TOP N
 *
 * 주의: 차마존/CM 조건은 사용자가 제공한 조건을 기준으로 구현합니다.
 * Naver 공개 데이터 API는 비공식/비문서화 경로이므로 장애 시 대체 경로를 사용합니다.
 */
const ALLOWED_ORIGINS = new Set(['http://localhost:8000','http://127.0.0.1:8000']);
const N = 'Mozilla/5.0 (compatible; ChamaJokbo/2.0)';

function corsHeaders(request){
  const origin=request.headers.get('Origin');
  let host=''; try{host=origin?new URL(origin).hostname:'';}catch(e){}
  const extra=(globalThis.__CHAMA_ALLOWED_ORIGINS||'').split(',').map(x=>x.trim()).filter(Boolean);
  const allowed=origin && (ALLOWED_ORIGINS.has(origin) || extra.includes(origin) || host.endsWith('.github.io') || host.endsWith('.vercel.app')) ? origin : 'null';
  return {'Access-Control-Allow-Origin':allowed,'Access-Control-Allow-Methods':'GET, POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type, Authorization','Access-Control-Max-Age':'86400','Vary':'Origin','Cache-Control':'no-store','Content-Type':'application/json; charset=UTF-8'};
}
function json(data,request,status=200){return new Response(JSON.stringify(data),{status,headers:corsHeaders(request)});}
function num(v){const n=Number(String(v??'').replace(/,/g,''));return Number.isFinite(n)?n:null;}
function normalizeStockCode(v){return String(v??'').trim().toUpperCase();}
function isValidStockCode(v){const c=normalizeStockCode(v);return /^[0-9A-Z]{6}$/.test(c)&&c!=='000000';}
function isKisStockCode(v){return /^\d{6}$/.test(normalizeStockCode(v))&&normalizeStockCode(v)!=='000000';}
function chunks(a,n){const o=[];for(let i=0;i<a.length;i+=n)o.push(a.slice(i,i+n));return o;}
function normalizeNxt(x){if(!x||typeof x!=='object')return null;const price=num(x.overPrice??x.nxtOverPrice??x.nv??x.price??x.currentPrice);const change=num(x.overChange??x.nxtOverChange??x.cv??x.change);const changePct=num(x.overChangeRate??x.nxtOverChangeRate??x.cr??x.changeRate);return price==null&&change==null&&changePct==null?null:{price,change,changePct,raw:x};}

async function fetchNaver(codes){
  const map={};
  const applyItem=(item,source)=>{
    const code=normalizeStockCode(item?.cd??item?.itemCode??item?.itemcode??item?.code??item?.symbolCode??item?.isuCd); if(!code||!codes.includes(code))return;
    const price=num(item.nv??item.closePrice??item.nowPrice??item.currentPrice);
    const prev=num(item.pc??item.previousClose??item.lastClosePrice??item.sv);
    const ch=num(item.cv??item.changeValue??item.compareToPreviousClosePrice);
    const pct=num(item.cr??item.changeRate??item.fluctuationsRatio);
    const vol=num(item.aq??item.accumulatedTradingVolume??item.volume)||0;
    const value=num(item.aa??item.accumulatedTradingValue??item.tradingValue??item.tradeValue);
    const name=item.nm??item.name??item.stockName??item.itemName??'';
    if(price==null && pct==null && value==null)return;
    map[code]={...(map[code]||{}),code,name,price,previousClose:prev,change:ch??(price!=null&&prev!=null?price-prev:null),changePct:pct??(price!=null&&prev?((price-prev)/prev)*100:0),volume:vol,value:value??(price!=null?price*vol:null),source,updatedAt:new Date().toISOString()};
  };
  async function requestJson(url,headers={}){const r=await fetch(url,{headers:{'User-Agent':N,'Accept':'application/json,*/*','Referer':'https://m.stock.naver.com/',...headers}});if(!r.ok)throw new Error(`HTTP ${r.status}`);return r.json();}

  // 1) Naver polling endpoints. Both hosts are tried because Cloudflare may treat them differently.
  for(const host of ['https://polling.finance.naver.com','https://m.stock.naver.com','https://stock.naver.com']){
    const missing=codes.filter(c=>!map[c]); if(!missing.length)break;
    for(const batch of chunks(missing,50)){
      try{
        const url=host.includes('polling.finance')
          ? `${host}/api/realtime?query=${encodeURIComponent(batch.map(c=>`SERVICE_ITEM:${c}`).join('|'))}`
          : `${host}/api/polling/domestic/stock?itemCodes=${encodeURIComponent(batch.join(','))}`;
        const d=await requestJson(url);
        const found=[];
        (function walk(x,depth=0){
          if(depth>8||x==null)return;
          if(Array.isArray(x)){for(const v of x)walk(v,depth+1);return;}
          if(typeof x!=='object')return;
          const c=normalizeStockCode(x.cd??x.itemCode??x.itemcode??x.code??x.symbolCode??x.isuCd);
          if(c&&batch.includes(c))found.push(x);
          for(const v of Object.values(x))if(v&&typeof v==='object')walk(v,depth+1);
        })(d);
        for(const item of found)applyItem(item,host.includes('polling.finance')?'NAVER-POLLING':'NAVER-POLLING-FALLBACK');
      }catch(e){}
    }
  }

  // 2) Reliable per-stock mobile API fallback. Basic supplies live price/change; integration supplies volume/trading value.
  const missing=codes.filter(c=>!map[c]);
  for(const batch of chunks(missing,10)){
    await Promise.all(batch.map(async code=>{
      try{
        const [basic,integration]=await Promise.all([
          requestJson(`https://m.stock.naver.com/api/stock/${code}/basic`),
          requestJson(`https://m.stock.naver.com/api/stock/${code}/integration`).catch(()=>null)
        ]);
        const merged={...(basic||{}),...(integration||{})};
        let value=null,vol=null;
        const infos=Array.isArray(integration?.totalInfos)?integration.totalInfos:[];
        for(const x of infos){
          const label=String(x?.key??x?.name??x?.title??'');
          if(value==null&&(x?.accumulatedTradingValue!=null||/거래대금/.test(label)))value=num(x.accumulatedTradingValue??x.value??x.data);
          if(vol==null&&(x?.accumulatedTradingVolume!=null||/거래량/.test(label)))vol=num(x.accumulatedTradingVolume??x.value??x.data);
        }
        merged.accumulatedTradingValue=value??merged.accumulatedTradingValue;
        merged.accumulatedTradingVolume=vol??merged.accumulatedTradingVolume;
        applyItem(merged,'NAVER-MOBILE-BASIC');
      }catch(e){}
    }));
  }
  return map;
}
function sma(a,n){return a.length<n?null:a.slice(-n).reduce((x,y)=>x+y,0)/n;}
function ema(a,n){if(!a.length)return[];const k=2/(n+1);let e=a[0],o=[e];for(let i=1;i<a.length;i++){e=a[i]*k+e*(1-k);o.push(e)}return o;}
function rsi(a,n=14){if(a.length<=n)return 50;let g=0,l=0;for(let i=a.length-n;i<a.length;i++){const d=a[i]-a[i-1];if(d>=0)g+=d;else l-=d;}if(l===0)return 100;const rs=(g/n)/(l/n);return 100-100/(1+rs);}
function midpoint(a,b){return (a+b)/2;}
function roundFigureDistance(price, levels){ if(!price||!levels?.length)return null; let best=Infinity; for(const lv of levels){best=Math.min(best,Math.abs(price/lv-1)*100);} return best; }
function recentPeak(rows,n,field='high'){return Math.max(...rows.slice(-n).map(x=>Number(x[field]??x.close)||0));}
function previousClose(rows,i){return i>0?rows[i-1].close:null;}
function isExcludedName(name){return /(ETF|ETN|스팩|SPAC)/i.test(String(name||''));}

function buildChama(rows, q, cfg={}){
  const c=rows.map(x=>x.close), close=Number(q.price??c.at(-1));
  if(!close||rows.length<130)return {chama:false,count:0,flags:{}};
  const e5=emaSeries(c,5).at(-1),e10=emaSeries(c,10).at(-1),e20=emaSeries(c,20).at(-1),e60=emaSeries(c,60).at(-1),e120=emaSeries(c,120).at(-1);
  const maCfg=cfg.maProximityPct??3;
  const maLines=[['세력선1(5)',e5],['세력선2(10)',e10],['황금선(20)',e20],['수급선(60)',e60],['대세선(120)',e120]];
  const maHit=maLines.some(([,v])=>v&&Math.abs(close/v-1)*100<=maCfg);
  const 기준선=midpoint(recentPeak(rows,26,'high'),Math.min(...rows.slice(-26).map(x=>x.low||x.close)));
  const baseHit=Math.abs(close/기준선-1)*100<=(cfg.baseLineProximityPct??3);
  const rfLevels=(cfg.roundLevels||[1000,5000,10000,50000,100000,500000]).map(Number).filter(Boolean);
  const rfHit=(roundFigureDistance(close,rfLevels)??999)<=(cfg.roundFigureProximityPct??2);
  let masterOrLimit=[];
  const look20=Math.min(cfg.referenceLookbackDays??20,rows.length-1);
  for(let i=Math.max(1,rows.length-look20);i<rows.length;i++){
    const r=rows[i], prev=rows[i-1]; const prevC=prev.close||0;
    const dailyHighPct=prevC?(r.high/prevC-1)*100:0;
    const dailyClosePct=prevC?(r.close/prevC-1)*100:0;
    const limit=dailyHighPct >= (cfg.limitUpPct??29.5) || dailyClosePct >= (cfg.limitUpPct??29.5);
    const prior400=rows.slice(Math.max(0,i-(cfg.masterHighLookback??400)),i).map(x=>x.high||0);
    const prior250Close=rows.slice(Math.max(0,i-(cfg.masterCloseLookback??250)),i).map(x=>x.close||0);
    const master=prior400.length>0 && r.high>Math.max(...prior400) && prior250Close.length>0 && r.close>Math.max(...prior250Close) && dailyClosePct>=(cfg.masterRisePct??10) && ((r.close*(r.volume||0))>=(cfg.masterTradeValueKRW??100000000000));
    if(limit||master) masterOrLimit.push({i,center:midpoint(r.high,r.low),type:master?'master':'limit'});
  }
  const ref=masterOrLimit.at(-1);
  const refHit=!!ref && Math.abs(close/ref.center-1)*100 <= (cfg.referenceProximityPct??3);
  let 저지바Hit=false;
  if(ref){ const lo=Math.max(0,ref.i-(cfg.resistanceLookbackDays??60)); const prior=rows.slice(lo,ref.i).map(x=>x.high||0); const resistance=prior.length?Math.max(...prior):null; 저지바Hit=!!resistance && Math.abs(close/resistance-1)*100 <= (cfg.resistanceProximityPct??3); }
  const envPct=cfg.safetyBeltPct??10;
  const env20=e20*(1-envPct/100);
  const prevEnv=rows.length>1 ? emaSeries(c.slice(0,-1),20).at(-1)*(1-envPct/100):null;
  const safetyFirst=close<=env20*(1+(cfg.firstEntryTolerancePct??0)/100) && (prevEnv==null || rows.at(-2).close>prevEnv);
  const sdN=cfg.bollingerPeriod??20; const mean=sma(c,sdN); const slice=c.slice(-sdN); const sd=Math.sqrt(slice.reduce((s,x)=>s+(x-mean)**2,0)/sdN); const lower=mean-(cfg.bollingerSigma??2)*sd;
  const pSlice=c.slice(-(sdN+1),-1); const pm=sma(pSlice,sdN); const ps=pSlice.length===sdN?Math.sqrt(pSlice.reduce((s,x)=>s+(x-pm)**2,0)/sdN):null; const prevLower=pm!=null&&ps!=null?pm-(cfg.bollingerSigma??2)*ps:null;
  const bollFirst=close<=lower && (prevLower==null || rows.at(-2).close>prevLower*(1+(cfg.bollingerPrevAbovePct??3)/100));
  // 스마트머니: 일봉을 주봉으로 묶어 78주 신고가와 신고 거래대금을 동시에 돌파. 최근 N 거래일 내 주봉만 인정.
  const weekly=[]; let wk=null;
  for(const r of rows){const d=new Date(String(r.t).replace(/-/g,'/')); if(Number.isNaN(d.getTime()))continue; const key=`${d.getFullYear()}-${String(Math.floor((d.getMonth()+1 + 10 - (d.getDay()||7))/7)).padStart(2,'0')}`; if(!wk||wk.key!==key){if(wk)weekly.push(wk);wk={key,t:r.t,high:r.high,low:r.low,close:r.close,volume:r.volume||0};}else{wk.high=Math.max(wk.high,r.high);wk.low=Math.min(wk.low,r.low);wk.close=r.close;wk.volume+=(r.volume||0);}} if(wk)weekly.push(wk);
  let smart=false; const smartDays=cfg.smartMoneyRecentDays??20;
  for(let i=1;i<weekly.length;i++){const prior=weekly.slice(Math.max(0,i-(cfg.smartMoneyWeeks??78)),i);if(!prior.length)continue;const priceBreak=weekly[i].high>Math.max(...prior.map(x=>x.high));const volBreak=weekly[i].volume>Math.max(...prior.map(x=>x.volume));const lastDate=new Date(String(weekly[i].t).replace(/-/g,'/'));const now=new Date(String(rows.at(-1).t).replace(/-/g,'/'));const age=Math.round((now-lastDate)/86400000);if(priceBreak&&volBreak&&age<=smartDays)smart=true;}
  const flags={maProximity:maHit,baseLine:baseHit,roundFigure:rfHit,referenceCandle:refHit,resistanceSupport:저지바Hit,safetyBeltFirst:safetyFirst,bollingerLowerFirst:bollFirst,smartMoney:smart};
  const bonus=smart?1:0; const count=Object.values(flags).filter(Boolean).length; const coreCount=[baseHit,rfHit,refHit,저지바Hit,safetyFirst,bollFirst].filter(Boolean).length;
  return {chama:maHit&&coreCount>=2,count,coreCount,flags,ema:{e5,e10,e20,e60,e120},reference:ref?.type||null};
}

function analyze(q,h,cfg={}){
  const rows=h.filter(x=>Number.isFinite(x.close)); const c=rows.map(x=>x.close), v=rows.map(x=>x.volume||0); const close=num(q.price)??c.at(-1); if(!close||c.length<30)return null;
  const ma5=sma(c,5),ma20=sma(c,20),ma60=sma(c,60),avg20=sma(v,20),r=rsi(c),e12=ema(c,12),e26=ema(c,26),m=e12.at(-1)-e26.at(-1),sig=ema(e12.map((x,i)=>x-(e26[i]??x)),9).at(-1)||0,hist=m-sig;
  const high20=Math.max(...rows.slice(-20).map(x=>x.high||x.close)); const vr=avg20?(q.volume||v.at(-1)||0)/avg20:0;
  const chama=buildChama(rows,q,cfg.chama||{});
  const score=Math.round((chama.chama?70:0)+(chama.coreCount*5)+(hist>0?5:0)+(vr>=1.2?5:0));
  const grade=chama.chama?'S급':(chama.coreCount>=2?'A급':'관망');
  return {score,grade,chama:chama.chama,cm:false,chamaCount:chama.count,chamaCoreCount:chama.coreCount,cmCount:0,rsi:r,ma5,ma20,ma60,volRatio:vr,macdHist:hist,breakout:close>=high20*(1-(cfg.breakoutTolerancePct??2)/100),chamaDetail:chama,indicators:[{label:'세력선1',val:chama.ema.e5?((close/chama.ema.e5-1)*100):0},{label:'세력선2',val:chama.ema.e10?((close/chama.ema.e10-1)*100):0},{label:'황금선',val:chama.ema.e20?((close/chama.ema.e20-1)*100):0},{label:'수급선',val:chama.ema.e60?((close/chama.ema.e60-1)*100):0},{label:'대세선',val:chama.ema.e120?((close/chama.ema.e120-1)*100):0}]};
}

function defaultScreenConfig(){return {market:'ALL',top:10,liquidityTop:100,cmTradeValueKRW:100000000000,cmTop100:100,cmDay0HighRisePct:17,cmTargetRisePct:50,cmWindowDays:5,cmAchievementCandlePct:10,cmBreakoutLookback:20,calendarDays:120,chama:{maProximityPct:3,baseLineProximityPct:3,roundFigureProximityPct:2,roundLevels:[1000,5000,10000,50000,100000,500000],referenceLookbackDays:20,limitUpPct:29.5,masterHighLookback:400,masterCloseLookback:250,masterRisePct:10,masterTradeValueKRW:100000000000,resistanceLookbackDays:60,referenceProximityPct:3,resistanceProximityPct:3,safetyBeltPct:10,bollingerPeriod:20,bollingerSigma:2,bollingerPrevAbovePct:3,smartMoneyWeeks:78,smartMoneyRecentDays:20}};}
function mergeConfig(raw){const d=defaultScreenConfig();const r=raw||{};return {...d,...r,chama:{...d.chama,...(r.chama||{})}};}
function cmMatches(rows,cfg){
  const out=[]; const topN=cfg.cmTop100??100; const minValue=cfg.cmTradeValueKRW??100000000000; const day0High=cfg.cmDay0HighRisePct??17; const target=cfg.cmTargetRisePct??50; const window=cfg.cmWindowDays??5; const candle=cfg.cmAchievementCandlePct??10; const breakoutN=cfg.cmBreakoutLookback??20;
  for(let i=1;i<rows.length-window;i++){
    const r0=rows[i], prev=rows[i-1]; const highRise=prev.close?(r0.high/prev.close-1)*100:0; if(highRise<day0High)continue;
    let cum=null, hitIndex=null; for(let j=i;j<=Math.min(rows.length-1,i+window);j++){const rr=rows[j]; const gain=r0.close?(rr.close/r0.close-1)*100:0;if(gain>=target){hitIndex=j;cum=gain;break;}}
    if(hitIndex==null)continue; const rr=rows[hitIndex]; const p=rows[hitIndex-1]?.close||0; const candlePct=p?(rr.close/p-1)*100:0; const priorHighs=rows.slice(Math.max(0,hitIndex-breakoutN),hitIndex).map(x=>x.high||0); const breakout=priorHighs.length?rr.high>Math.max(...priorHighs):false; if(candlePct<candle||!breakout)continue;
    out.push({selectedDate:rr.t,day0Date:r0.t,day0HighRisePct:highRise,achievementRisePct:cum,achievementCandlePct:candlePct,achievementClose:rr.close,achievementHigh:rr.high,breakout,day0Index:i,achievementIndex:hitIndex});
  }
  return out;
}
async function fetchHistory(code,days=700){
  return fetchHistoryPaged(code,days);
}

// 네이버 일봉 차트 API는 한 번의 요청에서 약 110거래일 수준만 반환할 수 있습니다.
// 120일(달력일) 단위로 과거 방향으로 구간을 나눠 호출해 응답 건수 제한을 우회합니다.
// 각 구간은 날짜 경계를 하루씩 이동해 중복/누락을 최소화하고, 최종 결과는 날짜 기준으로 병합합니다.

// v10.7 기반 v10.8: D1 중복 쓰기 최소화 + 네이버 Finance 레거시 siseJson API. 응답은 JS 배열 문자열일 수 있어 별도 파싱합니다.
function parseNaverSiseJson(text){
  const rows=[];
  const re=/\[\s*['"]?(\d{8})['"]?\s*,\s*['"]?([-\d.,]+)['"]?\s*,\s*['"]?([-\d.,]+)['"]?\s*,\s*['"]?([-\d.,]+)['"]?\s*,\s*['"]?([-\d.,]+)['"]?\s*,\s*['"]?([-\d.,]+)['"]?/g;
  let m;
  const toValue=v=>Number(String(v).replace(/,/g,''));
  while((m=re.exec(String(text||'')))!==null){
    const date=m[1],open=toValue(m[2]),high=toValue(m[3]),low=toValue(m[4]),close=toValue(m[5]),volume=toValue(m[6]);
    if(!/^\d{8}$/.test(date)||![open,high,low,close,volume].every(Number.isFinite))continue;
    if(close<=0||high<=0||low<=0||open<0||volume<0)continue;
    rows.push({t:date,open,high,low,close,volume});
  }
  return rows;
}
async function fetchHistoryLegacy(code,days=700){
  if(!isValidStockCode(code))throw new Error('유효하지 않은 종목코드입니다.');
  const safeDays=Math.min(2500,Math.max(120,Number(days)||700));
  const end=new Date();end.setUTCHours(0,0,0,0);
  const start=new Date(end.getTime()-safeDays*86400000);
  const fmt=d=>`${d.getUTCFullYear()}${String(d.getUTCMonth()+1).padStart(2,'0')}${String(d.getUTCDate()).padStart(2,'0')}`;
  const all=new Map(),pages=[];
  let cursor=new Date(end),pageCount=0;
  while(cursor>=start&&pageCount<20){
    const windowStart=new Date(Math.max(start.getTime(),cursor.getTime()-179*86400000));
    const startTime=fmt(windowStart),endTime=fmt(cursor);
    const api=new URL('https://api.finance.naver.com/siseJson.naver');
    api.searchParams.set('symbol',normalizeStockCode(code));api.searchParams.set('requestType','1');
    api.searchParams.set('startTime',startTime);api.searchParams.set('endTime',endTime);api.searchParams.set('timeframe','day');
    let body=null,lastError=null,status=null;
    for(let attempt=0;attempt<3;attempt++){
      try{
        const response=await fetch(api.toString(),{headers:{'User-Agent':N,'Accept':'*/*','Referer':'https://finance.naver.com/'}});
        status=response.status;if(!response.ok)throw new Error(`HTTP ${response.status}`);
        body=await response.text();if(!body||body.trim().length<5)throw new Error('빈 응답');
        lastError=null;break;
      }catch(e){lastError=e;if(attempt<2)await sleep(300*(attempt+1));}
    }
    if(body===null)throw new Error(`네이버 siseJson 조회 실패(${startTime}~${endTime}): ${lastError?.message||'unknown error'}`);
    const parsed=parseNaverSiseJson(body);let accepted=0;
    for(const row of parsed){if(row.t<startTime||row.t>endTime)continue;all.set(row.t,row);accepted++;}
    const dates=parsed.map(x=>x.t).sort();
    pages.push({startDate:startTime,endDate:endTime,httpStatus:status,responseChars:body.length,parsedRows:parsed.length,acceptedRows:accepted,firstDate:dates[0]||null,lastDate:dates[dates.length-1]||null,responsePreview:parsed.length?undefined:body.slice(0,180)});
    pageCount++;cursor=new Date(windowStart.getTime()-86400000);
    if(cursor>=start)await sleep(250);
  }
  const rows=[...all.values()].sort((a,b)=>a.t.localeCompare(b.t));
  const diagnostics={api:'siseJson.naver',requestedDays:safeDays,pageCount,pages,uniqueRows:rows.length,oldestDate:rows[0]?.t||null,newestDate:rows[rows.length-1]?.t||null};
  if(!rows.length)throw new Error(`네이버 siseJson에서 유효한 일봉을 찾지 못했습니다. ${JSON.stringify(diagnostics)}`);
  return {rows,diagnostics};
}

async function fetchHistoryPaged(code,days=700){
  const result=await fetchHistoryLegacy(code,days);
  return result.rows;
}

async function fetchUniverse(market){
  const requestedMarket=String(market||'ALL').toUpperCase();
  if(!['ALL','KOSPI','KOSDAQ'].includes(requestedMarket)){
    throw new Error('market은 ALL, KOSPI 또는 KOSDAQ만 지정할 수 있습니다.');
  }
  const pageSize=100;
  const maxPages=100;
  const headers={'User-Agent':N,'Accept':'application/json,*/*','Referer':'https://stock.naver.com/'};
  const byCode=new Map();
  const errors=[];
  let totalCount=null,sourceItemCount=0,pages=0,complete=false;

  for(let index=0;index<maxPages;index++){
    const url=new URL('https://stock.naver.com/api/stockSecurity/individual-stocks/v3/domestic');
    url.searchParams.set('listingType','tradingValueDesc');
    url.searchParams.set('exchangeType','consolidated');
    url.searchParams.set('index',String(index));
    url.searchParams.set('size',String(pageSize));

    let payload=null,lastError=null;
    for(let attempt=0;attempt<3;attempt++){
      try{
        const response=await fetch(url.toString(),{headers});
        const body=await response.text();
        if(!response.ok)throw new Error(`HTTP ${response.status}: ${body.slice(0,160)}`);
        payload=JSON.parse(body);
        lastError=null;
        break;
      }catch(e){
        lastError=e;
        if(attempt<2)await sleep(300*(attempt+1));
      }
    }
    if(!payload){
      errors.push(`Naver individual-stocks page ${index}: ${lastError?.message||'unknown error'}`);
      break;
    }
    if(!Array.isArray(payload.items)){
      errors.push(`Naver individual-stocks page ${index}: items 배열이 없습니다.`);
      break;
    }

    pages++;
    sourceItemCount+=payload.items.length;
    if(payload.totalCount!=null&&Number.isFinite(Number(payload.totalCount))){
      totalCount=Number(payload.totalCount);
    }
    for(const item of payload.items){
      const code=normalizeStockCode(item?.itemCode);
      const name=String(item?.itemName||'').trim();
      const itemMarket=String(item?.marketType||item?.exchangeType||'').toUpperCase();
      if(!isValidStockCode(code)||!name||name.length>100||!['KOSPI','KOSDAQ'].includes(itemMarket))continue;
      const krx=item?.krx||{};
      const securityType=classifySecurityType(item,krx,name,'NAVER-INDIVIDUAL-STOCKS-V3');
      byCode.set(code,{
        code,name,market:itemMarket,securityType,securityVerified:securityType==='COMMON'||securityType==='PREFERRED',securitySource:'NAVER-INDIVIDUAL-STOCKS-V3',
        tradableStatus:String(krx.tradableStatus??item.tradableStatus??'').trim().toLowerCase(),
        tradableStatusCode:String(krx.tradableStatusCode??item.tradableStatusCode??'').trim(),
        marketValue:num(item?.marketValue??item?.marketCap),
        listedShares:num(item?.listedShares??item?.listedShareCount),
        price:num(item?.currentPrice??item?.closePrice??item?.nowPrice),
        changePct:num(item?.fluctuationsRatio??item?.changeRate),
        volume:num(item?.accumulatedTradingVolume??item?.volume)||0,
        value:num(item?.accumulatedTradingValue??item?.tradingValue??item?.tradeValue)
      });
    }

    if(payload.hasNext===false){complete=true;break;}
    if(totalCount!=null&&sourceItemCount>=totalCount){complete=true;break;}
    if(payload.hasNext===true)continue;
    if(payload.items.length<pageSize){complete=true;break;}
  }

  if(!complete&&totalCount!=null&&sourceItemCount>=totalCount)complete=true;
  const allRows=[...byCode.values()];
  const rows=requestedMarket==='ALL'?allRows:allRows.filter(x=>x.market===requestedMarket);
  if(!pages)throw new Error(errors[0]||'네이버 신규 상장종목 목록을 가져오지 못했습니다.');
  return {
    rows,errors,complete,
    source:'NAVER-INDIVIDUAL-STOCKS-V3',
    pages,sourceItemCount,totalCount,
    sourceUniqueCount:allRows.length,
    market:requestedMarket,
    coverage:complete?'COMPLETE':'INCOMPLETE',
    warning:complete?null:'네이버 신규 상장종목 목록의 모든 페이지를 확인하지 못했습니다. 이 결과로 유니버스 저장 또는 전체시장 스캔을 진행하면 안 됩니다.'
  };
}
async function screenMarket(market,top,rawCfg){
  const cfg=mergeConfig({...rawCfg,market,top});
  const universeResult=await fetchUniverse(market);
  if(!universeResult.complete)throw new Error(`종목 유니버스 수집이 불완전합니다. pages=${universeResult.pages}, received=${universeResult.sourceItemCount}, expected=${universeResult.totalCount??'unknown'}; ${(universeResult.errors||[]).join(' | ')}`);
  const universe=universeResult.rows.filter(isEligibleCommonStock);
  if(!universe.length){ throw new Error('종목 유니버스를 가져오지 못했습니다. '+(universeResult.errors||[]).slice(0,3).join(' | ')); }

  // 유니버스 자체에 현재가/등락률/거래대금이 들어 있으면 그것을 1차 시장 스냅샷으로 사용합니다.
  // 실시간 polling은 보강용이며, polling이 실패해도 시장 스냅샷을 버리지 않습니다.
  let marketSnapshot=universe.filter(x=>x.price!=null);
  const snapshotBefore=marketSnapshot.length;

  // 가격이 없는 종목만 실시간 보강 대상으로 잡습니다. 가격이 있는 종목까지 버리지 않습니다.
  const needQuoteCodes=universe.filter(x=>x.price==null).slice(0,cfg.liquidityTop??100).map(x=>x.code);
  const quotes=await fetchNaver(needQuoteCodes);

  const merged=universe.map(u=>{
    const q=quotes[u.code]||{};
    const price=q.price??u.price;
    const changePct=q.changePct??u.changePct;
    const volume=q.volume??u.volume??0;
    const value=q.value??u.value??((price!=null)?price*volume:0);
    return {...u,...q,price,changePct,volume,value,quoteSource:q.source||'UNIVERSE-SNAPSHOT'};
  }).filter(x=>x.price!=null || x.value>0);

  // 당일 상승률 Top100의 모수가 전체 시장이어야 하므로, 거래대금 조건을 먼저 적용한 뒤 상승률 순으로 정렬합니다.
  // 거래대금이 없는 행은 CM 모수에서 제외합니다.
  const cmPool=merged
    .filter(x=>Number(x.value||0)>=Number(cfg.cmTradeValueKRW||0))
    .sort((a,b)=>Number(b.changePct||0)-Number(a.changePct||0))
    .slice(0,Number(cfg.cmTop100||100));

  const cmEvents=[]; const chamaCandidates=[]; const cmCandidates=[];
  for(const q of cmPool){
    try{
      const h=await fetchHistory(q.code,700);
      const cm=cmMatches(h,cfg);
      cm.forEach(e=>cmEvents.push({...q,...e}));
    }catch(e){}
  }

  // 차마존은 당일 데이터가 있는 종목 중 거래대금 상위권부터 장기 일봉을 조회합니다.
  const chamaTargets=merged
    .filter(x=>x.price!=null)
    .sort((a,b)=>Number(b.value||0)-Number(a.value||0))
    .slice(0,Math.min(Number(cfg.liquidityTop||100),200));

  for(const q of chamaTargets){
    try{
      const h=await fetchHistory(q.code,700);
      const a=analyze(q,h,cfg);
      if(a?.chama)chamaCandidates.push({...q,...a});
    }catch(e){}
  }

  const latestByCode={};
  for(const e of cmEvents){const old=latestByCode[e.code];if(!old||String(e.selectedDate)>String(old.selectedDate))latestByCode[e.code]=e;}
  Object.values(latestByCode).forEach(e=>cmCandidates.push(e));
  chamaCandidates.sort((a,b)=>b.score-a.score);
  cmCandidates.sort((a,b)=>String(b.selectedDate).localeCompare(String(a.selectedDate))||((b.changePct||0)-(a.changePct||0)));

  const today=new Date();today.setHours(0,0,0,0);
  const since=new Date(today.getTime()-(cfg.calendarDays-1)*86400000);
  const calendar={};
  for(const e of cmEvents){
    const d=new Date(String(e.selectedDate).replace(/-/g,'/'));d.setHours(0,0,0,0);
    if(d>today||d<since)continue;
    (calendar[e.selectedDate]??=[]).push({code:e.code,name:e.name,selectedDate:e.selectedDate,day0Date:e.day0Date,achievementRisePct:e.achievementRisePct,achievementCandlePct:e.achievementCandlePct});
  }

  return {
    universeCount:universe.length,
    universeSourceErrors:universeResult.errors?.slice(0,8)||[],
    quoteCount:Object.keys(quotes).length,
    marketSnapshotCount:snapshotBefore,
    marketDataCount:merged.length,
    cmTop100Count:cmPool.length,
    analysisCount:chamaTargets.length,
    chamaCandidates:chamaCandidates.slice(0,top),
    cmCandidates:cmCandidates.slice(0,top),
    calendar,
    scannedAt:new Date().toISOString(),
    workerVersion:'v9-market-snapshot-cm',
    config:cfg,
    method:'전체시장→ETF/ETN/스팩/SPAC 제외→전체시장 당일 스냅샷+실시간 보강→거래대금 조건→당일 상승률 Top100→0일차→5거래일 50%→달성일 +10% 양봉/20일 전고점 돌파; 차마존=EMA5/10/20/60/120 필수근접+추가조건 2개 이상'
  };
}

async function getQuotes(codes,env){
  const db=requireDb(env),targets=[...new Set(codes.map(normalizeStockCode))];
  if(!targets.length)return [];
  const placeholders=targets.map(()=>'?').join(',');
  const selected=await db.prepare(`SELECT code,name,market,security_type AS securityType,security_verified AS securityVerified FROM stocks WHERE active=1 AND security_verified=1 AND security_type IN ('COMMON','PREFERRED') AND upper(market) IN ('KOSPI','KOSDAQ') AND code IN (${placeholders})`).bind(...targets).all();
  const allowed=new Map((selected.results||[]).map(x=>[normalizeStockCode(x.code),x]));
  const allowedCodes=[...allowed.keys()];
  const n=allowedCodes.length?await fetchNaver(allowedCodes):{};
  return codes.map(raw=>{
    const code=normalizeStockCode(raw),stock=allowed.get(code);
    if(!stock)return {code,eligible:false,source:'EXCLUDED',error:'분류 검증이 완료된 코스피·코스닥 보통주/우선주가 아닙니다.'};
    const quote=n[code];
    return quote?{...quote,name:quote.name||stock.name,market:stock.market,securityType:stock.securityType,eligible:true}:{code,name:stock.name,market:stock.market,securityType:stock.securityType,eligible:true,source:'ERROR'};
  });
}
async function getAnalysis(codes,env){
  const q=await getQuotes(codes,env),out=[];
  for(const x of q){
    if(!x.eligible){out.push({...x,history:[],analysis:null});continue;}
    try{const h=await fetchHistory(x.code);out.push({...x,history:h,analysis:analyze(x,h)});}
    catch(e){out.push({...x,history:[],analysis:null,analysisError:e.message});}
  }
  return out;
}

// ---- Shared market data engine v1 (KIS + Cloudflare D1) ----------------------
let kisTokenCache = { token: null, expiresAt: 0, base: '' };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const isoNow = () => new Date().toISOString();
const ymd = d => `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
function kisBase(env) { return String(env.KIS_MODE || 'paper').toLowerCase() === 'live' ? 'https://openapi.koreainvestment.com:9443' : 'https://openapivts.koreainvestment.com:29443'; }
function requireDb(env) { if (!env.DB) throw new Error('D1 데이터베이스가 연결되지 않았습니다. wrangler.jsonc의 DB binding과 database_id를 설정하세요.'); return env.DB; }
let securitySchemaReady=false;
let securitySchemaPromise=null;
async function ensureSecuritySchema(db){
  if(securitySchemaReady)return;
  if(securitySchemaPromise)return securitySchemaPromise;
  securitySchemaPromise=(async()=>{
    const info=await db.prepare('PRAGMA table_info(stocks)').all();
    const cols=new Set((info.results||[]).map(x=>String(x.name)));
    if(!cols.has('security_type'))await db.prepare("ALTER TABLE stocks ADD COLUMN security_type TEXT NOT NULL DEFAULT 'UNVERIFIED'").run();
    if(!cols.has('security_verified'))await db.prepare('ALTER TABLE stocks ADD COLUMN security_verified INTEGER NOT NULL DEFAULT 0').run();
    if(!cols.has('security_source'))await db.prepare("ALTER TABLE stocks ADD COLUMN security_source TEXT NOT NULL DEFAULT ''").run();
    if(!cols.has('security_reason'))await db.prepare("ALTER TABLE stocks ADD COLUMN security_reason TEXT NOT NULL DEFAULT '기존 데이터 분류 미확인'").run();
    securitySchemaReady=true;
  })().catch(e=>{securitySchemaPromise=null;throw e;});
  return securitySchemaPromise;
}
async function requireEligibleStock(env,code){
  const db=requireDb(env),target=normalizeStockCode(code);
  if(!isValidStockCode(target))throw new Error('유효한 종목코드가 아닙니다.');
  const row=await db.prepare("SELECT code,name,market,security_type AS securityType FROM stocks WHERE code=? AND active=1 AND security_verified=1 AND security_type IN ('COMMON','PREFERRED') AND upper(market) IN ('KOSPI','KOSDAQ')").bind(target).first();
  if(!row)throw new Error('분류 검증이 완료된 코스피·코스닥 보통주/우선주가 아닙니다.');
  return row;
}
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
// KIS는 초당 거래건수 제한(EGW00201)이 있으므로 같은 Worker isolate 안의
// 모든 시세/차트 요청을 직렬화하고, 최소 간격 및 지수형 재시도를 적용합니다.
let kisRequestQueue = Promise.resolve();
let kisLastRequestAt = 0;
const KIS_MIN_INTERVAL_MS = 1300;
async function kisGet(env, path, params, trId) {
  const task = kisRequestQueue.then(async () => {
    const token = await kisToken(env);
    const url = `${kisBase(env)}${path}?${new URLSearchParams(params)}`;
    const headers = {'authorization':`Bearer ${token}`,'appkey':env.KIS_APP_KEY,'appsecret':env.KIS_APP_SECRET,'tr_id':trId,'custtype':'P','accept':'application/json'};
    let lastError = null;
    for (let attempt=0; attempt<4; attempt++) {
      const wait = Math.max(0, KIS_MIN_INTERVAL_MS - (Date.now()-kisLastRequestAt));
      if (wait) await sleep(wait);
      let r, d;
      try {
        r = await fetch(url,{headers});
        d = await r.json().catch(()=>({}));
      } catch (e) {
        kisLastRequestAt = Date.now();
        lastError = new Error(`KIS ${trId} 네트워크 요청 실패: ${e.message}`);
        if (attempt<3) { await sleep(1000*(attempt+1)); continue; }
        throw lastError;
      }
      kisLastRequestAt = Date.now();
      const throttled = d.msg_cd==='EGW00201' || String(d.msg1||'').includes('초당 거래건수');
      if (throttled) {
        const e=new Error(`KIS 호출 제한(EGW00201) 발생. 재호출 전 최소 61초 대기 후 다시 시도하세요. TR=${trId}`);
        e.code='EGW00201'; e.retryAfterSeconds=61; throw e;
      }
      if (!r.ok || d.rt_cd==='1') throw new Error(`KIS ${trId} 실패 HTTP ${r.status} [${d.msg_cd||''}]: ${d.msg1||JSON.stringify(d).slice(0,300)}`);
      return d;
    }
    throw lastError || new Error(`KIS ${trId} 요청 재시도 횟수를 초과했습니다.`);
  });
  kisRequestQueue = task.catch(()=>{});
  return task;
}
function normalizeKisQuote(code,d) {
  const x=d.output||{};
  const price=num(x.stck_prpr), prev=num(x.stck_sdpr)||num(x.stck_prdy_clpr);
  return {code:normalizeStockCode(code),name:x.hts_kor_isnm||'',price,previousClose:prev,change:num(x.prdy_vrss)??(price!=null&&prev!=null?price-prev:null),changePct:num(x.prdy_ctrt)??(price&&prev?(price/prev-1)*100:0),volume:num(x.acml_vol)||0,tradeValue:num(x.acml_tr_pbmn)||0,open:num(x.stck_oprc),high:num(x.stck_hgpr),low:num(x.stck_lwpr),source:'KIS',updatedAt:isoNow()};
}
async function kisQuote(env,code) {
  if(!isKisStockCode(code))throw new Error('KIS 시세 API는 숫자 6자리 종목코드만 호출할 수 있습니다.');
  const d=await kisGet(env,'/uapi/domestic-stock/v1/quotations/inquire-price',{FID_COND_MRKT_DIV_CODE:'J',FID_INPUT_ISCD:normalizeStockCode(code)},'FHKST01010100');
  return normalizeKisQuote(code,d);
}
async function kisCandles(env,code,days=700) {
  if(!isKisStockCode(code))throw new Error('KIS 일봉 API는 숫자 6자리 종목코드만 호출할 수 있습니다.');
  const end=new Date(),start=new Date(end.getTime()-days*86400000),all=new Map(); let cursor=new Date(end),lastDiagnostic=null;
  // KIS 차트 응답 건수 제한에 대비해 가장 오래된 응답일 전날로 조회 구간을 이동합니다.
  for(let page=0;page<12 && cursor>=start;page++){
    const d=await kisGet(env,'/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice',{FID_COND_MRKT_DIV_CODE:'J',FID_INPUT_ISCD:normalizeStockCode(code),FID_INPUT_DATE_1:ymd(start),FID_INPUT_DATE_2:ymd(cursor),FID_PERIOD_DIV_CODE:'D',FID_ORG_ADJ_PRC:'0'},'FHKST03010100');
    const arr=Array.isArray(d.output2)?d.output2:[];
    lastDiagnostic={rt_cd:d.rt_cd??null,msg_cd:d.msg_cd??null,msg1:d.msg1??null,output1Type:Array.isArray(d.output1)?'array':typeof d.output1,output2Type:Array.isArray(d.output2)?'array':typeof d.output2,output2Count:arr.length,outputKeys:Object.keys(d||{}),sample:arr[0]||null};
    for(const x of arr){const row={code:normalizeStockCode(code),date:String(x.stck_bsop_date||''),open:num(x.stck_oprc),high:num(x.stck_hgpr),low:num(x.stck_lwpr),close:num(x.stck_clpr),volume:num(x.acml_vol)||0,tradeValue:num(x.acml_tr_pbmn)||0,source:'KIS'};if(/^\d{8}$/.test(row.date)&&row.close!=null&&row.high!=null&&row.low!=null)all.set(row.date,row);}
    if(arr.length<90)break;
    const dates=[...all.keys()].sort(); if(!dates.length)break;
    const oldest=dates[0],dt=new Date(`${oldest.slice(0,4)}-${oldest.slice(4,6)}-${oldest.slice(6,8)}T00:00:00`);dt.setDate(dt.getDate()-1);if(dt>=cursor)break;cursor=dt;
    await sleep(KIS_MIN_INTERVAL_MS);
  }
  const rows=[...all.values()].sort((a,b)=>a.date.localeCompare(b.date));
  if(!rows.length)throw new Error(`KIS 일봉 응답에 저장 가능한 데이터가 없습니다. 진단=${JSON.stringify(lastDiagnostic)}`);
  return rows;
}
// EMA는 첫 종가로 시작하지 않고 초기 period개 종가의 SMA로 시드합니다.
// 초기 구간은 계산 근거가 부족하므로 null로 두어 지표를 과장하지 않습니다.
function emaSeries(values,period) {
  const out=Array(values.length).fill(null); if(values.length<period)return out;
  let e=values.slice(0,period).reduce((a,b)=>a+b,0)/period; out[period-1]=e;
  const k=2/(period+1);
  for(let i=period;i<values.length;i++){e=values[i]*k+e*(1-k);out[i]=e;}
  return out;
}
function rsiSeries(values,period=14) {
  const out=Array(values.length).fill(null); if(values.length<=period)return out;
  let gain=0,loss=0;
  for(let i=1;i<=period;i++){const d=values[i]-values[i-1];if(d>0)gain+=d;else loss-=d;}
  let avgG=gain/period,avgL=loss/period;
  const value=()=>avgG===0&&avgL===0?50:(avgL===0?100:(avgG===0?0:100-100/(1+avgG/avgL)));
  out[period]=value();
  for(let i=period+1;i<values.length;i++){const d=values[i]-values[i-1];avgG=(avgG*(period-1)+Math.max(d,0))/period;avgL=(avgL*(period-1)+Math.max(-d,0))/period;out[i]=value();}
  return out;
}
function calculateIndicatorRows(code,candles) {
  // 날짜 중복/비정상 종가를 제거하고 오래된 날짜부터 계산합니다.
  const byDate=new Map();
  for(const x of candles||[]){const date=String(x.date||'');const close=Number(x.close);if(/^\d{8}$/.test(date)&&Number.isFinite(close)&&close>0)byDate.set(date,{...x,date,close});}
  const rows=[...byDate.values()].sort((a,b)=>a.date.localeCompare(b.date));
  const c=rows.map(x=>x.close);
  const e5=emaSeries(c,5),e10=emaSeries(c,10),e20=emaSeries(c,20),e60=emaSeries(c,60),e120=emaSeries(c,120),rsi=rsiSeries(c,14),e12=emaSeries(c,12),e26=emaSeries(c,26);
  const macd=Array(c.length).fill(null),macdSignal=Array(c.length).fill(null),macdHist=Array(c.length).fill(null);
  const validMacd=[];
  for(let i=0;i<c.length;i++)if(e12[i]!=null&&e26[i]!=null){macd[i]=e12[i]-e26[i];validMacd.push({index:i,value:macd[i]});}
  if(validMacd.length>=9){
    let signal=validMacd.slice(0,9).reduce((a,x)=>a+x.value,0)/9;
    macdSignal[validMacd[8].index]=signal; macdHist[validMacd[8].index]=macd[validMacd[8].index]-signal;
    const k=2/(9+1);
    for(let j=9;j<validMacd.length;j++){const item=validMacd[j];signal=item.value*k+signal*(1-k);macdSignal[item.index]=signal;macdHist[item.index]=macd[item.index]-signal;}
  }
  return rows.map((x,i)=>({code,date:x.date,ema5:e5[i],ema10:e10[i],ema20:e20[i],ema60:e60[i],ema120:e120[i],rsi14:rsi[i],macd:macd[i],macdSignal:macdSignal[i],macdHist:macdHist[i]}));
}
async function d1Batch(db,statements,batchSize=80){for(let i=0;i<statements.length;i+=batchSize)await db.batch(statements.slice(i,i+batchSize));}
async function saveUniverse(db,rows) {
  const eligible=(rows||[]).filter(isEligibleCommonStock);
  const stmts=eligible.map(x=>db.prepare(`INSERT INTO stocks(code,name,market,market_cap,listed_shares,active,updated_at,security_type,security_verified,security_source,security_reason) VALUES(?,?,?,?,?,1,?,?,?,?,?) ON CONFLICT(code) DO UPDATE SET name=excluded.name,market=excluded.market,market_cap=COALESCE(excluded.market_cap,stocks.market_cap),listed_shares=COALESCE(excluded.listed_shares,stocks.listed_shares),active=1,updated_at=excluded.updated_at,security_type=excluded.security_type,security_verified=1,security_source=excluded.security_source,security_reason=excluded.security_reason`).bind(x.code,x.name,x.market,x.marketValue??null,x.listedShares??null,isoNow(),x.securityType,x.securitySource||'NAVER-INDIVIDUAL-STOCKS-V3',x.securityType==='PREFERRED'?'우선주 확인':'개별주식 목록의 보통주 확인'));
  await d1Batch(db,stmts); return eligible.length;
}
async function saveQuotes(db,rows) {
  const stmts=rows.filter(x=>x.price!=null).map(x=>db.prepare(`INSERT INTO stock_quotes(code,price,previous_close,change_value,change_pct,volume,trade_value,source,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(code) DO UPDATE SET price=excluded.price,previous_close=excluded.previous_close,change_value=excluded.change_value,change_pct=excluded.change_pct,volume=excluded.volume,trade_value=excluded.trade_value,source=excluded.source,updated_at=excluded.updated_at`).bind(x.code,x.price,x.previousClose??null,x.change??null,x.changePct??null,x.volume??0,x.tradeValue??x.value??0,x.source||'UNKNOWN',x.updatedAt||isoNow()));
  await d1Batch(db,stmts); return stmts.length;
}
async function saveCandles(db,code,rows) {
  // 모든 날짜를 NAVER 원본과 비교하고 실제 변경된 행만 갱신합니다.
  const existingResult=await db.prepare('SELECT date,open,high,low,close,volume,trade_value,source FROM stock_daily_candles WHERE code=?').bind(code).all();
  const existingRows=existingResult.results||[];
  const existing=new Map(existingRows.map(x=>[String(x.date),x]));
  const byDate=new Map();

  for(const x of rows||[]){
    const date=String(x.date||'');
    const validDate=date.length===8 && [...date].every(ch=>ch>='0'&&ch<='9');
    if(validDate&&Number.isFinite(Number(x.close))&&Number(x.close)>0){
      byDate.set(date,x);
    }
  }

  const toWrite=[];
  let unchanged=0,updated=0;

  for(const x of byDate.values()){
    const old=existing.get(String(x.date));
    if(!old){
      toWrite.push(x);
      continue;
    }

    const changed=
      ['open','high','low','close','volume'].some(
        k=>Number(old[k]??0)!==Number(x[k]??0)
      ) ||
      (x.tradeValue!=null && Number(old.trade_value??0)!==Number(x.tradeValue)) ||
      String(old.source||'UNKNOWN')!=='NAVER';

    if(changed){
      toWrite.push(x);
      updated++;
    }else{
      unchanged++;
    }
  }

  const stmts=toWrite.map(x=>db.prepare(
    `INSERT INTO stock_daily_candles
    (code,date,open,high,low,close,volume,trade_value,source,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(code,date) DO UPDATE SET
    open=excluded.open,
    high=excluded.high,
    low=excluded.low,
    close=excluded.close,
    volume=excluded.volume,
    trade_value=excluded.trade_value,
    source=excluded.source,
    updated_at=excluded.updated_at
    WHERE stock_daily_candles.open IS NOT excluded.open
    OR stock_daily_candles.high IS NOT excluded.high
    OR stock_daily_candles.low IS NOT excluded.low
    OR stock_daily_candles.close IS NOT excluded.close
    OR stock_daily_candles.volume IS NOT excluded.volume
    OR stock_daily_candles.trade_value IS NOT excluded.trade_value
    OR stock_daily_candles.source IS NOT excluded.source`
  ).bind(
    code,x.date,x.open,x.high,x.low,x.close,
    x.volume||0,(x.tradeValue??existing.get(String(x.date))?.trade_value??0),'NAVER',isoNow()
  ));

  if(stmts.length) await d1Batch(db,stmts);

  return {
    inserted:toWrite.length-updated,
    updated,
    unchanged
  };
}
async function saveIndicators(db,code,rows,refreshTimestamp=false) {
  const changedOnly=refreshTimestamp?'':` WHERE stock_indicators.ema5 IS NOT excluded.ema5 OR stock_indicators.ema10 IS NOT excluded.ema10 OR stock_indicators.ema20 IS NOT excluded.ema20 OR stock_indicators.ema60 IS NOT excluded.ema60 OR stock_indicators.ema120 IS NOT excluded.ema120 OR stock_indicators.rsi14 IS NOT excluded.rsi14 OR stock_indicators.macd IS NOT excluded.macd OR stock_indicators.macd_signal IS NOT excluded.macd_signal OR stock_indicators.macd_hist IS NOT excluded.macd_hist`;
  const stmts=rows.map(x=>db.prepare(`INSERT INTO stock_indicators(code,date,ema5,ema10,ema20,ema60,ema120,rsi14,macd,macd_signal,macd_hist,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(code,date) DO UPDATE SET ema5=excluded.ema5,ema10=excluded.ema10,ema20=excluded.ema20,ema60=excluded.ema60,ema120=excluded.ema120,rsi14=excluded.rsi14,macd=excluded.macd,macd_signal=excluded.macd_signal,macd_hist=excluded.macd_hist,updated_at=excluded.updated_at${changedOnly}`).bind(code,x.date,x.ema5,x.ema10,x.ema20,x.ema60,x.ema120,x.rsi14,x.macd,x.macdSignal,x.macdHist,isoNow()));
  await d1Batch(db,stmts); return stmts.length;
}

/**
 * Durable per-stock indicator recalculation state.
 * The pending write is committed before chunked indicator writes begin.
 */
async function markIndicatorsPending(db,code) {
  const now=isoNow();
  await db.prepare(`
    INSERT INTO indicator_sync_state(code,status,started_at,completed_at,last_error)
    VALUES(?,'pending',?,NULL,NULL)
    ON CONFLICT(code) DO UPDATE SET
      status='pending',
      started_at=excluded.started_at,
      completed_at=NULL,
      last_error=NULL
  `).bind(code,now).run();
}
async function markIndicatorsCompleted(db,code) {
  await db.prepare(`
    UPDATE indicator_sync_state
    SET status='completed',completed_at=?,last_error=NULL
    WHERE code=?
  `).bind(isoNow(),code).run();
}
async function markIndicatorsError(db,code,error) {
  // Keep status='pending'; a diagnostic write must never clear the retry state.
  await db.prepare(`
    UPDATE indicator_sync_state
    SET last_error=?
    WHERE code=? AND status='pending'
  `).bind(String(error?.message||error).slice(0,1000),code).run();
}
async function indicatorsArePending(db,code) {
  const row=await db.prepare(`
    SELECT 1 AS pending
    FROM indicator_sync_state
    WHERE code=? AND status='pending'
    LIMIT 1
  `).bind(code).first();
  return !!row;
}
async function saveIndicatorsWithState(db,code,rows,refreshTimestamp=false) {
  // If this write fails, do not start indicator batches.
  await markIndicatorsPending(db,code);
  try {
    const saved=await saveIndicators(db,code,rows,refreshTimestamp);
    // Only complete after every saveIndicators batch has succeeded.
    await markIndicatorsCompleted(db,code);
    return saved;
  } catch(error) {
    try { await markIndicatorsError(db,code,error); } catch (_) {}
    throw error;
  }
}

async function dataStatus(env) {
  const db=env.DB; if(!db)return {dbConfigured:false,kisConfigured:!!(env.KIS_APP_KEY&&env.KIS_APP_SECRET),mode:env.KIS_MODE||'paper'};
  const [s,q,c,i,pending,completed,eligible,unverified,excluded]=await Promise.all(['stocks','stock_quotes','stock_daily_candles','stock_indicators'].map(t=>db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first()).concat([
    db.prepare(`SELECT COUNT(*) AS n FROM indicator_sync_state WHERE status='pending'`).first(),
    db.prepare(`SELECT COUNT(*) AS n FROM indicator_sync_state WHERE status='completed'`).first(),
    db.prepare("SELECT COUNT(*) AS n FROM stocks WHERE active=1 AND security_verified=1 AND security_type IN ('COMMON','PREFERRED') AND upper(market) IN ('KOSPI','KOSDAQ')").first(),
    db.prepare("SELECT COUNT(*) AS n FROM stocks WHERE active=1 AND security_verified=0").first(),
    db.prepare("SELECT COUNT(*) AS n FROM stocks WHERE active=1 AND security_type='EXCLUDED'").first()
  ]));
  return {dbConfigured:true,kisConfigured:!!(env.KIS_APP_KEY&&env.KIS_APP_SECRET),mode:env.KIS_MODE||'paper',securityPolicy:'KOSPI/KOSDAQ COMMON+PREFERRED; unverified excluded',counts:{stocks:s?.n||0,eligibleStocks:eligible?.n||0,unverifiedStocks:unverified?.n||0,excludedStocks:excluded?.n||0,quotes:q?.n||0,candles:c?.n||0,indicators:i?.n||0,indicatorsPending:pending?.n||0,indicatorsCompleted:completed?.n||0}};
}
// Read-only stock master validation. This endpoint never writes to D1.
async function validateUniverseMaster(env, url) {
  const db = requireDb(env);
  const market = String(url.searchParams.get('market') || '').toUpperCase();
  if (!['KOSPI', 'KOSDAQ'].includes(market)) {
    throw new Error('market은 KOSPI 또는 KOSDAQ만 지정할 수 있습니다. 시장별로 각각 검증하세요.');
  }

  const requestedCodes = [...new Set(
    String(url.searchParams.get('codes') || '')
      .split(',')
      .map(normalizeStockCode)
      .filter(isValidStockCode)
  )];
  if (requestedCodes.length > 100) {
    throw new Error('한 번에 검증할 수 있는 종목코드는 최대 100개입니다.');
  }

  // 네이버 공개 종목 목록을 시장별로 수집합니다. fetchUniverse는 D1에 쓰지 않습니다.
  const reference = await fetchUniverse(market);
  const d1Result = await db.prepare(
    "SELECT code, name, market, active, security_type AS securityType, security_verified AS securityVerified FROM stocks WHERE active=1 AND security_verified=1 AND security_type IN ('COMMON','PREFERRED') AND upper(market) IN ('KOSPI','KOSDAQ')"
  ).all();
  const d1Rows = d1Result.results || [];
  const d1ByCode = new Map(d1Rows.map(x => [normalizeStockCode(x.code), x]));
  const referenceByCode = new Map(reference.rows.filter(isEligibleCommonStock).map(x => [normalizeStockCode(x.code), x]));

  const targetCodes = requestedCodes.length
    ? requestedCodes
    : [...new Set([...referenceByCode.keys(), ...d1Rows
        .filter(x => String(x.market || '').toUpperCase() === market)
        .map(x => normalizeStockCode(x.code))])];

  const issues = [];
  const counts = {
    checked: 0,
    matched: 0,
    nameMismatch: 0,
    marketMismatch: 0,
    missingInD1: 0,
    absentFromReference: 0
  };

  for (const code of targetCodes) {
    const ref = referenceByCode.get(code);
    const local = d1ByCode.get(code);
    if (!ref && !local) continue;
    counts.checked++;

    if (ref && !local) {
      counts.missingInD1++;
      issues.push({ type: 'MISSING_IN_D1', code, referenceName: ref.name, referenceMarket: market });
      continue;
    }
    if (!ref && local) {
      counts.absentFromReference++;
      issues.push({
        type: 'ABSENT_FROM_REFERENCE_UNVERIFIED',
        code,
        d1Name: local.name,
        d1Market: local.market
      });
      continue;
    }

    const nameMismatch = String(local.name || '').trim() !== String(ref.name || '').trim();
    const marketMismatch = String(local.market || '').toUpperCase() !== String(ref.market || '').toUpperCase();
    if (nameMismatch) counts.nameMismatch++;
    if (marketMismatch) counts.marketMismatch++;
    if (nameMismatch || marketMismatch) {
      issues.push({
        type: nameMismatch && marketMismatch ? 'NAME_AND_MARKET_MISMATCH'
          : nameMismatch ? 'NAME_MISMATCH' : 'MARKET_MISMATCH',
        code,
        referenceName: ref.name,
        d1Name: local.name,
        referenceMarket: ref.market,
        d1Market: local.market
      });
    } else {
      counts.matched++;
    }
  }

  return {
    ok: true,
    readOnly: true,
    writesPerformed: 0,
    source: reference.source || 'NAVER-INDIVIDUAL-STOCKS-V3',
    market,
    requestedCodes: requestedCodes.length ? requestedCodes : null,
    referenceCount: reference.rows.length,
    d1ActiveCount: d1Rows.length,
    counts,
    issueCount: issues.length,
    issues: issues.slice(0, 200),
    issuesTruncated: issues.length > 200,
    sourceErrors: (reference.errors || []).slice(0, 20),
    referenceCoverage: reference.coverage || 'INCOMPLETE',
    referencePages: reference.pages,
    referenceTotalCount: reference.totalCount,
    warning: '네이버 개별주식 목록 API의 응답 범위 내 비교 결과입니다. ABSENT_FROM_REFERENCE_UNVERIFIED는 종목 오류 확정이 아니며, 이 API는 D1 데이터를 수정하지 않습니다.'
  };
}

async function syncData(env,url) {
  const db=requireDb(env), type=url.searchParams.get('type')||'universe', requestedLimit=Math.max(1,Number(url.searchParams.get('limit')||50)), offset=Math.max(0,Number(url.searchParams.get('offset')||0));
  // KIS 호출량과 Worker 요청시간을 고려해 시세/일봉은 작은 배치로 제한합니다.
  const selectedProvider=(url.searchParams.get('provider')||'auto').toLowerCase();
  const maxBatch=type==='candles'?1:(type==='quotes'?(selectedProvider==='naver'?20:5):(['indicators','indicators-repair'].includes(type)?(type==='indicators-repair'?1:5):200));
  const limit=Math.min(maxBatch,requestedLimit);
  if(type==='universe'){
    const market=(url.searchParams.get('market')||'ALL').toUpperCase(); const u=await fetchUniverse(market); if(!u.complete)throw new Error('종목 유니버스 페이지 수집이 불완전하여 D1 저장을 중단했습니다. '+(u.errors||[]).join(' | '));
    if(market==='ALL')await db.prepare("UPDATE stocks SET active=0,security_verified=0,security_type='UNVERIFIED',security_source='UNVERIFIED',security_reason='최신 종목 마스터에서 재검증 전' WHERE active=1").run();
    else await db.prepare("UPDATE stocks SET active=0,security_verified=0,security_type='UNVERIFIED',security_source='UNVERIFIED',security_reason='최신 종목 마스터에서 재검증 전' WHERE active=1 AND upper(market)=?").bind(market).run();
    await db.prepare("DELETE FROM stocks WHERE code='000000'").run(); const saved=await saveUniverse(db,u.rows);
    const commonStocks=u.rows.filter(x=>x.securityType==='COMMON'&&isEligibleCommonStock(x)).length;
    const preferredStocks=u.rows.filter(x=>x.securityType==='PREFERRED'&&isEligibleCommonStock(x)).length;
    const unverifiedExcluded=u.rows.filter(x=>x.securityType==='UNVERIFIED').length;
    const productExcluded=u.rows.filter(x=>x.securityType==='EXCLUDED').length;
    return {ok:true,type,market,discovered:u.rows.length,found:saved,saved,commonStocks,preferredStocks,unverifiedExcluded,productExcluded,policy:'KOSPI/KOSDAQ 보통주+우선주만 포함; 미확인 분류 제외',pages:u.pages,totalCount:u.totalCount,sourceUniqueCount:u.sourceUniqueCount,coverage:u.coverage,errors:(u.errors||[]).slice(0,10),source:u.source,at:isoNow()};
  }
  if(type==='indicators-repair'){
    // Keyset pagination: 완료된 종목은 후보 목록에서 빠져도 다음 종목을 건너뛰지 않습니다.
    const minCandles=Math.min(250,Math.max(120,Number(url.searchParams.get('minCandles')||120)));
    const afterCode=normalizeStockCode(url.searchParams.get('afterCode')||'');
    const selected=await db.prepare(`
      WITH candle_counts AS (
        SELECT code,COUNT(DISTINCT date) AS candle_count
        FROM stock_daily_candles
        WHERE length(date)=8 AND close>0
        GROUP BY code
      ), indicator_counts AS (
        SELECT code,COUNT(DISTINCT date) AS indicator_count
        FROM stock_indicators GROUP BY code
      )
      SELECT s.code,s.name
      FROM stocks s
      JOIN candle_counts c ON c.code=s.code
      LEFT JOIN indicator_counts i ON i.code=s.code
      WHERE s.active=1 AND s.security_verified=1 AND s.security_type IN ('COMMON','PREFERRED') AND upper(s.market) IN ('KOSPI','KOSDAQ') AND s.code<>'000000'
        AND (s.code>? OR EXISTS (
          SELECT 1 FROM indicator_sync_state st
          WHERE st.code=s.code AND st.status='pending'
        ))
        AND c.candle_count>=?
        AND (
          COALESCE(i.indicator_count,0)<>c.candle_count
          OR EXISTS (
            SELECT 1 FROM stock_daily_candles d
            LEFT JOIN stock_indicators ix ON ix.code=d.code AND ix.date=d.date
            WHERE d.code=s.code AND length(d.date)=8 AND d.close>0 AND ix.code IS NULL
          )
          OR EXISTS (
            SELECT 1 FROM stock_daily_candles d
            LEFT JOIN stock_indicators ix ON ix.code=d.code AND ix.date=d.date
            WHERE d.code=s.code AND length(d.date)=8 AND d.close>0
              AND (ix.code IS NULL OR COALESCE(d.updated_at,'')>COALESCE(ix.updated_at,''))
          )
          OR EXISTS (
            SELECT 1 FROM stock_indicators ix
            LEFT JOIN stock_daily_candles d ON d.code=ix.code AND d.date=ix.date
            WHERE ix.code=s.code AND d.code IS NULL
          )
          OR EXISTS (
            SELECT 1 FROM indicator_sync_state st
            WHERE st.code=s.code AND st.status='pending'
          )
        )
      ORDER BY CASE WHEN s.code>? THEN 0 ELSE 1 END, s.code LIMIT ?
    `).bind(afterCode,minCandles,afterCode,limit).all();
    const stocks=selected.results||[];
    if(!stocks.length)return {ok:true,type,done:true,afterCode,minCandles,processed:0,indicatorRowsSaved:0,failed:0,nextCode:null,message:'복구 대상 종목이 없습니다.',at:isoNow()};
    let processed=0,saved=0,skipped=0,limitedHistory=0;const errors=[];
    for(const stock of stocks){
      try{
        const r=await db.prepare('SELECT date,open,high,low,close,volume FROM stock_daily_candles WHERE code=? ORDER BY date ASC').bind(stock.code).all();
        const candles=r.results||[];
        const validCount=candles.filter(x=>/^\d{8}$/.test(String(x.date||''))&&Number.isFinite(Number(x.close))&&Number(x.close)>0).length;
        if(validCount<minCandles){skipped++;continue;}
        const rows=calculateIndicatorRows(stock.code,candles);
        if(rows.length<minCandles){skipped++;continue;}
        saved+=await saveIndicatorsWithState(db,stock.code,rows,true);
        processed++;if(rows.length<250)limitedHistory++;
      }catch(e){errors.push({code:stock.code,name:stock.name,error:e.message});}
    }
    const last=stocks[stocks.length-1];
    return {ok:true,type,done:false,afterCode,minCandles,processed,skipped,limitedHistory,fullHistory:processed-limitedHistory,indicatorRowsSaved:saved,failed:errors.length,errors,nextCode:last.code,selectedCodes:stocks.map(x=>x.code),at:isoNow()};
  }
  const requestedCode=url.searchParams.get('code');
  let stocks=[];
  if(requestedCode!==null){
    const target=normalizeStockCode(requestedCode);
    if(!isValidStockCode(target))throw new Error('유효한 6자리 상장 종목 code가 필요합니다. 000000은 사용할 수 없습니다.');
    const selected=await db.prepare('SELECT code,name,market FROM stocks WHERE active=1 AND security_verified=1 AND security_type IN ('COMMON','PREFERRED') AND upper(market) IN ('KOSPI','KOSDAQ') AND code=?').bind(target).all();
    stocks=selected.results||[];
  } else {
    const selected=await db.prepare(`SELECT code,name,market FROM stocks WHERE active=1 AND security_verified=1 AND security_type IN ('COMMON','PREFERRED') AND upper(market) IN ('KOSPI','KOSDAQ') AND code<>'000000' ORDER BY code LIMIT ? OFFSET ?`).bind(limit,offset).all();
    stocks=selected.results||[];
  }
  if(!stocks.length)return {ok:true,type,offset,requestedCode:requestedCode??null,processed:0,message:'대상 종목이 없습니다. 종목 마스터에 code가 등록되어 있는지 확인하세요.'};
  if(type==='quotes'){
    const provider=(url.searchParams.get('provider')||'auto').toLowerCase(), out=[],errors=[];
    const kisConfigured=!!(env.KIS_APP_KEY&&env.KIS_APP_SECRET);
    for(const s of stocks){try{let q;const useNaver=provider==='naver'||(!kisConfigured&&provider!=='kis')||(provider==='auto'&&!isKisStockCode(s.code));if(useNaver){const n=await fetchNaver([s.code]);q=n[s.code];if(!q)throw new Error('Naver 시세 없음');}else{q=await kisQuote(env,s.code);await sleep(KIS_MIN_INTERVAL_MS);}out.push({...q,name:q.name||s.name,market:s.market});}catch(e){errors.push({code:s.code,error:e.message});}}
    const saved=await saveQuotes(db,out); return {ok:true,type,provider:(provider==='naver'?'NAVER':(env.KIS_APP_KEY?'KIS':'NAVER-FALLBACK')),offset,requestedLimit,appliedLimit:limit,processed:stocks.length,saved,failed:errors.length,errors:errors.slice(0,20),retryCodes:errors.map(x=>x.code),nextOffset:offset+stocks.length,at:isoNow()};
  }
  if(type==='candles'){
    const days=Math.min(2500,Math.max(120,Number(url.searchParams.get('days')||700)));
    const minCandles=Math.min(250,Math.max(120,Number(url.searchParams.get('minCandles')||120)));
    const provider='naver',errors=[],indicatorErrors=[];
    let saved=0,updated=0,unchanged=0;
    let indicatorStocksRecalculated=0,indicatorStocksSkipped=0;
    let indicatorStocksUnchanged=0,indicatorRowsProcessed=0;
    const diagnostics=[];

    for(const s of stocks){
      try{
        let rows;

        if(provider==='naver-legacy'&&isKisStockCode(s.code)){
          const result=await fetchHistoryLegacy(s.code,days);
          rows=result.rows.map(x=>({...x,date:String(x.t||'').replace(/-/g,''),source:'NAVER-LEGACY'}));
          diagnostics.push({code:s.code,...result.diagnostics});
        }else if(provider==='naver-legacy'||provider==='naver'||(!env.KIS_APP_KEY&&!env.KIS_APP_SECRET)||(provider==='auto'&&!isKisStockCode(s.code))){
          rows=await fetchHistoryPaged(s.code,days);
          rows=rows.map(x=>({...x,date:String(x.t||'').replace(/-/g,'')}))
            .filter(x=>/^\d{8}$/.test(x.date))
            .map(x=>({...x,source:'NAVER'}));
        }else{
          rows=await kisCandles(env,s.code,days);
          await sleep(KIS_MIN_INTERVAL_MS);
        }

        const writeResult=await saveCandles(db,s.code,rows);
        saved+=writeResult.inserted;
        updated+=writeResult.updated;
        unchanged+=writeResult.unchanged;

        // 일봉에 신규/수정이 있을 때만 해당 종목의 전체 지표를 다시 계산합니다.
        let indicatorsPending=await indicatorsArePending(db,s.code);
        if((writeResult.inserted+writeResult.updated)===0){
          try{
            const pendingResult=await db.prepare(`
              SELECT 1 AS pending
              FROM stock_daily_candles d
              LEFT JOIN stock_indicators ix ON ix.code=d.code AND ix.date=d.date
              WHERE d.code=? AND length(d.date)=8 AND d.close>0
                AND (ix.code IS NULL OR COALESCE(d.updated_at,'')>COALESCE(ix.updated_at,''))
              LIMIT 1
            `).bind(s.code).all();
            indicatorsPending=indicatorsPending||(pendingResult.results||[]).length>0;
          }catch(e){
            indicatorErrors.push({code:s.code,error:`지표 재시도 확인 실패: ${e.message}`});
          }
        }

        if((writeResult.inserted+writeResult.updated)>0||indicatorsPending){
          try{
            const candleResult=await db.prepare(
              'SELECT date,open,high,low,close,volume FROM stock_daily_candles WHERE code=? ORDER BY date ASC'
            ).bind(s.code).all();

            const candles=candleResult.results||[];
            const validCount=candles.filter(
              x=>/^\d{8}$/.test(String(x.date||''))&&Number.isFinite(Number(x.close))&&Number(x.close)>0
            ).length;

            if(validCount<minCandles){
              indicatorStocksSkipped++;
            }else{
              const indicatorRows=calculateIndicatorRows(s.code,candles);

              if(indicatorRows.length<minCandles){
                indicatorStocksSkipped++;
              }else{
                await saveIndicatorsWithState(db,s.code,indicatorRows,true);
                indicatorStocksRecalculated++;
                indicatorRowsProcessed+=indicatorRows.length;
              }
            }
          }catch(e){
            indicatorErrors.push({code:s.code,error:e.message});
          }
        }else{
          indicatorStocksUnchanged++;
        }
      }catch(e){
        errors.push({code:s.code,error:e.message});
      }
    }

    const providerLabel=provider==='naver-legacy'?'NAVER-LEGACY':(provider==='naver'?'NAVER':(env.KIS_APP_KEY?'KIS':'NAVER-FALLBACK'));

    return {
      ok:true,
      type,
      provider:providerLabel,
      offset,
      requestedLimit,
      appliedLimit:limit,
      processed:stocks.length,
      candlesSaved:saved,
      candlesUpdated:updated,
      candlesUnchanged:unchanged,
      indicatorAlgorithm:'SMA-seeded EMA / Wilder RSI / standard MACD',
      indicatorMinCandles:minCandles,
      indicatorStocksRecalculated,
      indicatorStocksSkipped,
      indicatorStocksUnchanged,
      indicatorRowsProcessed,
      indicatorFailed:indicatorErrors.length,
      indicatorErrors:indicatorErrors.slice(0,20),
      failed:errors.length,
      errors:errors.slice(0,20),
      retryCodes:errors.map(x=>x.code),
      diagnostics,
      nextOffset:offset+stocks.length,
      at:isoNow()
    };
  }
  if(type==='indicators'){
    // EMA120 계산에 필요한 최소 이력은 120거래일입니다. 250일 미만은 계산은 하되
    // 워밍업이 짧은 종목으로 분류해 결과에서 별도로 알려줍니다.
    const minCandles=Math.min(250,Math.max(120,Number(url.searchParams.get('minCandles')||120)));
    let processed=0,saved=0,skipped=0,limitedHistory=0,errors=[];
    for(const s of stocks){
      try{
        const r=await db.prepare('SELECT date,open,high,low,close,volume FROM stock_daily_candles WHERE code=? ORDER BY date ASC').bind(s.code).all();
        const candles=r.results||[];
        const validCount=candles.filter(x=>/^\d{8}$/.test(String(x.date||''))&&Number.isFinite(Number(x.close))&&Number(x.close)>0).length;
        if(validCount<minCandles){skipped++;continue;}
        const rows=calculateIndicatorRows(s.code,candles);
        if(rows.length<minCandles){skipped++;continue;}
        saved+=await saveIndicatorsWithState(db,s.code,rows);
        processed++; if(rows.length<250)limitedHistory++;
      }catch(e){errors.push({code:s.code,error:e.message});}
    }
    return {ok:true,type,algorithm:'SMA-seeded EMA / Wilder RSI / standard MACD',offset,requestedLimit,appliedLimit:limit,minCandles,processed,skipped,limitedHistory,fullHistory:processed-limitedHistory,indicatorRowsSaved:saved,failed:errors.length,errors:errors.slice(0,20),nextOffset:offset+stocks.length,at:isoNow()};
  }
  throw new Error('지원하지 않는 sync type입니다. universe, quotes, candles, indicators 중 하나를 사용하세요.');
}
async function dataAudit(env,url) {
  const db=requireDb(env);
  const minCandles=Math.min(250,Math.max(120,Number(url.searchParams.get('minCandles')||120)));
  const rows=await db.prepare(`
    WITH candle_counts AS (
      SELECT code, COUNT(DISTINCT date) AS candle_count, MIN(date) AS first_date, MAX(date) AS last_date
      FROM stock_daily_candles WHERE length(date)=8 AND close>0 GROUP BY code
    ), indicator_counts AS (
      SELECT code, COUNT(DISTINCT date) AS indicator_count, MAX(date) AS indicator_last_date
      FROM stock_indicators GROUP BY code
    ), per_stock AS (
      SELECT s.code,s.name,COALESCE(c.candle_count,0) AS candle_count,c.first_date,c.last_date,
             COALESCE(i.indicator_count,0) AS indicator_count,i.indicator_last_date,
             CASE WHEN EXISTS (
               SELECT 1 FROM stock_daily_candles d
               LEFT JOIN stock_indicators ix ON ix.code=d.code AND ix.date=d.date
               WHERE d.code=s.code AND length(d.date)=8 AND d.close>0 AND ix.code IS NULL
             ) THEN 1 ELSE 0 END AS missing_indicator_dates,
             CASE WHEN EXISTS (
               SELECT 1 FROM stock_indicators ix
               LEFT JOIN stock_daily_candles d ON d.code=ix.code AND d.date=ix.date
               WHERE ix.code=s.code AND d.code IS NULL
             ) THEN 1 ELSE 0 END AS extra_indicator_dates
      FROM stocks s LEFT JOIN candle_counts c ON c.code=s.code
      LEFT JOIN indicator_counts i ON i.code=s.code
      WHERE s.active=1 AND s.security_verified=1 AND s.security_type IN ('COMMON','PREFERRED') AND upper(s.market) IN ('KOSPI','KOSDAQ') AND s.code<>'000000'
    )
    SELECT *, CASE
      WHEN candle_count=0 THEN 'zero'
      WHEN candle_count<30 THEN 'under30'
      WHEN candle_count<60 THEN '30to59'
      WHEN candle_count<120 THEN '60to119'
      WHEN candle_count<250 THEN '120to249'
      ELSE '250plus' END AS history_band
    FROM per_stock ORDER BY code
  `).all();
  const all=rows.results||[];
  const bands={zero:0,under30:0,'30to59':0,'60to119':0,'120to249':0,'250plus':0};
  let eligible=0,eligibleMissingIndicators=0,eligiblePartialIndicators=0,eligibleCompleteIndicators=0,eligibleDateMismatches=0,eligibleNeedsRepair=0,withIndicators=0;
  const samples={zero:[],under30:[],'30to59':[],'60to119':[],'120to249':[],'250plus':[],eligibleMissingIndicators:[],eligiblePartialIndicators:[],eligibleDateMismatches:[]};
  for(const x of all){
    bands[x.history_band]=(bands[x.history_band]||0)+1;
    if(Number(x.indicator_count)>0)withIndicators++;
    if(Number(x.candle_count)>=minCandles){
      eligible++;
      const count=Number(x.indicator_count||0), candleCount=Number(x.candle_count||0);
      const dateMismatch=Number(x.missing_indicator_dates||0)>0||Number(x.extra_indicator_dates||0)>0||String(x.indicator_last_date||'')!==String(x.last_date||'');
      if(count===0){eligibleMissingIndicators++;if(samples.eligibleMissingIndicators.length<30)samples.eligibleMissingIndicators.push(x);}
      else if(count!==candleCount||dateMismatch){eligiblePartialIndicators++;if(samples.eligiblePartialIndicators.length<30)samples.eligiblePartialIndicators.push(x);}
      if(dateMismatch){eligibleDateMismatches++;if(samples.eligibleDateMismatches.length<30)samples.eligibleDateMismatches.push(x);}
      if(count===candleCount&&!dateMismatch)eligibleCompleteIndicators++;
      else eligibleNeedsRepair++;
    }
    const bucket=x.history_band;if(samples[bucket]&&samples[bucket].length<10)samples[bucket].push(x);
  }
  const includeDetails = url.searchParams.get('details') === '1';
  const eligibleStocks = includeDetails
    ? all
        .filter(x => Number(x.candle_count) >= minCandles)
        .map(x => ({
          code: String(x.code),
          name: String(x.name || ''),
          candleCount: Number(x.candle_count || 0),
          indicatorCount: Number(x.indicator_count || 0),
          firstDate: x.first_date || null,
          lastDate: x.last_date || null,
          indicatorLastDate: x.indicator_last_date || null
        }))
    : undefined;

  return {
    ok:true,
    totalStocks:all.length,
    minCandles,
    historyBands:bands,
    eligibleForIndicators:eligible,
    eligibleMissingIndicators,
    eligiblePartialIndicators,
    eligibleDateMismatches,
    eligibleCompleteIndicators,
    stocksWithIndicators:withIndicators,
    eligibleNeedsRepair,
    samples,
    ...(includeDetails ? { eligibleStocks } : {}),
    note:'종목별 distinct 일봉 날짜 수와 일봉-지표 날짜 대조 기준입니다. eligible은 최소 일봉 기준을 충족한 종목입니다.'
  };
}

async function dataCoverage(env) {
  const db=requireDb(env);
  const total=await db.prepare("SELECT COUNT(*) AS n FROM stocks WHERE active=1 AND security_verified=1 AND security_type IN ('COMMON','PREFERRED') AND upper(market) IN ('KOSPI','KOSDAQ') AND code<>'000000'").first();
  const quotes=await db.prepare("SELECT COUNT(*) AS n FROM stocks s INNER JOIN stock_quotes q ON q.code=s.code WHERE s.active=1 AND s.security_verified=1 AND s.security_type IN ('COMMON','PREFERRED') AND upper(s.market) IN ('KOSPI','KOSDAQ') AND s.code<>'000000'").first();
  const candle=await db.prepare("SELECT COUNT(DISTINCT d.code) AS n, COUNT(*) AS rows FROM stock_daily_candles d INNER JOIN stocks s ON s.code=d.code WHERE s.active=1 AND s.security_verified=1 AND s.security_type IN ('COMMON','PREFERRED') AND upper(s.market) IN ('KOSPI','KOSDAQ')").first();
  const indicator=await db.prepare("SELECT COUNT(DISTINCT d.code) AS n, COUNT(*) AS rows FROM stock_indicators d INNER JOIN stocks s ON s.code=d.code WHERE s.active=1 AND s.security_verified=1 AND s.security_type IN ('COMMON','PREFERRED') AND upper(s.market) IN ('KOSPI','KOSDAQ')").first();
  const missingQuotes=await db.prepare('SELECT s.code,s.name FROM stocks s LEFT JOIN stock_quotes q ON q.code=s.code WHERE s.active=1 AND s.security_verified=1 AND s.security_type IN ('COMMON','PREFERRED') AND upper(s.market) IN ('KOSPI','KOSDAQ') AND s.code<>\'000000\' AND q.code IS NULL ORDER BY s.code LIMIT 20').all();
  const missingCandles=await db.prepare('SELECT s.code,s.name FROM stocks s LEFT JOIN (SELECT DISTINCT code FROM stock_daily_candles) c ON c.code=s.code WHERE s.active=1 AND s.security_verified=1 AND s.security_type IN ('COMMON','PREFERRED') AND upper(s.market) IN ('KOSPI','KOSDAQ') AND s.code<>\'000000\' AND c.code IS NULL ORDER BY s.code LIMIT 20').all();
  const missingIndicators=await db.prepare('SELECT s.code,s.name FROM stocks s LEFT JOIN (SELECT DISTINCT code FROM stock_indicators) i ON i.code=s.code WHERE s.active=1 AND s.security_verified=1 AND s.security_type IN ('COMMON','PREFERRED') AND upper(s.market) IN ('KOSPI','KOSDAQ') AND s.code<>\'000000\' AND i.code IS NULL ORDER BY s.code LIMIT 20').all();
  const n=Number(total?.n||0), q=Number(quotes?.n||0), c=Number(candle?.n||0), i=Number(indicator?.n||0);
  return {ok:true,totalStocks:n,coverage:{quotes:{stocks:q,missing:Math.max(0,n-q),percent:n?Number((q/n*100).toFixed(2)):0},candles:{stocks:c,rows:Number(candle?.rows||0),missing:Math.max(0,n-c),percent:n?Number((c/n*100).toFixed(2)):0},indicators:{stocks:i,rows:Number(indicator?.rows||0),missing:Math.max(0,n-i),percent:n?Number((i/n*100).toFixed(2)):0}},missingSamples:{quotes:missingQuotes.results||[],candles:missingCandles.results||[],indicators:missingIndicators.results||[]},note:'누락 샘플은 각 항목 최대 20종목입니다.'};
}
async function dataRead(env,url,path) {
  const db=requireDb(env),code=normalizeStockCode(url.searchParams.get('code')||''); if(!isValidStockCode(code))throw new Error('유효한 6자리 종목코드가 필요합니다.');
  await requireEligibleStock(env,code);
  if(path==='/api/data/candles'){const limit=Math.min(2500,Math.max(1,Number(url.searchParams.get('limit')||700)));const r=await db.prepare('SELECT * FROM stock_daily_candles WHERE code=? ORDER BY date DESC LIMIT ?').bind(code,limit).all();return {ok:true,code,rows:(r.results||[]).reverse()};}
  if(path==='/api/data/indicators'){const limit=Math.min(2500,Math.max(1,Number(url.searchParams.get('limit')||700)));const r=await db.prepare('SELECT * FROM stock_indicators WHERE code=? ORDER BY date DESC LIMIT ?').bind(code,limit).all();return {ok:true,code,rows:(r.results||[]).reverse()};}
  if(path==='/api/data/quote'){
    const r=await db.prepare(`SELECT s.code AS code,s.name AS name,s.market AS market,
      q.price AS price,q.previous_close AS previous_close,q.change_value AS change_value,
      q.change_pct AS change_pct,q.volume AS volume,q.trade_value AS trade_value,
      q.source AS source,q.updated_at AS updated_at
      FROM stocks s LEFT JOIN stock_quotes q ON q.code=s.code WHERE s.code=?`).bind(code).first();
    return {ok:true,quote:r||null};
  }
  throw new Error('Not Found');
}
// -----------------------------------------------------------------------------



// ---- Naver theme discovery/import v1 ----------------------------------------
function walkObjects(root, visit, depth=0) {
  if (depth > 12 || root == null) return;
  if (Array.isArray(root)) { for (const x of root) walkObjects(x, visit, depth+1); return; }
  if (typeof root !== 'object') return;
  visit(root);
  for (const v of Object.values(root)) if (v && typeof v === 'object') walkObjects(v, visit, depth+1);
}
function firstText(o, keys) {
  for (const k of keys) { const v=o?.[k]; if (v!=null && String(v).trim()) return String(v).trim(); }
  return '';
}
function extractNaverThemes(payload) {
  const out=new Map();
  walkObjects(payload,o=>{
    const id=firstText(o,['sectorCode','sectorNo','themeCode','themeId','no','id','code']);
    const name=firstText(o,['sectorName','themeName','sectorNm','name','title','itemName']);
    if (!id || !name || id.length>80 || name.length>100) return;
    if (!/^[0-9A-Za-z_-]+$/.test(id)) return;
    // Avoid treating arbitrary stock records as themes.
    if (/^\d{6}$/.test(id)) return;
    out.set(id,{sourceId:id,name});
  });
  return [...out.values()];
}
function extractNaverThemeStocks(payload) {
  const out=new Map();
  walkObjects(payload,o=>{
    const raw=firstText(o,['itemCode','itemcode','stockCode','symbolCode','cd','code','isuCd']);
    const code=normalizeStockCode(raw);
    const name=firstText(o,['itemName','stockName','name','nm','companyName','itemname']);
    if (!isValidStockCode(code) || !name || name.length>100) return;
    out.set(code,{code,name});
  });
  return [...out.values()];
}
async function fetchNaverJson(url) {
  const r=await fetch(url,{headers:{'User-Agent':N,'Accept':'application/json,*/*','Referer':'https://m.stock.naver.com/'}});
  const body=await r.text();
  if(!r.ok) throw new Error(`Naver HTTP ${r.status}: ${body.slice(0,160)}`);
  try{return JSON.parse(body);}catch(e){throw new Error(`Naver JSON parse failed: ${body.slice(0,160)}`);}
}
function themeSlug(s) {
  const ascii=String(s).normalize('NFKD').replace(/[^\w가-힣]+/g,'_').replace(/^_+|_+$/g,'').toUpperCase().slice(0,40);
  return ascii || 'THEME';
}
const PREFERRED_STOCK_NAME_EXCEPTIONS = new Set([
  // 회사명 자체가 '우'로 끝나지만 우선주가 아닌 종목 (2026-11 확인)
  '성우',
  '에코글로우'
]);

const INFRASTRUCTURE_INVESTMENT_NAMES = new Set([
  // 인프라 투자기구/펀드로 분류해 일반 보통주 유니버스에서 제외
  '맥쿼리인프라',
  'KB발해인프라',
  'NICE인프라'
]);

function isPreferredStockName(name) {
  const normalized=String(name||'').replace(/\s+/g,'').toUpperCase();
  if(PREFERRED_STOCK_NAME_EXCEPTIONS.has(normalized)) return false;
  return /우선주|우(?:B|C)?$/.test(normalized);
}

const NON_EQUITY_SECURITY_RE=/(ETF|ETN|ELW|스팩|SPAC|(?:리츠|REIT)$|이리츠코크렙|채권|국채|회사채|선물|펀드|투자신탁|수익증권)/i;
const SECURITY_TYPE_FIELDS=['securityType','securityTypeName','securityTypeCode','stockType','stockTypeName','stockTypeCode','itemType','itemTypeName','itemTypeCode','issueType','issueTypeName','securityKind','productType','stockKind','stockEndType','endType'];
function classifySecurityType(item={},krx={},name='',source=''){
  const market=String(item.marketType??item.market??'').toUpperCase();
  const normalized=String(name||item.itemName||item.name||'').replace(/\s+/g,'').toUpperCase();
  if(!['KOSPI','KOSDAQ'].includes(market))return 'UNVERIFIED';
  if(NON_EQUITY_SECURITY_RE.test(normalized)||INFRASTRUCTURE_INVESTMENT_NAMES.has(normalized)||/인프라(?:투자|펀드|투융자)/.test(normalized))return 'EXCLUDED';
  const status=String(krx.tradableStatus??item.tradableStatus??'').trim().toLowerCase();
  const statusCode=String(krx.tradableStatusCode??item.tradableStatusCode??'').trim().toLowerCase();
  if((status&&status!=='tradable')||(statusCode&&statusCode!=='ok'))return 'UNVERIFIED';
  const values=SECURITY_TYPE_FIELDS.map(k=>item?.[k]??krx?.[k]).filter(v=>v!==undefined&&v!==null&&String(v).trim()!=='').map(v=>String(v).trim().toUpperCase().replace(/[\\s-]+/g,'_'));
  const joined=values.join('|');
  if(/ETF|ETN|ELW|SPAC|REIT|FUND|BOND|FUTURE|OPTION|WARRANT|투자신탁|상장지수|주식워런트|기업인수목적|리츠|펀드|채권|선물|파생/.test(joined))return 'EXCLUDED';
  if(/PREFERRED|PREF|PREFERENCE|우선주|우선/.test(joined)||isPreferredStockName(normalized))return 'PREFERRED';
  if(/COMMON|COMMON_STOCK|COMMONSTOCK|ORDINARY|ORDINARY_SHARE|^STOCK$|^ST$|^STK$|보통주|^주식$/.test(joined))return 'COMMON';
  if(values.length===0&&source==='NAVER-INDIVIDUAL-STOCKS-V3')return 'COMMON';
  return 'UNVERIFIED';
}
function isEligibleCommonStock(row) {
  const market=String(row.market||'').toUpperCase();
  const name=String(row.name||'').replace(/\s+/g,'').toUpperCase();
  const securityType=String(row.securityType??row.security_type??'').toUpperCase();
  const verified=Number(row.securityVerified??row.security_verified??0)===1 || row.securityVerified===true;
  const tradableStatus=String(row.tradableStatus||'').trim().toLowerCase();
  const tradableStatusCode=String(row.tradableStatusCode||'').trim().toLowerCase();
  if(!['KOSPI','KOSDAQ'].includes(market))return false;
  if(!verified||!['COMMON','PREFERRED'].includes(securityType))return false;
  if(NON_EQUITY_SECURITY_RE.test(name)||INFRASTRUCTURE_INVESTMENT_NAMES.has(name)||/인프라(?:투자|펀드|투융자)/.test(name))return false;
  if(tradableStatus&&tradableStatus!=='tradable')return false;
  if(tradableStatusCode&&tradableStatusCode!=='ok')return false;
  return true;
}
async function discoverNaverThemeList() {
  const url = 'https://m.stock.naver.com/front-api/stock/sectors/all?nationType=domestic&sectorType=theme&sectorSortType=MARKET_VALUE&businessDayCategory=daily';
  const payload=await fetchNaverJson(url);
  const themes=extractNaverThemes(payload);
  if(!themes.length) throw new Error('네이버 테마 목록 응답에서 테마 코드/이름을 추출하지 못했습니다. 응답 구조가 변경되었을 수 있습니다.');
  return {themes,rawKeys:Object.keys(payload||{}),sourceUrl:url};
}

async function fetchNaverDesktopJson(url) {
  const r = await fetch(url, {
    headers: {
      'User-Agent': N,
      'Accept': 'application/json,*/*',
      'Referer': 'https://stock.naver.com/'
    }
  });

  const body = await r.text();

  if (!r.ok) {
    throw new Error(
      `Naver Desktop HTTP ${r.status}: ${body.slice(0, 200)}`
    );
  }

  try {
    return JSON.parse(body);
  } catch (e) {
    throw new Error(
      `Naver Desktop JSON parse failed: ${body.slice(0, 200)}`
    );
  }
}

async function discoverNaverThemeMembers(
  sourceId,
  pageSize = 50,
  maxPages = 20
) {
  const rows = new Map();
  const pageStats = [];
  const marketStats = {};
  const sourceUrls = [];

  const markets = ['KOSPI', 'KOSDAQ'];

  for (const marketType of markets) {
    let cursor = '';
    let pages = 0;
    let hasNext = true;
    const seenCursors = new Set();
    let marketReceived = 0;

    while (hasNext && pages < maxPages) {
      const params = new URLSearchParams({
        marketType,
        orderType: 'quantTop',
        pageSize: String(pageSize)
      });

      if (cursor) {
        params.set('cursor', cursor);
      }

      const url =
        `https://stock.naver.com/api/domestic/market/theme/` +
        `${encodeURIComponent(sourceId)}/stocklist?${params.toString()}`;

      sourceUrls.push(url);

      const payload = await fetchNaverDesktopJson(url);

      if (!payload || !Array.isArray(payload.items)) {
        throw new Error(
          `${marketType}: 응답에 items 배열이 없습니다.`
        );
      }

      const batch = payload.items.map(item => {
        const code = normalizeStockCode(item.itemCode);
        const name = String(item.itemName || '').trim();

        return {
          code,
          name,
          market: marketType
        };
      }).filter(item =>
        isValidStockCode(item.code) &&
        item.name &&
        item.name.length <= 100
      );

      pages++;

      const beforeCount = rows.size;

      for (const item of batch) {
        rows.set(item.code, item);
      }

      const addedCount = rows.size - beforeCount;
      marketReceived += batch.length;

      hasNext = payload.hasNext === true;

      const nextCursor = String(payload.cursor || '');

      pageStats.push({
        market: marketType,
        page: pages,
        received: batch.length,
        added: addedCount,
        uniqueTotal: rows.size,
        hasNext,
        cursor: nextCursor || null,
        sampleCodes: batch.slice(0, 5).map(x => x.code)
      });

      if (!hasNext) {
        break;
      }

      if (!nextCursor) {
        throw new Error(
          `${marketType}: hasNext=true인데 다음 cursor가 없습니다.`
        );
      }

      if (seenCursors.has(nextCursor)) {
        throw new Error(
          `${marketType}: 중복 cursor가 반복되어 페이지 조회를 중단했습니다.`
        );
      }

      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }

    if (hasNext) {
      throw new Error(
        `${marketType}: 최대 페이지 수(${maxPages})에 도달했습니다. ` +
        `일부 종목만 수집되었을 수 있어 결과를 실패 처리합니다.`
      );
    }

    marketStats[marketType] = {
      pages,
      received: marketReceived,
      unique: [...rows.values()].filter(x => x.market === marketType).length
    };
  }

  return {
    rows: [...rows.values()],
    pages: pageStats.length,
    marketStats,
    pageStats,
    sourceUrl: sourceUrls[sourceUrls.length - 1] || '',
    sourceUrls
  };
}

async function importNaverThemes(env, body) {
  const db = requireDb(env);

  const dryRun = body.dryRun !== false;
  const offset = Math.max(0, Math.floor(Number(body.offset) || 0));
  const limit = Math.min(20, Math.max(1, Math.floor(Number(body.limit) || 10)));

  // 네이버 API는 pageSize를 50으로 요청해도 실제로 10개씩 반환할 수 있습니다.
  const pageSize = Math.min(100, Math.max(10, Math.floor(Number(body.pageSize) || 50)));
  // 568번 테마는 11페이지가 필요했던 검증 사례가 있어 기본값을 20으로 설정합니다.
  const maxPages = Math.min(20, Math.max(1, Math.floor(Number(body.maxPages) || 20)));

  const discovered = await discoverNaverThemeList();
  const selected = discovered.themes.slice(offset, offset + limit);

  if (!selected.length) {
    throw new Error(
      `조회할 테마가 없습니다. offset=${offset}, totalThemes=${discovered.themes.length}`
    );
  }

  const stockRows = await db.prepare(
    "SELECT code, name, market, security_type AS securityType, security_verified AS securityVerified FROM stocks WHERE active=1 AND security_verified=1 AND security_type IN ('COMMON','PREFERRED') AND upper(market) IN ('KOSPI','KOSDAQ')"
  ).all();

  const stockMap = new Map(
    (stockRows.results || [])
      .filter(isEligibleCommonStock)
      .map(x => [normalizeStockCode(x.code), x])
  );

  const existingThemes = await db.prepare(
    `SELECT theme_code, theme_name FROM themes WHERE active=1`
  ).all();

  const existingThemeByName = new Map(
    (existingThemes.results || []).map(x => [
      String(x.theme_name || '').trim(),
      x.theme_code
    ])
  );

  const reports = [];
  const mapRows = [];

  for (const theme of selected) {
	  try {
		const members = await discoverNaverThemeMembers(
		  theme.sourceId,
		  pageSize,
		  maxPages
		);

		const matched = members.rows
		  .filter(x => stockMap.has(x.code))
		  .map(x => ({
			...x,
			stockName: stockMap.get(x.code).name
		  }));

		const unmatchedDetails = members.rows
		  .filter(x => !stockMap.has(x.code))
		  .map(x => ({ code: x.code, name: x.name, market: x.market }));

		const themeCode =
		  existingThemeByName.get(theme.name) ||
		  `NV_${themeSlug(theme.name)}_${theme.sourceId}`.slice(0, 80);

		reports.push({
		  sourceId: theme.sourceId,
		  themeName: theme.name,
		  themeCode,
		  found: members.rows.length,
		  matched: matched.length,
		  unmatchedCount: unmatchedDetails.length,
		  unmatchedDetails,
		  pages: members.pages,
		  marketStats: members.marketStats,
		  pageStats: members.pageStats,
		  sourceUrl: members.sourceUrls?.[0] || discovered.sourceUrl,
		  sourceUrls: members.sourceUrls
		});

		for (const m of matched) {
		  mapRows.push({
			themeCode,
			themeName: theme.name,
			code: m.code,
			name: m.stockName
		  });
		}
	  } catch (e) {
		reports.push({
		  sourceId: theme.sourceId,
		  themeName: theme.name,
		  error: e.message
		});
	  }
}

  const uniqueMap = [
    ...new Map(
      mapRows.map(x => [`${x.code}|${x.themeCode}`, x])
    ).values()
  ];

  const totalMembersFound = reports.reduce(
    (sum, x) => sum + (x.found || 0),
    0
  );
  const failedReports = reports.filter(x => x.error);
  const successfulReports = reports.filter(x => !x.error);

  // 중요: 실제 적용 모드에서 일부 테마라도 실패하면 전체 저장을 중단합니다.
  if (!dryRun && failedReports.length > 0) {
    throw new Error(
      `테마 수집 실패 ${failedReports.length}건으로 D1 저장을 차단했습니다. ` +
      failedReports.map(x => `${x.themeName}: ${x.error}`).join(' / ')
    );
  }

  // 모든 테마 수집이 성공한 경우에만 실제 저장합니다.
  if (!dryRun) {
    const now = new Date().toISOString();
    const statements = [];

    for (const t of successfulReports) {
      statements.push(
        db.prepare(`
          INSERT INTO themes(
            theme_code, theme_name, parent_category, description,
            source_name, active, updated_at
          )
          VALUES(
            ?, ?, '네이버 테마',
            '네이버 금융 테마 분류; 사업 연관성 별도 검증 필요',
            'NAVER_THEME', 1, ?
          )
          ON CONFLICT(theme_code) DO UPDATE SET
            theme_name=excluded.theme_name,
            source_name=CASE
              WHEN themes.source_name IS NULL OR themes.source_name=''
              THEN excluded.source_name
              ELSE themes.source_name
            END,
            active=1,
            updated_at=excluded.updated_at
        `).bind(t.themeCode, t.themeName, now)
      );

      statements.push(
        db.prepare(`
          INSERT INTO theme_source_refs(
            source_name, source_id, theme_code, source_url, updated_at
          )
          VALUES('NAVER_THEME', ?, ?, ?, ?)
          ON CONFLICT(source_name, source_id) DO UPDATE SET
            theme_code=excluded.theme_code,
            source_url=excluded.source_url,
            updated_at=excluded.updated_at
        `).bind(
          String(t.sourceId),
          t.themeCode,
          t.sourceUrl || discovered.sourceUrl,
          now
        )
      );
    }

    for (const m of uniqueMap) {
      statements.push(
        db.prepare(`
          INSERT INTO theme_stock_map(
            code, theme_code, relation_type, allocation_weight,
            relevance_grade, evidence_status, source_name,
            evidence_summary, verified_at, active, updated_at
          )
          VALUES(
            ?, ?, 'SECONDARY', 0, 'C', 'MARKET_ONLY',
            'NAVER_THEME',
            '네이버 금융 테마 구성 종목. 시장 분류 참고용이며 사업 연관성은 미검증.',
            NULL, 1, ?
          )
          ON CONFLICT(code, theme_code) DO UPDATE SET
            source_name=CASE
              WHEN theme_stock_map.evidence_status='CONFIRMED'
              THEN COALESCE(NULLIF(theme_stock_map.source_name,''), excluded.source_name)
              ELSE excluded.source_name
            END,
            evidence_status=CASE
              WHEN theme_stock_map.evidence_status='CONFIRMED'
              THEN 'CONFIRMED'
              ELSE 'MARKET_ONLY'
            END,
            evidence_summary=CASE
              WHEN theme_stock_map.evidence_status='CONFIRMED'
              THEN theme_stock_map.evidence_summary
              ELSE excluded.evidence_summary
            END,
            active=1,
            updated_at=excluded.updated_at
        `).bind(m.code, m.themeCode, now)
      );
    }

    if (statements.length) {
      for (let i = 0; i < statements.length; i += 50) {
        await db.batch(statements.slice(i, i + 50));
      }
    }

    await db.prepare(`
      INSERT INTO theme_import_runs(
        source_name, started_at, finished_at, dry_run,
        themes_seen, themes_processed, members_found,
        members_matched, errors_json
      )
      VALUES('NAVER_THEME', ?, ?, 0, ?, ?, ?, ?, ?)
    `).bind(
      now,
      new Date().toISOString(),
      discovered.themes.length,
      successfulReports.length,
      totalMembersFound,
      uniqueMap.length,
      JSON.stringify([])
    ).run();
  }

  return {
    ok: true,
    source: 'NAVER_THEME',
    dryRun,

    universeStocks: stockRows.results?.length || 0,
    eligibleCommonStocks: stockMap.size,

    totalThemesDiscovered: discovered.themes.length,
    selectedThemes: selected.length,
    offset,
    limit,
    pageSize,
    maxPages,

    processedThemes: successfulReports.length,
    failedThemes: failedReports.length,

    memberRows: mapRows.length,
    uniqueMappings: uniqueMap.length,
    unmatchedMembers: reports.reduce((sum, x) => sum + (x.unmatchedCount || 0), 0),
    unmatchedDetails: reports
      .filter(x => x.unmatchedDetails?.length)
      .map(x => ({ sourceId: x.sourceId, themeName: x.themeName, items: x.unmatchedDetails })),
    themeListCoverage: 'UNVERIFIED',
    themeListWarning: '네이버 테마 목록 API의 전체 건수 또는 페이지네이션이 검증되지 않았습니다. 현재 응답에서 발견된 테마만 조회하며, 전체 테마 수집 완료를 의미하지 않습니다.',

    canApply: failedReports.length === 0,
    reports,

    warning:
      '네이버 테마 소속은 시장 분류 데이터입니다. allocation_weight=0 및 MARKET_ONLY로 저장되며, 사업 근거 검증과 배분비중 승인을 마치기 전에는 테마 시장점유율 계산에 사용하지 않습니다.'
  };
}

// ---- Theme mapping and core materials read APIs v1 ---------------------------
async function readThemes(env) {
  const db=requireDb(env);
  const r=await db.prepare(`SELECT theme_code,theme_name,parent_category,description,source_name,updated_at
    FROM themes WHERE active=1 ORDER BY parent_category,theme_name`).all();
  return {ok:true,count:(r.results||[]).length,themes:r.results||[]};
}
async function readThemeStocks(env,url) {
  const db=requireDb(env), themeCode=String(url.searchParams.get('theme_code')||'').trim();
  const code=normalizeStockCode(url.searchParams.get('code')||'');
  const limit=Math.min(500,Math.max(1,Number(url.searchParams.get('limit')||200)));
  let sql=`SELECT m.code,s.name,s.market,m.theme_code,t.theme_name,m.relation_type,
      m.allocation_weight,m.relevance_grade,m.evidence_status,m.source_name,
      m.evidence_summary,m.verified_at,m.valid_from,m.valid_to,
      q.price,q.change_pct,q.trade_value,q.updated_at AS quote_updated_at
    FROM theme_stock_map m
    INNER JOIN stocks s ON s.code=m.code
    INNER JOIN themes t ON t.theme_code=m.theme_code
    LEFT JOIN stock_quotes q ON q.code=m.code
    WHERE m.active=1 AND t.active=1 AND s.active=1 AND s.security_verified=1 AND s.security_type IN ('COMMON','PREFERRED') AND upper(s.market) IN ('KOSPI','KOSDAQ')`;
  const args=[];
  if(themeCode){sql+=' AND m.theme_code=?';args.push(themeCode);}
  if(code){sql+=' AND m.code=?';args.push(code);}
  sql+=' ORDER BY m.relevance_grade ASC,m.allocation_weight DESC,COALESCE(q.trade_value,0) DESC LIMIT ?';args.push(limit);
  const r=await db.prepare(sql).bind(...args).all();
  return {ok:true,count:(r.results||[]).length,themeCode:themeCode||null,code:code||null,rows:r.results||[]};
}
async function readMaterials(env,url) {
  const db=requireDb(env),code=normalizeStockCode(url.searchParams.get('code')||'');
  if(!code){
    const r=await db.prepare(`SELECT material_code,material_name,base_grade,description,verification_rule
      FROM material_types WHERE active=1 ORDER BY base_grade DESC,material_code`).all();
    return {ok:true,count:(r.results||[]).length,materials:r.results||[]};
  }
  const r=await db.prepare(`SELECT sm.code,sm.material_code,mt.material_name,mt.base_grade,sm.title,
      sm.source_type,sm.source_url,sm.published_at,sm.verified_at,sm.verification_status,
      sm.material_score,sm.expires_at,sm.notes
    FROM stock_materials sm INNER JOIN material_types mt ON mt.material_code=sm.material_code
    INNER JOIN stocks s ON s.code=sm.code
    WHERE sm.code=? AND s.active=1 AND s.security_verified=1 AND s.security_type IN ('COMMON','PREFERRED') AND upper(s.market) IN ('KOSPI','KOSDAQ') ORDER BY sm.published_at DESC LIMIT 100`).bind(code).all();
  return {ok:true,code,count:(r.results||[]).length,materials:r.results||[]};
}
// -----------------------------------------------------------------------------

export default {async fetch(request,env){const url=new URL(request.url);if(request.method==='OPTIONS')return new Response(null,{status:204,headers:corsHeaders(request)});if(env.DB&&url.pathname!=='/'&&url.pathname!=='/health'){try{await ensureSecuritySchema(env.DB);}catch(e){return json({ok:false,error:`종목 분류 스키마 준비 실패: ${e.message}`},request,500);}}if(url.pathname==='/api/themes/import'&&request.method==='POST'){try{const body=await request.json();if(body.dryRun===false){const token=String(request.headers.get('Authorization')||'').replace(/^Bearer\s+/i,'');if(!env.THEME_ADMIN_TOKEN||token!==env.THEME_ADMIN_TOKEN)return json({ok:false,error:'테마 가져오기 적용에는 THEME_ADMIN_TOKEN 인증이 필요합니다.'},request,401);}return json(await importNaverThemes(env,body),request);}catch(e){return json({ok:false,error:e.message},request,502);}}if(request.method!=='GET')return json({ok:false,error:'Method Not Allowed'},request,405);
  if(url.pathname==='/'||url.pathname==='/health')return json({ok:true,service:'chama-market-worker',version:'v11.4-common-preferred-policy' ,endpoints:['/health','/api/data/status','/api/data/universe/validate?market=KOSPI&codes=000990','/api/data/coverage','/api/data/sync?type=universe','/api/data/sync?type=quotes&limit=50','/api/data/sync?type=candles&provider=naver-legacy&code=005930&days=700&limit=1','/api/data/sync?type=indicators&limit=50','/api/data/sync?type=indicators-repair&limit=1&minCandles=120&afterCode=000000','/api/data/quote?code=005930','/api/data/candles?code=005930','/api/data/indicators?code=005930','/api/themes','/api/themes/stocks?theme_code=SEMICONDUCTOR','POST /api/themes/import (dryRun or authenticated apply)','/api/materials','/api/materials?code=005930','/api/kis/test','/api/market?codes=232140,007810','/api/analysis?codes=232140','/api/screener?market=ALL&top=10'],dataEngine:{d1:!!env.DB,kis:!!(env.KIS_APP_KEY&&env.KIS_APP_SECRET),mode:env.KIS_MODE||'paper'},securityPolicy:'KOSPI/KOSDAQ COMMON+PREFERRED only; unverified excluded',time:new Date().toISOString()},request);
  if(url.pathname==='/api/themes'){try{return json(await readThemes(env),request);}catch(e){return json({ok:false,error:e.message},request,500);}}
  if(url.pathname==='/api/themes/stocks'){try{return json(await readThemeStocks(env,url),request);}catch(e){return json({ok:false,error:e.message},request,500);}}
  if(url.pathname==='/api/materials'){try{return json(await readMaterials(env,url),request);}catch(e){return json({ok:false,error:e.message},request,500);}}
  if(url.pathname==='/api/data/status'){try{return json({ok:true,...await dataStatus(env)},request);}catch(e){return json({ok:false,error:e.message},request,500);}}
  if(url.pathname==='/api/data/universe/validate'){try{return json(await validateUniverseMaster(env,url),request);}catch(e){return json({ok:false,error:e.message},request,502);}}
  if(url.pathname==='/api/data/coverage'){try{return json(await dataCoverage(env),request);}catch(e){return json({ok:false,error:e.message},request,500);}}
  if(url.pathname==='/api/data/audit'){try{return json(await dataAudit(env,url),request);}catch(e){return json({ok:false,error:e.message},request,500);}}
  if(url.pathname==='/api/data/sync'){try{return json(await syncData(env,url),request);}catch(e){return json({ok:false,error:e.message},request,502);}}
  if(['/api/data/quote','/api/data/candles','/api/data/indicators'].includes(url.pathname)){try{return json(await dataRead(env,url,url.pathname),request);}catch(e){return json({ok:false,error:e.message},request,400);}}
  if(url.pathname==='/api/kis/test'){try{const code=normalizeStockCode(url.searchParams.get('code')||'005930');await requireEligibleStock(env,code);const q=await kisQuote(env,code);return json({ok:true,authenticated:true,quote:q,mode:env.KIS_MODE||'paper'},request);}catch(e){return json({ok:false,error:e.message},request,502);}}
  const isMarket=['/api/market','/api/market/'].includes(url.pathname), isAnalysis=['/api/analysis','/api/analysis/'].includes(url.pathname), isScreen=['/api/screener','/api/screener/'].includes(url.pathname); if(!isMarket&&!isAnalysis&&!isScreen)return json({ok:false,error:'Not Found'},request,404);
  if(isScreen){const market=(url.searchParams.get('market')||'ALL').toUpperCase();const top=Math.min(10,Math.max(1,Number(url.searchParams.get('top')||10)));let cfg={};const raw=url.searchParams.get('config');if(raw){try{cfg=JSON.parse(decodeURIComponent(raw));}catch(e){return json({ok:false,error:'config JSON 형식 오류'},request,400);}}try{return json({ok:true,...await screenMarket(market,top,cfg)},request);}catch(e){return json({ok:false,error:e?.message||String(e)},request,502);}}
  const codes=[...new Set((url.searchParams.get('codes')||'').split(',').map(normalizeStockCode).filter(isValidStockCode))];if(!codes.length)return json({ok:false,error:'codes parameter is required'},request,400);if(codes.length>80)return json({ok:false,error:'Too many codes'},request,400);
  if(isAnalysis)return json({ok:true,quotes:await getAnalysis(codes,env),time:new Date().toISOString(),note:'검증된 코스피·코스닥 보통주/우선주만 Naver realtime + daily chart로 조회합니다.'},request);
  return json({ok:true,quotes:await getQuotes(codes,env),time:new Date().toISOString()},request);
}};
