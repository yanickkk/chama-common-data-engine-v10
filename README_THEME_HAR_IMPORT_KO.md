# 테마 상세 HAR 데이터 적재 v1.1

## 목적
기존 Supabase `app_data` 응답을 D1에 원문 보존 방식으로 적재하는 1차 파이프라인입니다. 원본 JSON을 임의로 정규화하지 않고 `theme_source_records.payload_json`에 보존합니다. 실제 UI 필드와 대조한 뒤 조회용 테이블/API로 정규화합니다.

## 포함 파일
- `003_theme_source_archive.sql`: 원문 보존용 D1 테이블과 인덱스
- `scripts/har-to-theme-sql.mjs`: HAR에서 허용된 테마 데이터만 추출해 D1 SQL 파일로 분할

## 실제 HAR 분석 결과
GitHub에 업로드된 `reference/theme-detail/02_theme_detail.har.txt` 원본(약 3.3MB)을 직접 파싱해 변환 규칙을 검증했습니다.

- HAR 전체 요청: 46건
- Supabase `app_data` 요청: 20건
- 허용 목록에 해당하는 고유 원문 레코드: 227건
- 날짜 범위: 2025-12-24 ~ 2026-11-20
- 1건의 HTTP 406 응답은 제외했고, 사용자 프로필·인증·관심종목 등은 제외했습니다.

| 데이터 키 | 레코드 |
|---|---:|
| `cm_calendar_daily` | 216 |
| `cm_schedule_week_2026-11-16` | 5 |
| `cm_keyword_map` | 1 |
| `cm_theme_history` | 1 |
| `cm_theme_issue_auto_2026-11-17` | 1 |
| `cm_news_material_2026-11-17` | 1 |
| `cm_step3_date_2026-10-28` | 1 |
| `cm_step3_date_2026-11-13` | 1 |
| **합계** | **227** |

원본 응답의 실제 구조는 PostgREST 요청 URL의 `key=eq...`에 키가 있고, 응답의 `value`가 JSON 문자열인 형태였습니다. 날짜별 데이터는 객체의 날짜 키를 기준으로 분리합니다. 이 구조에 맞춰 변환기를 수정했습니다.

## 현재 허용 데이터 키
- `cm_calendar_daily`
- `cm_theme_history`
- `cm_theme_issue_auto_YYYY-MM-DD`
- `cm_schedule_week_YYYY-MM-DD`
- `cm_step3_date_YYYY-MM-DD`
- `cm_keyword_map`
- `cm_news_material_YYYY-MM-DD`

인증, 사용자 프로필, 세션, 관심종목 등은 추출하지 않습니다. HAR 파일에는 인증 헤더가 포함될 수 있으므로 외부 공유 시 반드시 제거하거나 키를 폐기해야 합니다.

## 1. HAR 파일 변환 (PC 로컬)
프로젝트 루트에서 Node.js 18 이상을 사용합니다.

```powershell
node .\\scripts\\har-to-theme-sql.mjs .\\reference\\theme-detail\\02_theme_detail.har.txt --out .\\generated-theme-data
```

`generated-theme-data` 폴더에 40만 바이트 이하 단위의 SQL 파일과 `import-report.json`이 생성됩니다. 보고서에서 키별 건수와 날짜 범위를 확인합니다.

## 2. 로컬 D1에 스키마 적용
현재 저장소의 `wrangler.jsonc`에서 D1 바인딩은 `DB`, 데이터베이스 이름은 `chama-market-db`로 확인했습니다.

```powershell
npx wrangler d1 execute chama-market-db --local --file=./003_theme_source_archive.sql
```

## 3. 로컬 D1에 데이터 적재

```powershell
Get-ChildItem .\\generated-theme-data\\theme-source-*.sql | Sort-Object Name | ForEach-Object {
  npx wrangler d1 execute chama-market-db --local --file=$_.FullName
  if ($LASTEXITCODE -ne 0) { throw "D1 import failed: $($_.Name)" }
}
```

## 4. 적재 건수 확인

```powershell
npx wrangler d1 execute chama-market-db --local --command="SELECT source_key, COUNT(*) AS rows, MIN(source_date) AS min_date, MAX(source_date) AS max_date FROM theme_source_records GROUP BY source_key ORDER BY source_key;"
```

## 안전 및 한계
- 이번 단계는 원문 데이터 보존 계층입니다. 기존 테마 매핑·종목·시세·캔들·지표 테이블은 변경하지 않습니다.
- HAR는 캡처 시점의 스냅샷입니다. 최신 데이터 자동 갱신을 의미하지 않습니다.
- HAR 전체 변환 규칙은 실제 응답 구조를 기준으로 검증했지만, 이 대화 환경에서 사용자 PC의 로컬 D1 적재까지 실행한 것은 아닙니다.
- **운영 D1에는 적용하지 않았습니다.** 로컬 D1에서 적재 결과를 검증한 뒤 다음 단계로 진행합니다.
- Worker 조회 API 및 HTML UI 연결은 원문 필드의 의미와 조회 패턴을 검증한 다음 별도 변경으로 진행합니다.
