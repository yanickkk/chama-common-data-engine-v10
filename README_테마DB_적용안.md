# 차마존 테마 매핑 수집 패키지 v1.1

## 이번 버전에서 추가된 기능
- 기존 제출본 `index(3).js`를 기반으로 생성한 테마 조회 Worker(v1.0)의 후속 버전입니다.
- 네이버 금융의 국내 테마 목록 및 테마별 구성 종목을 수집하는 관리자용 가져오기 API를 추가했습니다.
- 기존 시세·일봉·지표·차마존/CM API는 유지합니다.
- 자동 수집된 테마 편입은 `MARKET_ONLY`, 등급 C, 배분 가중치 0으로 저장합니다. 사업 근거를 확인하고 관리자 승인하기 전에는 시장점유율 계산에 사용하지 않습니다.

## 파일
- `index_theme_v2.js`: 신규 Worker 소스. 기존 `index.js`를 백업한 후 배포용 파일로 교체해 사용합니다.
- `001_theme_mapping.sql`: 테마·재료 스키마와 초기 사전, 수집 이력 테이블을 추가하는 D1 마이그레이션.
- `theme_stock_mapping_template.csv`: 수동 검증/보정용 CSV 양식.

## 안전 원칙
1. 기존 `stocks`, `stock_quotes`, `stock_daily_candles`, `stock_indicators` 테이블을 변경하거나 삭제하지 않습니다.
2. 테마 목록은 분류 사전입니다. 테마 구성 종목은 시장에서 통용되는 분류 후보이지, 회사의 실제 사업 연관성을 확정한 자료가 아닙니다.
3. 네이버 테마 구성 종목은 `evidence_status='MARKET_ONLY'`, `relevance_grade='C'`, `allocation_weight=0`으로 저장합니다.
4. 종목별 대표/보조 테마 배분 가중치 합계가 1.0(100%)이 되도록 사업 근거를 확인한 뒤 승인해야 합니다.
5. KRX/KIS/DART의 자료는 각 API의 이용 조건을 확인하고 사용합니다. 금융위원회_KRX상장종목정보 데이터는 공공데이터포털 설명상 공공누리 제4유형(상업적 이용금지·변경금지)이므로 상업적 서비스에 무단 사용하지 않습니다.
6. 네이버 front-api 경로는 공개 웹 화면에서 사용하는 비공식/비문서화 경로로, 변경·차단될 수 있습니다. 수집 실패 시 빈 매핑으로 성공 처리하지 않고 오류를 반환합니다.

## 적용 전 백업
`wrangler.jsonc`의 `database_name`이 `chama-market-db`인지 확인한 후 프로젝트 폴더에서 실행합니다.

```powershell
npx wrangler d1 export chama-market-db --remote --output backup_before_theme.sql
npx wrangler d1 execute chama-market-db --remote --file=./001_theme_mapping.sql
```

마이그레이션은 추가형이며 기존 주식 데이터 테이블을 변경하지 않습니다. 이미 적용된 경우 `CREATE TABLE IF NOT EXISTS` 및 `INSERT OR IGNORE`로 재실행할 수 있습니다.

## Worker 교체 및 배포
1. 현재 `index.js`를 `index_before_theme_v11.js` 등으로 백업합니다.
2. `index_theme_v2.js`를 프로젝트의 `index.js`로 복사합니다.
3. 기존 `wrangler.jsonc`는 그대로 유지합니다. 특히 D1 binding `DB`, `database_name`, `database_id`, KIS 설정을 임의로 바꾸지 않습니다.
4. 관리자 적용용 토큰을 Cloudflare Worker secret으로 등록합니다.

```powershell
npx wrangler secret put THEME_ADMIN_TOKEN
```

긴 임의 문자열을 입력합니다. 이 토큰은 브라우저 코드에 넣지 말고 관리자 PowerShell에서만 사용합니다.

5. 구문 검사 및 배포:

```powershell
node --check .\index.js
npx wrangler deploy
```

## 1단계: 연결 상태 확인

```powershell
Invoke-RestMethod "https://chama-market-proxy.yanick-lee.workers.dev/health"
Invoke-RestMethod "https://chama-market-proxy.yanick-lee.workers.dev/api/themes"
```

## 2단계: 네이버 테마 수집 사전 점검(dry-run)

```powershell
$body = @{ dryRun = $true; offset = 0; limit = 10; pageSize = 100; maxPages = 10 } | ConvertTo-Json
Invoke-RestMethod -Method Post `
  -Uri "https://chama-market-proxy.yanick-lee.workers.dev/api/themes/import" `
  -ContentType "application/json" -Body $body
```

이 단계는 외부 테마 목록/종목을 조회하고 D1의 활성 KOSPI/KOSDAQ 보통주와 매칭한 결과만 보여줍니다. D1에는 저장하지 않습니다.

응답에서 다음을 확인합니다.
- `totalThemesDiscovered`: 네이버에서 발견한 테마 수
- `eligibleCommonStocks`: D1 내 활성 KOSPI/KOSDAQ 보통주 수
- `processedThemes`: 처리된 테마 수
- `uniqueMappings`: 중복 제거된 종목-테마 연결 수
- `reports[].error`: 수집 실패 테마

`processedThemes=0` 또는 테마 추출 오류가 나오면 적용하지 말고 응답 오류를 먼저 점검합니다.

## 3단계: 실제 저장

```powershell
$token = Read-Host "THEME_ADMIN_TOKEN"
$body = @{ dryRun = $false; offset = 0; limit = 10; pageSize = 100; maxPages = 10 } | ConvertTo-Json
Invoke-RestMethod -Method Post `
  -Uri "https://chama-market-proxy.yanick-lee.workers.dev/api/themes/import" `
  -Headers @{ Authorization = "Bearer $token" } `
  -ContentType "application/json" -Body $body
```

네이버 테마가 10개를 초과하면 `offset=10`, `offset=20`처럼 증가시켜 나머지 묶음을 반복합니다. 매번 dry-run으로 오류가 없는지 먼저 확인한 뒤 실제 저장합니다. 한 요청은 최대 20개 테마까지 처리합니다.

## 4단계: 저장 결과 확인

```powershell
Invoke-RestMethod "https://chama-market-proxy.yanick-lee.workers.dev/api/themes"
Invoke-RestMethod "https://chama-market-proxy.yanick-lee.workers.dev/api/themes/stocks?limit=20"
Invoke-RestMethod "https://chama-market-proxy.yanick-lee.workers.dev/api/themes/stocks?theme_code=SEMICONDUCTOR&limit=100"
Invoke-RestMethod "https://chama-market-proxy.yanick-lee.workers.dev/api/materials"
```

테마 코드가 기존 사전 이름과 일치하면 기존 코드(예: `SEMICONDUCTOR`)를 재사용하고, 그 외에는 `NV_테마명_네이버ID` 형식으로 생성합니다.

## 현재 범위와 한계
- 수집 대상은 D1 `stocks` 테이블에 이미 들어 있는 활성 KOSPI/KOSDAQ 종목과 기존 전체시장 동기화에서 시장 코드가 통합값 `KRX`로 저장된 종목입니다. 현재 Worker의 전체시장 동기화는 `marketType=ALL` 목록을 `KRX`로 기록할 수 있으므로 `KRX`도 매칭 대상에 포함합니다. 먼저 `/api/data/status`에서 종목 수를 확인하고, 전체 유니버스가 적재되어 있는지 확인해야 합니다.
- 이름 기반으로 ETF·ETN·스팩·우선주 후보를 제외합니다. 관리·거래정지 상태는 현재 종목 마스터에 별도 상태 필드가 없으면 완전하게 판정할 수 없습니다. 해당 제외 조건을 엄격히 적용하려면 KRX/KIS 상태 데이터를 추가 수집해 별도 종목 상태 테이블로 결합해야 합니다.
- 수집된 네이버 테마는 사업 연관성 검증이 아닙니다. DART 사업보고서, 계약 공시, 기업 공식 자료를 추가 확인한 뒤 A/B/C 등급과 allocation_weight를 승인해야 합니다.
- 네이버 테마 종목 API는 비공식 경로이며 응답 필드가 바뀔 수 있습니다. 이번 Worker는 주요 필드 후보를 폭넓게 인식하지만, 실제 운영 전 dry-run을 필수로 합니다.
- KRX 상장종목정보는 데이터 기준일이 일 단위로 갱신될 수 있고, 공공데이터포털에 표시된 라이선스가 상업적 이용을 제한합니다. 상업 서비스에 활용할 경우 KRX Data Marketplace의 정식 이용 조건을 확인해야 합니다.

## API 변경 요약
- `GET /api/themes`
- `GET /api/themes/stocks?theme_code=...&limit=...`
- `GET /api/materials`
- `GET /api/materials?code=005930`
- `POST /api/themes/import` — dry-run은 인증 없이 가능, 실제 저장은 `Authorization: Bearer <THEME_ADMIN_TOKEN>` 필요.

기존 `/api/market`, `/api/analysis`, `/api/screener`, `/api/data/*` 엔드포인트는 유지합니다.
