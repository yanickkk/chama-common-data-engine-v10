-- Theme source archive v1.0
-- Additive, idempotent migration. Keeps imported source payloads losslessly.
-- It does not change stocks, quotes, candles, indicators, or existing theme mappings.

CREATE TABLE IF NOT EXISTS theme_source_records (
  source_name TEXT NOT NULL DEFAULT 'SUPABASE_APP_DATA',
  source_key TEXT NOT NULL,
  source_date TEXT NOT NULL DEFAULT '',
  record_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  source_url TEXT,
  payload_sha256 TEXT,
  imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (source_name, source_key, source_date, record_id)
);

CREATE INDEX IF NOT EXISTS idx_theme_source_records_key_date
  ON theme_source_records(source_key, source_date);
CREATE INDEX IF NOT EXISTS idx_theme_source_records_imported
  ON theme_source_records(imported_at);

CREATE TABLE IF NOT EXISTS theme_source_import_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_name TEXT NOT NULL,
  file_name TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  records_seen INTEGER NOT NULL DEFAULT 0,
  records_written INTEGER NOT NULL DEFAULT 0,
  records_skipped INTEGER NOT NULL DEFAULT 0,
  errors_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_theme_source_import_runs_started
  ON theme_source_import_runs(started_at);
