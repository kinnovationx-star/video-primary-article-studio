CREATE TABLE IF NOT EXISTS competitive_projects (
  id TEXT PRIMARY KEY,
  keyword TEXT NOT NULL,
  company_context TEXT NOT NULL DEFAULT '',
  primary_information TEXT NOT NULL,
  location_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'READY',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS competitive_sources (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'manual',
  url TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  headings_json TEXT NOT NULL DEFAULT '[]',
  topics_json TEXT NOT NULL DEFAULT '[]',
  text_excerpt TEXT NOT NULL DEFAULT '',
  word_count INTEGER NOT NULL DEFAULT 0,
  fetch_status TEXT NOT NULL DEFAULT 'PENDING',
  fetched_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(project_id, url)
);
CREATE INDEX IF NOT EXISTS idx_competitive_sources_project ON competitive_sources(project_id, created_at);

CREATE TABLE IF NOT EXISTS competitive_analyses (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'manual_urls',
  scores_json TEXT NOT NULL DEFAULT '{}',
  common_topics_json TEXT NOT NULL DEFAULT '[]',
  content_gaps_json TEXT NOT NULL DEFAULT '[]',
  differentiation_json TEXT NOT NULL DEFAULT '[]',
  outline_json TEXT NOT NULL DEFAULT '[]',
  serp_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_competitive_analyses_project ON competitive_analyses(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS competitive_drafts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  analysis_id TEXT NOT NULL,
  title TEXT NOT NULL,
  body_html TEXT NOT NULL,
  originality_score REAL NOT NULL DEFAULT 100,
  maximum_source_overlap REAL NOT NULL DEFAULT 0,
  plagiarism_risk TEXT NOT NULL DEFAULT 'LOW',
  status TEXT NOT NULL DEFAULT 'DRAFT',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_competitive_drafts_project ON competitive_drafts(project_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS pdca_actions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  phase TEXT NOT NULL,
  action_text TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'PLANNED',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pdca_actions_project ON pdca_actions(project_id, created_at DESC);
