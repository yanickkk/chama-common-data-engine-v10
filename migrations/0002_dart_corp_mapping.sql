-- DART issuer-to-stock mapping. Apply locally first; production requires separate approval.
CREATE TABLE IF NOT EXISTS dart_corp_mappings (
  corp_code TEXT PRIMARY KEY CHECK(length(corp_code)=8),
  corp_name TEXT NOT NULL,
  stock_code TEXT,
  modify_date TEXT,
  mapping_status TEXT NOT NULL CHECK(mapping_status IN ('MAPPED','UNMAPPED','REVIEW')),
  security_type TEXT,
  market TEXT,
  source_type TEXT NOT NULL DEFAULT 'DART_CORPCODE',
  synced_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dart_corp_mappings_stock
  ON dart_corp_mappings(stock_code, mapping_status);
CREATE INDEX IF NOT EXISTS idx_dart_corp_mappings_status
  ON dart_corp_mappings(mapping_status, corp_name);
