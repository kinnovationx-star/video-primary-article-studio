-- Browser production: which H2 an image belongs to, and the Claude conversation that wrote the article.
ALTER TABLE article_images ADD COLUMN section_index INTEGER NOT NULL DEFAULT -1;
ALTER TABLE articles ADD COLUMN conversation_url TEXT NOT NULL DEFAULT '';
