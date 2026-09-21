CREATE TABLE IF NOT EXISTS workspace_settings (
  id TEXT PRIMARY KEY,
  site_name TEXT NOT NULL DEFAULT '',
  site_url TEXT NOT NULL DEFAULT '',
  location_name TEXT NOT NULL DEFAULT '日本',
  location_code TEXT NOT NULL DEFAULT 'jp',
  language_code TEXT NOT NULL DEFAULT 'ja',
  device TEXT NOT NULL DEFAULT 'desktop',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS integration_profiles (
  provider TEXT PRIMARY KEY,
  public_config TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'NOT_CONFIGURED',
  checked_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS seo_reports (
  id TEXT PRIMARY KEY,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
