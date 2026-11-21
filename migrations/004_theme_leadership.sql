-- Theme leadership v1 schema
-- Additive local-first schema for theme discovery and stock membership.
-- Does not modify stocks, quotes, candles, indicators, or ChamaZone/CM rules.

CREATE TABLE IF NOT EXISTS themes (
  theme_code TEXT PRIMARY KEY,
  theme_name TEXT NOT NULL,
  parent_category TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  source_name TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS theme_source_refs (
  source_name TEXT NOT NULL,
  source_id TEXT NOT NULL,
  theme_code TEXT NOT NULL,
  source_url TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (source_name, source_id)
);

CREATE TABLE IF NOT EXISTS theme_stock_map (
  code TEXT NOT NULL,
  theme_code TEXT NOT NULL,
  relation_type TEXT NOT NULL DEFAULT 'SECONDARY',
  allocation_weight REAL NOT NULL DEFAULT 0,
  relevance_grade TEXT NOT NULL DEFAULT 'C',
  evidence_status TEXT NOT NULL DEFAULT 'MARKET_ONLY',
  source_name TEXT NOT NULL DEFAULT '',
  evidence_summary TEXT NOT NULL DEFAULT '',
  verified_at TEXT,
  valid_from TEXT,
  valid_to TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (code, theme_code)
);

CREATE INDEX IF NOT EXISTS idx_theme_stock_map_theme_active
  ON theme_stock_map(theme_code, active, code);
CREATE INDEX IF NOT EXISTS idx_theme_stock_map_code_active
  ON theme_stock_map(code, active, theme_code);
CREATE INDEX IF NOT EXISTS idx_themes_active_name
  ON themes(active, theme_name);

CREATE TABLE IF NOT EXISTS theme_import_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_name TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  dry_run INTEGER NOT NULL DEFAULT 0,
  themes_seen INTEGER NOT NULL DEFAULT 0,
  themes_processed INTEGER NOT NULL DEFAULT 0,
  members_found INTEGER NOT NULL DEFAULT 0,
  members_matched INTEGER NOT NULL DEFAULT 0,
  errors_json TEXT NOT NULL DEFAULT '[]'
);
