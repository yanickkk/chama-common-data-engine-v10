# 일봉 과거 데이터 보충 작업

## 목적

D1에 저장된 활성 보통주·우선주 가운데 일봉이 120거래일 미만인 종목의 과거 데이터를 순차적으로 보충합니다. 한 번의 Worker 요청은 종목 1개만 처리하며, 작업 커서와 일일 예산 사용량은 D1에 저장됩니다.

## 안전 설계

- 60~119거래일 종목을 먼저 처리하고, 다음 단계에서 0~59거래일 종목을 처리합니다.
- 종목별 700일 구간을 네이버 일봉 원본에서 조회합니다.
- 기존 일봉과 비교해 신규·변경 행만 저장합니다.
- 120거래일 이상 확보된 종목에 대해서만 지표를 계산합니다.
- 기존 일봉·지표를 삭제하지 않습니다.
- 종목코드 커서를 D1에 저장하므로 브라우저/PowerShell을 닫아도 이어서 진행할 수 있습니다.
- 종목 처리 중 오류가 나면 커서를 이동하지 않고 오류 상태로 멈춥니다. 원인 확인 후 resume 하면 같은 종목부터 재시도합니다.
- 한 종목당 최대 1,100행의 D1 쓰기를 예약하고, 이 작업의 UTC 일일 예약 상한은 70,000행입니다. 작업 목록 생성에 필요한 초기 쓰기 예약을 제외하면, 실제 종목 처리량은 하루 약 60종목 수준입니다.
- 일일 예산은 UTC 날짜가 바뀌면 초기화됩니다.

> 70,000행은 이 백필 작업 자체의 예약 상한입니다. Cloudflare 계정의 다른 Worker/D1 쓰기까지 합산해 보장하는 절대 상한은 아닙니다. 다른 기능의 쓰기를 위한 여유분을 남기도록 100,000행보다 낮게 설정했습니다. 다른 작업이 동시에 많은 쓰기를 수행하면 D1 전체 일일 한도에 먼저 도달할 수 있습니다.

## API

| 동작 | 주소 |
|---|---|
| 상태 조회 | `/api/data/history-job?action=status` |
| 처음부터 시작 | `/api/data/history-job?action=start` |
| 다음 종목 1개 처리 | `/api/data/history-job?action=step` |
| 중단 후 이어서 진행 | `/api/data/history-job?action=resume` |
| 안전 중단 | `/api/data/history-job?action=pause` |

작업 상태는 `idle`, `running`, `paused`, `budget_wait`, `error`, `completed` 중 하나입니다.

## Windows PowerShell 실행

1. GitHub 브랜치의 `scripts/run-history-backfill.ps1` 파일을 내려받습니다.
2. PowerShell에서 파일이 있는 폴더로 이동합니다.
3. 아래 명령으로 25종목씩 실행합니다.

```powershell
powershell -ExecutionPolicy Bypass -File .\run-history-backfill.ps1 -MaxSteps 25 -DelaySeconds 2
```

다음 실행 때도 같은 명령을 사용하면 D1에 저장된 커서부터 이어집니다. 일일 예산에 도달하면 `budget_wait` 상태가 되므로 UTC 날짜가 바뀐 뒤 같은 명령을 다시 실행합니다.

처음부터 작업 커서를 초기화하려는 경우에만 `-StartFresh`를 사용합니다. 이 옵션도 데이터를 삭제하지는 않지만 이미 처리한 종목을 다시 확인하므로 불필요한 D1 쓰기가 발생할 수 있습니다.

## 배포 및 검증

1. 브랜치를 로컬로 가져옵니다.
2. `node --check index.js`로 문법을 확인합니다.
3. `npx wrangler deploy`로 Worker를 배포합니다.
4. `/health`에서 `v11.5-resumable-history-backfill` 버전을 확인합니다.
5. `/api/data/history-job?action=status`를 호출해 D1에 작업 상태 테이블이 자동 생성되었는지 확인합니다.
6. PowerShell 스크립트를 실행합니다.
7. 작업 후 `/api/data/coverage`와 `/api/data/audit?minCandles=120`으로 결과를 확인합니다.

## 참고

- 이 기능은 기존 `/api/data/sync?type=candles` 동작을 변경하지 않습니다.
- `buildChama()` 및 `cmMatches()` 판정 로직은 수정하지 않습니다.
- 120거래일 미만 잔여 종목은 상장 후 거래일 자체가 짧거나 원본 데이터가 충분하지 않을 수 있으므로 최종 감사 결과로 개별 확인해야 합니다.
