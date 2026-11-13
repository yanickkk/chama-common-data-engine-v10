# 차마 족보 공통 데이터 엔진 v10.7
## 네이버 Finance siseJson 과거 일봉 수집 경로 추가

### 변경 사항
- 기존 v10.6 `api.stock.naver.com/chart/domestic/item/...` 수집 경로를 유지했습니다.
- 신규 `provider=naver-legacy` 옵션을 추가했습니다.
- 신규 경로는 `https://api.finance.naver.com/siseJson.naver`에 `requestType=1`, `startTime`, `endTime`, `timeframe=day`를 지정해 과거 날짜 범위를 직접 조회합니다.
- 700일 기본 수집 기간을 180일 달력 구간으로 분할 조회합니다.
- 레거시 응답의 JavaScript 배열 문자열을 날짜/OHLCV로 파싱합니다.
- 페이지별 요청 시작/종료일, HTTP 상태, 응답 길이, 파싱 건수, 범위 내 저장 후보 건수, 첫/마지막 날짜를 응답 `diagnostics`에 표시합니다.
- 수집 데이터의 `source`는 `NAVER-LEGACY`로 기록합니다.
- 기존 D1 테이블, API 경로, KIS 처리, 지표 계산 로직은 변경하지 않았습니다.
- 기존 `provider=naver`는 v10.6의 `NAVER-PAGED` 경로로 남겨 비교/롤백할 수 있습니다.

### 배포
1. 현재 Worker 프로젝트와 `index.js`, 실제 `wrangler.jsonc`를 백업합니다.
2. 이 패키지의 `index.js`만 기존 Worker 프로젝트에 복사합니다.
3. 기존 `wrangler.jsonc`는 교체하지 마세요. 첨부받은 설정 파일에는 `database_name`과 `database_id`가 비어 있습니다. 실제 운영 D1 연결 설정을 유지해야 합니다.
4. 기존 Worker에 등록된 `KIS_APP_KEY`, `KIS_APP_SECRET` Secrets는 다시 입력하거나 삭제하지 마세요.
5. 프로젝트 폴더에서 `npx wrangler deploy`를 실행합니다.
6. `/health`에서 `version: v10.7-naver-legacy-sisejson`을 확인합니다.

### 단일 종목 테스트 (전체 배치 전에 필수)
아래 요청은 삼성전자 한 종목만 대상으로 합니다.

`https://실제-worker주소/api/data/sync?type=candles&provider=naver-legacy&code=005930&days=700&limit=1`

정상 응답에서 확인할 항목:
- `provider`: `NAVER-LEGACY`
- `processed`: 1
- `failed`: 0
- `candlesSaved`: 250 이상을 기대하되 실제 API 응답에 따라 달라질 수 있음
- `diagnostics[0].pageCount`: 여러 날짜 구간 호출 수
- `diagnostics[0].pages[]`: 각 구간의 `startDate`, `endDate`, `httpStatus`, `parsedRows`, `acceptedRows`, `firstDate`, `lastDate`
- `diagnostics[0].oldestDate`: 가장 오래된 확보 날짜

저장 데이터 확인:
`https://실제-worker주소/api/data/candles?code=005930&limit=1000`

`source`가 `NAVER-LEGACY`인 데이터의 날짜 범위와 행 개수를 확인합니다.

### 전체 배치
단일 종목 테스트에서 과거 데이터가 충분히 확보되고 페이지별 날짜가 서로 다른 범위로 정상 응답한 경우에만 실행합니다.

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\run-data-batches.ps1 -WorkerBaseUrl "https://실제-worker주소" -TotalStocks 4008 -Days 700 -StartOffset 0 -SkipIndicators
```

일봉 배치 완료 후 지표를 계산합니다.

```powershell
.\run-indicators-only.ps1 -WorkerBaseUrl "https://실제-worker주소" -TotalStocks 4008 -StartOffset 0 -BatchSize 5 -MinCandles 120
```

### 주의
- 이 네이버 API는 비공식 레거시 엔드포인트이며 서비스 계약/호출량이 보장되지 않습니다.
- 250개 이상의 데이터 확보를 보장하지 않습니다. 실제 `diagnostics`를 확인한 뒤 판단합니다.
- 이번 테스트에서는 전체 4,008개 종목 배치를 실행하지 마세요.
- 기존 D1 데이터는 삭제하지 않습니다. 동일 종목/날짜는 기존 `ON CONFLICT` 갱신 방식으로 저장됩니다.
- `candlesSaved`는 저장 시도한 행 수이며 신규 삽입 수와 동일하지 않을 수 있습니다.
