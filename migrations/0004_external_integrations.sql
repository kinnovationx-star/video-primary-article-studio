CREATE TABLE IF NOT EXISTS integration_credentials (
  provider TEXT PRIMARY KEY,
  secret_cipher TEXT NOT NULL,
  expires_at TEXT,
  scopes_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS integration_oauth_states (
  state TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  secret_cipher TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_integration_oauth_states_expiry
  ON integration_oauth_states(expires_at);
