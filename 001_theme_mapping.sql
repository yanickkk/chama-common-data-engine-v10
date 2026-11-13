-- Chama theme mapping schema v1.0
-- Safe additive migration: does not alter or delete existing stock/quote/candle/indicator rows.

CREATE TABLE IF NOT EXISTS themes (
  theme_code TEXT PRIMARY KEY,
  theme_name TEXT NOT NULL UNIQUE,
  parent_category TEXT NOT NULL DEFAULT '기타',
  description TEXT,
  source_name TEXT NOT NULL DEFAULT 'MANUAL',
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS theme_stock_map (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  theme_code TEXT NOT NULL,
  relation_type TEXT NOT NULL DEFAULT 'SECONDARY' CHECK (relation_type IN ('PRIMARY','SECONDARY')),
  allocation_weight REAL NOT NULL DEFAULT 0 CHECK (allocation_weight >= 0 AND allocation_weight <= 1),
  relevance_grade TEXT NOT NULL DEFAULT 'C' CHECK (relevance_grade IN ('A','B','C')),
  evidence_status TEXT NOT NULL DEFAULT 'REVIEW' CHECK (evidence_status IN ('CONFIRMED','REVIEW','MARKET_ONLY')),
  source_name TEXT NOT NULL DEFAULT 'MANUAL',
  evidence_summary TEXT,
  verified_at TEXT,
  valid_from TEXT NOT NULL DEFAULT (date('now')),
  valid_to TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(code, theme_code)
);

CREATE INDEX IF NOT EXISTS idx_theme_stock_map_theme_active ON theme_stock_map(theme_code, active, relevance_grade);
CREATE INDEX IF NOT EXISTS idx_theme_stock_map_code_active ON theme_stock_map(code, active);
CREATE INDEX IF NOT EXISTS idx_theme_stock_map_status ON theme_stock_map(evidence_status, active);

CREATE TABLE IF NOT EXISTS theme_evidence (
  evidence_id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  theme_code TEXT NOT NULL,
  evidence_type TEXT NOT NULL CHECK (evidence_type IN ('DART','KRX','COMPANY','NEWS','NAVER_THEME','MANUAL','OTHER')),
  title TEXT,
  source_url TEXT,
  evidence_text TEXT,
  published_at TEXT,
  checked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  confidence REAL NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 1),
  status TEXT NOT NULL DEFAULT 'REVIEW' CHECK (status IN ('CONFIRMED','REVIEW','REJECTED'))
);
CREATE INDEX IF NOT EXISTS idx_theme_evidence_code_theme ON theme_evidence(code, theme_code, checked_at);

CREATE TABLE IF NOT EXISTS material_types (
  material_code TEXT PRIMARY KEY,
  material_name TEXT NOT NULL UNIQUE,
  base_grade INTEGER NOT NULL CHECK (base_grade BETWEEN 1 AND 3),
  description TEXT,
  verification_rule TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS stock_materials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  material_code TEXT NOT NULL,
  title TEXT NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'OTHER' CHECK (source_type IN ('DART','KRX','COMPANY','NEWS','OTHER')),
  source_url TEXT,
  published_at TEXT,
  verified_at TEXT,
  verification_status TEXT NOT NULL DEFAULT 'REVIEW' CHECK (verification_status IN ('CONFIRMED','REVIEW','REJECTED','EXPIRED')),
  material_score REAL NOT NULL DEFAULT 0 CHECK (material_score >= 0 AND material_score <= 100),
  expires_at TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_stock_materials_code_status ON stock_materials(code, verification_status, published_at);
CREATE INDEX IF NOT EXISTS idx_stock_materials_type ON stock_materials(material_code, verification_status);

CREATE TABLE IF NOT EXISTS theme_stock_map_history (
  history_id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  theme_code TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('INSERT','UPDATE','DEACTIVATE','REACTIVATE')),
  old_values TEXT,
  new_values TEXT,
  changed_by TEXT NOT NULL DEFAULT 'SYSTEM',
  changed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_theme_map_history_code ON theme_stock_map_history(code, changed_at);

-- Theme taxonomy starter set only. This does NOT assert any stock belongs to a theme.
INSERT OR IGNORE INTO themes(theme_code, theme_name, parent_category, description, source_name) VALUES
('SEMICONDUCTOR','반도체','IT','반도체 설계·제조·장비·소재','SEED'),
('AI','AI 인공지능','IT','AI 소프트웨어·서비스·인프라','SEED'),
('AI_SEMICON','AI 반도체','IT','AI 연산용 반도체 및 관련 IP·설계','SEED'),
('HBM','HBM','IT','고대역폭 메모리 및 관련 장비·소재','SEED'),
('PCB','PCB','IT','인쇄회로기판 및 기판 소재·장비','SEED'),
('ROBOT','로봇','산업재','산업용·서비스·협동 로봇','SEED'),
('DEFENSE','방산','산업재','방위산업·무기체계·항공 방산','SEED'),
('POWER_GRID','전력·전력망','산업재','전력기기·변압기·전선·전력망','SEED'),
('BIO','바이오·제약','헬스케어','신약·바이오의약품·제약','SEED'),
('MEDICAL_DEVICE','의료기기','헬스케어','진단·치료·의료기기','SEED'),
('SECONDARY_BATTERY','2차전지','에너지','배터리 셀·소재·장비','SEED'),
('AUTOMOTIVE','자동차·부품','경기소비재','완성차·전장·부품','SEED'),
('SHIPBUILDING','조선','산업재','조선·선박 기자재','SEED'),
('NUCLEAR','원전','에너지','원자력 발전·원전 설비·정비','SEED'),
('DATA_CENTER','데이터센터','IT','데이터센터·서버·냉각·전력 인프라','SEED'),
('CONTENT','콘텐츠·엔터','커뮤니케이션','게임·영상·음악·엔터테인먼트','SEED'),
('CONSTRUCTION','건설·인프라','산업재','건설·토목·인프라','SEED'),
('FINANCE','금융','금융','은행·증권·보험·금융지주','SEED'),
('COSMETICS','화장품','필수소비재','화장품 제조·브랜드·ODM','SEED'),
('FOOD','음식료','필수소비재','식품·음료·유통','SEED');

-- Chartmaster's 13 core material categories from the user's supplied reference image.
INSERT OR IGNORE INTO material_types(material_code, material_name, base_grade, description, verification_rule) VALUES
('FDA_CLINICAL3','FDA 승인, 임상 3상 결과',3,'FDA 승인 또는 임상 3상 주요 결과','FDA·임상시험 공식 발표 또는 DART/회사 공식 공지 확인'),
('MA_MNA','인수합병(M&A), 매각 이슈',3,'인수합병, 기업 매각, 경영권 인수 이슈','공시·당사자 공식 발표 등 거래 진행 사실 확인'),
('GLOBAL_PARTNERSHIP','글로벌 협업, 공급계약',3,'글로벌 기업 협업 및 공급계약','계약 당사자·계약 내용·공급 사실의 공식 근거 확인'),
('BONUS_SHAREHOLDER','무상증자·주주 2주 이상',2,'무상증자 또는 주주 대상 권리 관련 이슈','이사회 결의·공시에서 배정 조건과 기준일 확인'),
('EQUITY_STAKE','보유지분 부각',2,'상장·비상장 기업 지분 및 투자 가치','사업보고서·공시에서 지분율과 평가 근거 확인'),
('GOV_POLICY','대통령·정부 정책 수혜',2,'정부 정책·국책사업 관련 수혜','정부·부처 공식 정책과 기업 사업의 직접 연관성 확인'),
('WORLD_FIRST_RECORD','세계 최초 / 사상 최대',2,'세계 최초 기술 또는 사상 최대 성과','객관적 비교 근거와 공식 발표 확인'),
('EARNINGS_SURPRISE','실적 서프라이즈 기대감',2,'실적 개선 또는 시장 예상 초과','실적 공시·잠정실적·공식 가이던스 확인; 기대감은 미확정 표시'),
('LARGE_ORDER','대형 공급계약 / 수주 계약',2,'대규모 공급·수주 계약','DART 계약 공시 또는 발주처 공식 발표 확인'),
('CONTENT_RELEASE','넷플릭스, 게임, 콘텐츠 출시',2,'글로벌 플랫폼 공개 및 게임·콘텐츠 출시','플랫폼·배급사·제작사 공식 일정과 출시 사실 확인'),
('TRADING_RESUME','관리종목 해제 / 거래재개',1,'관리종목 해제 또는 거래 재개','KRX 거래 상태 및 관련 공시 확인'),
('CONTROL_DISPUTE','경영권 분쟁 / 승소 이슈',1,'경영권 분쟁 및 법적 승소','법원 결정·공시·당사자 공식 발표 확인'),
('PATENT_NEW_BUSINESS','특허 / 기술 보유 / 신사업 진출',1,'특허·기술 보유 및 신규 사업 진출','특허 등록·사업목적 변경·신사업 계약 등 공식 근거 확인');


-- Source identifiers and import audit. Additive/idempotent tables.
CREATE TABLE IF NOT EXISTS theme_source_refs (
  source_name TEXT NOT NULL,
  source_id TEXT NOT NULL,
  theme_code TEXT NOT NULL,
  source_url TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(source_name, source_id)
);
CREATE INDEX IF NOT EXISTS idx_theme_source_refs_theme ON theme_source_refs(theme_code);

CREATE TABLE IF NOT EXISTS theme_import_runs (
  run_id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_name TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  dry_run INTEGER NOT NULL DEFAULT 0 CHECK (dry_run IN (0,1)),
  themes_seen INTEGER NOT NULL DEFAULT 0,
  themes_processed INTEGER NOT NULL DEFAULT 0,
  members_found INTEGER NOT NULL DEFAULT 0,
  members_matched INTEGER NOT NULL DEFAULT 0,
  errors_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_theme_import_runs_source ON theme_import_runs(source_name, finished_at);
