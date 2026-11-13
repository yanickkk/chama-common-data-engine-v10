PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS stocks (
  code TEXT PRIMARY KEY CHECK(length(code)=6),
  name TEXT NOT NULL,
  market TEXT NOT NULL,
  market_cap REAL,
  listed_shares REAL,
  active INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stocks_market_active ON stocks(market, active);

CREATE TABLE IF NOT EXISTS stock_quotes (
  code TEXT PRIMARY KEY REFERENCES stocks(code) ON DELETE CASCADE,
  price REAL,
  previous_close REAL,
  change_value REAL,
  change_pct REAL,
  volume REAL NOT NULL DEFAULT 0,
  trade_value REAL NOT NULL DEFAULT 0,
  source TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_quotes_updated ON stock_quotes(updated_at);

CREATE TABLE IF NOT EXISTS stock_daily_candles (
  code TEXT NOT NULL REFERENCES stocks(code) ON DELETE CASCADE,
  date TEXT NOT NULL CHECK(length(date)=8),
  open REAL,
  high REAL,
  low REAL,
  close REAL NOT NULL,
  volume REAL NOT NULL DEFAULT 0,
  trade_value REAL NOT NULL DEFAULT 0,
  source TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(code, date)
);
CREATE INDEX IF NOT EXISTS idx_candles_date ON stock_daily_candles(date);

CREATE TABLE IF NOT EXISTS stock_indicators (
  code TEXT NOT NULL REFERENCES stocks(code) ON DELETE CASCADE,
  date TEXT NOT NULL CHECK(length(date)=8),
  ema5 REAL,
  ema10 REAL,
  ema20 REAL,
  ema60 REAL,
  ema120 REAL,
  rsi14 REAL,
  macd REAL,
  macd_signal REAL,
  macd_hist REAL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(code, date)
);
CREATE INDEX IF NOT EXISTS idx_indicators_date ON stock_indicators(date);

CREATE TABLE IF NOT EXISTS data_sync_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sync_type TEXT NOT NULL,
  provider TEXT,
  requested INTEGER NOT NULL DEFAULT 0,
  succeeded INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  detail_json TEXT
);
