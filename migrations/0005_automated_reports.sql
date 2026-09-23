CREATE TABLE IF NOT EXISTS automated_reports (
  id TEXT PRIMARY KEY,
  generated_at TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  report_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_automated_reports_generated_at
  ON automated_reports(generated_at DESC);
