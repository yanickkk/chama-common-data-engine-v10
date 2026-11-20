-- Durable per-stock indicator recalculation state.
-- Apply to LOCAL D1 first. Do not apply to production without separate approval.
CREATE TABLE IF NOT EXISTS indicator_sync_state (
  code TEXT PRIMARY KEY REFERENCES stocks(code) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('pending','completed')),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  source_updated_at TEXT,
  last_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_indicator_sync_state_status_code
  ON indicator_sync_state(status, code);
