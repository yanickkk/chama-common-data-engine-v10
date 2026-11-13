# Windows 배포 순서 (초보자용)

1. ZIP 압축을 풉니다.
2. 폴더에서 주소창에 `cmd`를 입력하고 Enter를 눌러 명령 프롬프트를 엽니다.
3. Node.js LTS가 없다면 먼저 설치합니다.
4. 다음 명령을 실행합니다.

```bat
npm install
npx wrangler login
npx wrangler d1 create chama-market-db
```

5. D1 생성 결과에서 `database_id`를 복사합니다.
6. `wrangler.jsonc`를 메모장/VS Code로 열고 `REPLACE_WITH_D1_DATABASE_ID`를 실제 ID로 바꿉니다.
7. DB 테이블을 생성합니다.

```bat
npx wrangler d1 execute chama-market-db --remote --file=./schema.sql
```

8. KIS Developers에서 발급받은 모의투자 앱키와 앱시크릿을 각각 등록합니다.

```bat
npx wrangler secret put KIS_APP_KEY
npx wrangler secret put KIS_APP_SECRET
```

각 명령을 실행하면 입력 프롬프트가 나오므로 값을 붙여넣고 Enter를 누릅니다. 채팅창이나 소스코드에 키를 입력하지 마세요.

9. 배포합니다.

```bat
npx wrangler deploy
```

10. 출력된 `workers.dev` 주소를 브라우저에서 열어 `/health`와 `/api/data/status`를 확인합니다.
11. KIS 연결 테스트:

```text
https://YOUR-WORKER.workers.dev/api/kis/test?code=005930
```

12. 초기 데이터 수집은 아래 순서로 진행합니다.

```text
/api/data/sync?type=universe&market=ALL
/api/data/sync?type=quotes&limit=50&offset=0
/api/data/sync?type=quotes&limit=50&offset=50
/api/data/sync?type=candles&limit=20&offset=0&days=700
/api/data/sync?type=indicators&limit=50&offset=0
```

다음 배치는 offset을 50 또는 20씩 증가시킵니다. 현재가/일봉 수집은 외부 API 호출 제한 때문에 배치로 나눠 실행합니다.
