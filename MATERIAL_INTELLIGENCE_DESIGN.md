# 재료분석 공통 데이터 설계 v1

작성일: 2026-11-20
대상 저장소: chama-common-data-engine-v10
기준 브랜치: main
개발 브랜치: feat/material-intelligence-foundation-20261120

## 1. 설계 원칙

1. 기존 차마존(buildChama), CM(cmMatches), 점수·등급·TOP10 선정 로직은 수정하지 않는다.
2. 재료분석은 독립 테이블과 독립 API로 구현한다. 기존 종목 선정 결과에는 영향을 주지 않는다.
3. 종목 연결은 검증된 KOSPI/KOSDAQ COMMON/PREFERRED 종목만 허용한다.
4. 원문 출처, 원문 URL, 원문 식별자, 수집시각, 분석 버전과 근거를 보존한다.
5. AI 결과는 확정 사실이 아니라 보조정보다. 낮은 신뢰도/모호한 경우 자동 확정하지 않고 검수대기 처리한다.
6. DART와 NAVER 검색 결과의 사용권한은 분리한다. NAVER API HUB 검색 결과를 AI 입력, 학습, 평가, 분류, 요약, DB 영구저장에 사용하지 않는다.

## 2. API 사용 가능 범위와 주의사항

### DART Open API

- 공시검색: GET https://opendart.fss.or.kr/api/list.json
- 고유번호 매핑: GET https://opendart.fss.or.kr/api/corpCode.xml (ZIP/XML)
- 공시 원문: GET https://opendart.fss.or.kr/api/document.xml (ZIP/XML)
- 공시검색의 주요 입력: crtfc_key, corp_code, bgn_de, end_de, pblntf_ty, pblntf_detail_ty, corp_cls, page_no, page_count.
- 공시 원문은 rcept_no(14자리)로 조회한다.
- DART API 키는 Cloudflare Worker Secret DART_API_KEY로만 보관한다. 키를 URL 로그, 응답, 브라우저 코드에 노출하지 않는다.
- DART 원문은 Worker에서 일시적으로 내려받아 파싱하고, DART 공시 원문 링크와 구조화된 핵심 사실/근거만 저장하는 방식을 우선한다. 원문 ZIP 전체를 D1에 저장하지 않는다.

공식 가이드:
- https://opendart.fss.or.kr/guide/detail.do?apiGrpCd=DS001&apiId=2019001
- https://opendart.fss.or.kr/guide/detail.do?apiGrpCd=DS001&apiId=2019018
- https://opendart.fss.or.kr/guide/detail.do?apiGrpCd=DS001&apiId=2019003

### NAVER API HUB 뉴스 검색

- API: GET https://naverapihub.apigw.ntruss.com/search/v1/news
- 인증 헤더: X-NCP-APIGW-API-KEY-ID, X-NCP-APIGW-API-KEY
- 파라미터: query, display(1~100), start(1~1000), sort(sim/date), format(json/xml)
- 문서상 뉴스 검색 일일 호출 한도: 25,000회.
- API HUB Client ID/Secret은 Worker Secret NAVER_APIHUB_KEY_ID, NAVER_APIHUB_KEY로 보관한다.

중요한 이용약관 제한(2026-10-07 시행):
- 검색 결과는 네이버 검색결과임을 표시하고, 제공된 결과를 독립적으로 가공 없이 노출하며, 원본 출처와 링크를 제공해야 한다.
- 검색결과 또는 파생물을 AI에 입력하거나 학습·개선·평가·노출에 활용할 수 없다.
- 검색결과를 별도 DB에 영구 저장하거나 임의로 가공할 수 없다.
- 허용된 임시 캐시만 가능하다: 서버 이력조회 최대 21일, 개인화 목적은 24시간 또는 새 질의 시까지 중 짧은 기간.
- 따라서 NAVER API HUB 결과는 별도 뉴스검색 패널에 원문 그대로 표시하는 용도로만 연결한다. AI 재료분류, 감성판정, 종목연결 자동학습, 재료 점수 계산에는 사용하지 않는다.
- 뉴스까지 AI 분석하려면 해당 언론사/뉴스 공급자의 별도 이용허락을 확보한 데이터 소스를 추가해야 한다.

공식 문서:
- https://api.ncloud-docs.com/docs/naver-api-hub-search-news
- https://xv-ncloud.pstatic.net/images/provision/NAVER_API_%C3%AC%C2%84%C2%9C%C3%AB%C2%B9%C2%84%C3%AC%C2%8A%C2%A4_%C3%AC%C2%9D%C2%B4%C3%AC%C2%9A%A9%C3%AC%C2%95%C2%BD%C3%AA%C2%B4%C2%80_APIHUB_261001_KR_clean_v2_1791769880751.pdf

## 3. 재료분류 체계 v1

대분류 코드:
- EARNINGS: 실적/성장 (매출, 영업이익, 순이익, 흑자전환, 실적전망)
- CONTRACT: 수주/공급/판매/라이선스 계약
- POLICY: 정부정책/규제/지원사업
- TECHNOLOGY: 기술/특허/신제품/신사업
- INVESTMENT: 시설투자/증설/M&A/지분투자
- BIO: 바이오/의료/임상/품목허가/기술이전
- OWNERSHIP: 최대주주/경영진/지배구조/경영권 분쟁
- FINANCE: 유상증자/CB/BW/차입/자금조달/재무위험
- INDUSTRY: 산업 성장/수요/테마 연관
- RISK: 소송/횡령/배임/제재/거래정지/상장적격성/감사의견

각 분류 결과에 별도 속성으로 저장:
- direction: POSITIVE | NEGATIVE | NEUTRAL | MIXED | UNKNOWN
- strength: 1~5 (재료의 실질적 중요도)
- confidence: 0~100 (분류 신뢰도)
- relevance: DIRECT | INDIRECT | THEME_ONLY | UNRELATED
- novelty: NEW | FOLLOW_UP | CORRECTION | REPEAT | UNKNOWN
- review_status: PENDING | ACCEPTED | REJECTED
- evidence: 원문에서 추출한 짧은 근거 문장/구조화 사실 및 원문 위치
- model_name, prompt_version, taxonomy_version

강도와 방향은 별도다. 예를 들어 대규모 유상증자는 강도는 높을 수 있으나 방향은 부정 또는 혼합일 수 있다. 임상시험계획 신청과 임상 성공/품목허가를 같은 단계로 평가하지 않는다. 우선협상대상자 선정과 확정 계약을 구분한다. 정정/철회/해제 공시는 원공시와 연결한다.

## 4. D1 테이블 설계 초안

### material_types
- material_code TEXT PRIMARY KEY
- material_name TEXT NOT NULL
- parent_code TEXT
- description TEXT
- active INTEGER NOT NULL DEFAULT 1
- taxonomy_version TEXT NOT NULL
- sort_order INTEGER NOT NULL DEFAULT 0

### material_documents
DART 공시 원문 메타데이터 및 파싱된 사실만 보관한다.
- document_id TEXT PRIMARY KEY
- source_type TEXT NOT NULL CHECK(source_type='DART')
- source_id TEXT NOT NULL UNIQUE  -- rcept_no
- corp_code TEXT
- issuer_name TEXT
- stock_code TEXT
- report_name TEXT NOT NULL
- report_type TEXT
- receipt_date TEXT NOT NULL
- source_url TEXT NOT NULL
- content_hash TEXT
- extracted_facts_json TEXT
- evidence_excerpt TEXT
- fetched_at TEXT NOT NULL
- created_at TEXT NOT NULL
- updated_at TEXT NOT NULL

### material_document_stocks
공시 하나와 종목 여러 개의 관계를 표현한다.
- document_id TEXT NOT NULL REFERENCES material_documents(document_id)
- code TEXT NOT NULL REFERENCES stocks(code)
- relation_type TEXT NOT NULL CHECK(relation_type IN ('DIRECT','INDIRECT','THEME_ONLY'))
- link_confidence INTEGER NOT NULL DEFAULT 0
- link_evidence TEXT
- PRIMARY KEY(document_id, code)

### material_classifications
분류 버전/재검수를 위해 문서와 분류 결과를 분리한다.
- classification_id TEXT PRIMARY KEY
- document_id TEXT NOT NULL REFERENCES material_documents(document_id)
- material_code TEXT NOT NULL REFERENCES material_types(material_code)
- direction TEXT NOT NULL
- strength INTEGER NOT NULL CHECK(strength BETWEEN 1 AND 5)
- confidence INTEGER NOT NULL CHECK(confidence BETWEEN 0 AND 100)
- novelty TEXT NOT NULL
- review_status TEXT NOT NULL DEFAULT 'PENDING'
- rationale TEXT
- evidence_json TEXT
- model_name TEXT
- prompt_version TEXT NOT NULL
- taxonomy_version TEXT NOT NULL
- classified_at TEXT NOT NULL
- reviewed_at TEXT
- reviewed_by TEXT

인덱스:
- material_documents(receipt_date, source_type)
- material_documents(stock_code, receipt_date)
- material_document_stocks(code, document_id)
- material_classifications(document_id, classified_at)
- material_classifications(material_code, direction, strength)

NAVER 검색 결과는 위 테이블에 저장하지 않는다. 검색 패널 요청 시 API를 호출해 원본 결과를 별도로 반환한다.

## 5. 데이터 흐름

1. DART corpCode.xml을 내려받아 기존 stocks.code와 corp_code를 매핑한다.
2. DART list.json을 날짜/시장/공시유형별로 페이지 조회한다.
3. rcept_no로 document.xml을 내려받아 ZIP/XML을 파싱한다.
4. stock_code를 기존 stocks와 대조하고 eligible COMMON/PREFERRED 여부를 확인한다.
5. 원문 해시로 중복을 막고, 구조화 사실과 짧은 근거만 material_documents에 저장한다.
6. AI는 DART에서 취득한 허용된 공시 데이터만 분류한다.
7. 모호한 종목연결/낮은 confidence는 PENDING으로 남긴다.
8. 별도 NAVER 뉴스 패널은 사용자 검색어/종목명으로 API HUB를 호출하고, 결과를 가공 없이 네이버 출처·원문 링크와 함께 보여준다. AI 파이프라인에는 연결하지 않는다.

## 6. AI 분류 출력 스키마

{
  "material_code": "CONTRACT",
  "subtype": "SINGLE_SALE_SUPPLY",
  "direction": "POSITIVE",
  "strength": 4,
  "confidence": 92,
  "relevance": "DIRECT",
  "novelty": "NEW",
  "key_facts": {
    "contract_amount_krw": null,
    "sales_ratio_pct": null,
    "contract_start": null,
    "contract_end": null,
    "counterparty": null,
    "conditions": []
  },
  "rationale": "공시 원문에 근거한 짧은 판단 근거",
  "evidence": [
    {"quote": "원문 근거 문장", "section": "주요내용"}
  ],
  "review_status": "PENDING"
}

수치가 원문에 없으면 추정하지 않고 null로 둔다. 공시 제출 회사와 공시 대상 종목이 다르거나 여러 종목이 등장하면 종목 연결을 별도로 검증한다.

## 7. 검증 세트 계획(30건)

실제 DART 원문을 확보한 후 다음 분포로 30건을 고정한다. 검색결과 요약이나 제3자 사이트의 AI 점수를 정답으로 사용하지 않고, DART 원문을 읽어 사람이 정답 라벨을 작성한다.

- 실적/성장 4건: 흑자전환, 적자전환, 매출·이익 급증, 실적 하락
- 수주/계약 4건: 대형 확정수주, 소규모 계약, 우선협상대상자, 계약해지/정정
- 정책/산업 3건: 직접 수혜, 간접 수혜, 단순 테마 언급
- 기술/투자 3건: 특허/신제품, 시설투자, 투자 철회/지연
- 바이오 4건: 임상 계획, 임상 결과, 품목허가, 기술이전
- 지분/경영 3건: 최대주주 변경, 경영권 분쟁, 주식담보/단순 연장
- 자금/재무 3건: 유상증자, CB/BW, 차입/재무 위험
- 위험/악재 4건: 소송, 감사의견/상장적격성, 거래정지, 횡령·배임 관련 공시
- 중복/정정/후속관계 2건: 원공시-정정공시 또는 동일 사건 후속공시

평가 지표:
- 대분류 정확도, 방향성 정확도, 종목 연결 precision/recall, 신규성 정확도
- confidence calibration(신뢰도 구간별 실제 정답률)
- 위험/악재 누락률
- 사람이 수정한 비율
- 원문 근거가 없는 환각 수치/주장 발생률(목표 0)

## 8. 구현 전 확인이 필요한 항목

- DART Open API 인증키 발급 및 사용량 제한 확인
- NAVER API HUB 구독 및 Client ID/Secret 발급 (뉴스 패널 표시만)
- AI 실행 방식 확정: 로컬 Ollama 또는 외부 AI API. DART 원문 데이터만 AI에 전달한다.
- 뉴스 콘텐츠를 AI로 분류해야 한다면 NAVER API HUB와 별도로 뉴스 제공자의 AI 처리/저장 권한을 확보한다.

## 9. 안전한 배포 전략

- 이 브랜치에서 스키마/수집기/분류기를 독립 구현한다.
- 로컬 테스트 DB에서 먼저 검증하고 production D1은 별도 승인 전까지 변경하지 않는다.
- 기존 차마존/CM 함수는 수정하지 않는다.
- 기존 /api/materials 읽기 경로는 테이블 스키마가 준비되기 전까지 운영 호출하지 않는다.
- PR 생성 및 Worker 배포는 테스트 완료 후 별도 승인받는다.
