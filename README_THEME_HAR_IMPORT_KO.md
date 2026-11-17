# 테마 상세 HAR 데이터 적재 v1.0

## 목적
기존 Supabase `app_data` 응답을 D1에 원문 보존 방식으로 적재하기 위한 1차 파이프라인입니다. 원본 JSON 필드를 추측해 변형하지 않고, `theme_source_records.payload_json`에 그대로 저장합니다. 이 방식으로 데이터 손실을 막은 뒤 실제 UI 필드와 대조해 정규화할 수 있습니다.

## 포함된 파일
- `003_theme_source_archive.sql`: 원문 보존용 D1 테이블과 인덱스 추가
- `scripts/har-to-theme-sql.mjs`: HAR에서 허용된 테마 데이터 키만 추출해 D1 SQL 파일로 분할

## 현재 허용 데이터 키
- `cm_calendar_daily`
- `cm_theme_history`
- `cm_theme_issue_auto_YYYY-MM-DD`
- `cm_schedule_week_YYYY-MM-DD`
- `cm_step3_date_YYYY-MM-DD`
- `cm_keyword_map`
- `cm_news_material_YYYY-MM-DD`

인증, 사용자 프로필, 세션, 관심종목 등은 추출하지 않습니다. HAR 파일 자체에는 인증 헤더가 포함될 수 있으므로 외부 공유 시 반드시 제거해야 합니다.

## 1. HAR 파일 변환 (PC 로컬)
프로젝트 루트에서 Node.js 18 이상을 사용합니다.

```powershell
node .\scripts\har-to-theme-sql.mjs .\reference\theme-detail\02_theme_detail.har.txt --out .\generated-theme-data
```

`generated-theme-data` 폴더에 40만 바이트 이하 단위의 SQL 파일과 `import-report.json`이 생성됩니다. 보고서에서 키 목록, 추출 건수, 날짜 범위를 먼저 확인합니다. `No allowlisted app_data rows found`가 나오면 D1에 적용하지 말고 HAR의 응답 구조를 먼저 점검합니다.

## 2. 로컬 D1에 스키마 적용

```powershell
npx wrangler d1 execute chama-market-db --local --file=./003_theme_source_archive.sql
```

## 3. 로컬 D1에 데이터 적재

```powershell
Get-ChildItem .\generated-theme-data\theme-source-*.sql | Sort-Object Name | ForEach-Object {
  npx wrangler d1 execute chama-market-db --local --file=$_.FullName
  if ($LASTEXITCODE -ne 0) { throw "D1 import failed: $($_.Name)" }
}
```

## 4. 적재 건수 확인

```powershell
npx wrangler d1 execute chama-market-db --local --command="SELECT source_key, COUNT(*) AS rows, MIN(source_date) AS min_date, MAX(source_date) AS max_date FROM theme_source_records GROUP BY source_key ORDER BY source_key;"
```

## 안전 및 한계
- 이번 작업은 **원문 데이터 보존 계층**입니다. 원본의 각 키별 필드 의미를 완전히 검증하기 전에는 이를 실시간 정보나 확정된 종목-테마 관계로 해석하지 않습니다.
- HAR는 캡처 시점의 데이터입니다. 날짜가 포함된 키는 그 날짜의 스냅샷일 뿐 최신 데이터 자동 갱신을 의미하지 않습니다.
- 현재 변환기는 HAR의 Supabase `app_data` 응답 중 allowlist에 포함된 키만 대상으로 합니다. 원본 JSON 응답 구조가 다른 경우 변환기는 0건 처리로 성공하지 않고 명시적으로 실패합니다.
- **운영 D1에는 적용하지 않았습니다.** 먼저 로컬 D1에서 추출 건수와 payload를 검증해야 합니다.
- Worker 조회 API 및 HTML UI 연결은 이 데이터 구조를 로컬에서 검증한 다음 별도 변경으로 진행합니다.
