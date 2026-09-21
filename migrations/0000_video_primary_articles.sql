CREATE TABLE IF NOT EXISTS videos (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  url TEXT NOT NULL DEFAULT '',
  transcript TEXT NOT NULL,
  keyword TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'READY',
  article_markdown TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_videos_updated ON videos(updated_at DESC);
