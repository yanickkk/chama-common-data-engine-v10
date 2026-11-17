-- Daily, reproducible selection snapshots for the closing-trade, Chama-zone and CM screens.
-- Apply this migration to the configured Cloudflare D1 database before deploying the Worker.
CREATE TABLE IF NOT EXISTS screener_selection_runs (
  selection_date TEXT NOT NULL CHECK(length(selection_date)=8),
  strategy TEXT NOT NULL CHECK(strategy IN ('close','chama','cm')),
  selected_count INTEGER NOT NULL DEFAULT 0 CHECK(selected_count>=0),
  scanned_at TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  PRIMARY KEY(selection_date,strategy)
);
CREATE INDEX IF NOT EXISTS idx_screener_selection_runs_strategy_date
  ON screener_selection_runs(strategy,selection_date DESC);

CREATE TABLE IF NOT EXISTS screener_selection_items (
  selection_date TEXT NOT NULL CHECK(length(selection_date)=8),
  strategy TEXT NOT NULL CHECK(strategy IN ('close','chama','cm')),
  code TEXT NOT NULL CHECK(length(code)=6),
  name TEXT NOT NULL DEFAULT '',
  rank INTEGER NOT NULL DEFAULT 0,
  details_json TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  PRIMARY KEY(selection_date,strategy,code),
  FOREIGN KEY(selection_date,strategy)
    REFERENCES screener_selection_runs(selection_date,strategy)
    ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_screener_selection_items_date_strategy_rank
  ON screener_selection_items(selection_date,strategy,rank);
