ALTER TABLE production_projects ADD COLUMN image_count INTEGER NOT NULL DEFAULT 1;
ALTER TABLE production_projects ADD COLUMN wordpress_category_id TEXT NOT NULL DEFAULT '';
ALTER TABLE production_projects ADD COLUMN wordpress_category_name TEXT NOT NULL DEFAULT '';

ALTER TABLE articles ADD COLUMN featured_image_url TEXT NOT NULL DEFAULT '';
ALTER TABLE articles ADD COLUMN section_images_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE articles ADD COLUMN generation_provider TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS article_images (
  id TEXT PRIMARY KEY,
  article_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  section_heading TEXT NOT NULL DEFAULT '',
  alt_text TEXT NOT NULL DEFAULT '',
  prompt TEXT NOT NULL DEFAULT '',
  object_key TEXT NOT NULL UNIQUE,
  wordpress_media_id TEXT,
  wordpress_url TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_article_images_article ON article_images(article_id, created_at);
