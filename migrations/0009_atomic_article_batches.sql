ALTER TABLE articles ADD COLUMN batch_ready INTEGER NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_articles_batch_ready ON articles(batch_ready, updated_at DESC);
