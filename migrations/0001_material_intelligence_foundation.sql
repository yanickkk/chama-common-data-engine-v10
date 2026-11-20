-- Material intelligence foundation v1.
-- Apply to a LOCAL D1 database first. Do not apply to production without explicit approval.
-- NAVER API HUB search results must never be inserted into these tables.

CREATE TABLE IF NOT EXISTS material_types (
  material_code TEXT PRIMARY KEY,
  material_name TEXT NOT NULL,
  parent_code TEXT,
  base_grade INTEGER NOT NULL DEFAULT 3 CHECK(base_grade BETWEEN 1 AND 5),
  description TEXT NOT NULL DEFAULT '',
  verification_rule TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  taxonomy_version TEXT NOT NULL DEFAULT 'v1',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS material_documents (
  document_id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL CHECK(source_type = 'DART'),
  source_id TEXT NOT NULL UNIQUE,
  corp_code TEXT,
  issuer_name TEXT,
  stock_code TEXT,
  report_name TEXT NOT NULL,
  report_type TEXT,
  receipt_date TEXT NOT NULL,
  source_url TEXT NOT NULL,
  content_hash TEXT,
  extracted_facts_json TEXT NOT NULL DEFAULT '{}',
  evidence_excerpt TEXT,
  fetched_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS material_document_stocks (
  document_id TEXT NOT NULL REFERENCES material_documents(document_id) ON DELETE CASCADE,
  code TEXT NOT NULL REFERENCES stocks(code) ON DELETE RESTRICT,
  relation_type TEXT NOT NULL CHECK(relation_type IN ('DIRECT','INDIRECT','THEME_ONLY')),
  link_confidence INTEGER NOT NULL DEFAULT 0 CHECK(link_confidence BETWEEN 0 AND 100),
  link_evidence TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(document_id, code)
);

CREATE TABLE IF NOT EXISTS material_classifications (
  classification_id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES material_documents(document_id) ON DELETE CASCADE,
  material_code TEXT NOT NULL REFERENCES material_types(material_code),
  subtype TEXT,
  direction TEXT NOT NULL CHECK(direction IN ('POSITIVE','NEGATIVE','NEUTRAL','MIXED','UNKNOWN')),
  strength INTEGER NOT NULL CHECK(strength BETWEEN 1 AND 5),
  confidence INTEGER NOT NULL CHECK(confidence BETWEEN 0 AND 100),
  relevance TEXT NOT NULL CHECK(relevance IN ('DIRECT','INDIRECT','THEME_ONLY','UNRELATED')),
  novelty TEXT NOT NULL CHECK(novelty IN ('NEW','FOLLOW_UP','CORRECTION','REPEAT','UNKNOWN')),
  review_status TEXT NOT NULL DEFAULT 'PENDING' CHECK(review_status IN ('PENDING','ACCEPTED','REJECTED')),
  rationale TEXT,
  key_facts_json TEXT NOT NULL DEFAULT '{}',
  evidence_json TEXT NOT NULL DEFAULT '[]',
  model_name TEXT,
  prompt_version TEXT NOT NULL,
  taxonomy_version TEXT NOT NULL,
  classified_at TEXT NOT NULL,
  reviewed_at TEXT,
  reviewed_by TEXT
);

-- Compatibility projection for the existing GET /api/materials reader.
-- This table is a DART-derived, reviewed/materialized view; it is not the canonical source.
CREATE TABLE IF NOT EXISTS stock_materials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL REFERENCES stocks(code) ON DELETE RESTRICT,
  material_code TEXT NOT NULL REFERENCES material_types(material_code),
  document_id TEXT REFERENCES material_documents(document_id) ON DELETE SET NULL,
  classification_id TEXT REFERENCES material_classifications(classification_id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'DART' CHECK(source_type = 'DART'),
  source_url TEXT NOT NULL,
  published_at TEXT NOT NULL,
  verified_at TEXT,
  verification_status TEXT NOT NULL DEFAULT 'PENDING' CHECK(verification_status IN ('PENDING','VERIFIED','REJECTED')),
  material_score INTEGER CHECK(material_score BETWEEN 0 AND 100),
  expires_at TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(code, material_code, document_id)
);

CREATE INDEX IF NOT EXISTS idx_material_documents_receipt_source
  ON material_documents(receipt_date, source_type);
CREATE INDEX IF NOT EXISTS idx_material_documents_stock_receipt
  ON material_documents(stock_code, receipt_date);
CREATE INDEX IF NOT EXISTS idx_material_documents_corp_receipt
  ON material_documents(corp_code, receipt_date);
CREATE INDEX IF NOT EXISTS idx_material_document_stocks_code
  ON material_document_stocks(code, document_id);
CREATE INDEX IF NOT EXISTS idx_material_classifications_document_date
  ON material_classifications(document_id, classified_at);
CREATE INDEX IF NOT EXISTS idx_material_classifications_type_direction_strength
  ON material_classifications(material_code, direction, strength);
CREATE INDEX IF NOT EXISTS idx_material_classifications_review
  ON material_classifications(review_status, confidence);
CREATE INDEX IF NOT EXISTS idx_stock_materials_code_published
  ON stock_materials(code, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_materials_status_score
  ON stock_materials(verification_status, material_score DESC);

INSERT OR IGNORE INTO material_types
  (material_code, material_name, base_grade, description, verification_rule, taxonomy_version, sort_order)
VALUES
  ('EARNINGS', '실적/성장', 4, '매출·영업이익·순이익·흑자전환·실적전망', '공시 수치와 전년/전분기 비교 기준을 확인', 'v1', 10),
  ('CONTRACT', '수주/계약', 4, '수주·공급·판매·라이선스 계약', '확정 계약과 우선협상·MOU를 구분하고 계약금액·기간·상대방 확인', 'v1', 20),
  ('POLICY', '정책/규제', 3, '정부정책·규제·지원사업', '회사에 대한 직접 영향과 산업 일반 영향을 구분', 'v1', 30),
  ('TECHNOLOGY', '기술/제품', 3, '기술·특허·신제품·신사업', '특허 출원/등록, 개발/출시, 상용화 단계를 구분', 'v1', 40),
  ('INVESTMENT', '투자/증설/M&A', 3, '시설투자·증설·인수합병·지분투자', '투자 확정·검토·철회와 투자 규모를 확인', 'v1', 50),
  ('BIO', '바이오/의료', 4, '임상·품목허가·기술이전', '임상 단계·결과·허가·기술이전 확정 여부를 구분', 'v1', 60),
  ('OWNERSHIP', '지분/경영', 3, '최대주주·경영진·지배구조·경영권', '변경 확정 여부와 실제 지배력 변동 여부를 확인', 'v1', 70),
  ('FINANCE', '자금/재무', 3, '유상증자·CB/BW·차입·자금조달·재무위험', '조달 방식·희석 가능성·상환 조건·재무 영향 확인', 'v1', 80),
  ('INDUSTRY', '산업/테마', 2, '산업 성장·수요·테마 연관', '단순 언급과 회사의 실질 사업 연관성을 구분', 'v1', 90),
  ('RISK', '위험/악재', 5, '소송·횡령/배임·제재·거래정지·상장적격성·감사의견', '사실 확정 여부와 영향 범위·중대성 확인', 'v1', 100);
