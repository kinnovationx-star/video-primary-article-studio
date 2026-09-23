import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);

test("studio exposes one unified production submit button", async () => {
  const source = await readFile(new URL("app/seo-loop-app.tsx", root), "utf8");
  const studio = source.slice(source.indexOf("function Studio"), source.indexOf("function Library"));
  assert.match(studio, /記事を作成する/);
  assert.doesNotMatch(studio, /制作入力を保存|キーワード候補を出す|この候補で記事を制作/);
  assert.match(studio, /article_limit/);
  assert.match(studio, /image_count/);
  assert.match(studio, /wordpress_category_id/);
});

test("unified production persists exact controls and media metadata", async () => {
  const source = await readFile(new URL("lib/unified-production.ts", root), "utf8");
  assert.match(source, /for \(let index = 0; index < articleCount; index\+\+\)/);
  assert.match(source, /featured_media/);
  assert.match(source, /status: "draft"/);
  assert.match(source, /metaDescription/);
  assert.match(source, /section_images_json/);
  assert.match(source, /wordpress_category_id/);
});

test("migration isolates generated images in D1 and R2 metadata", async () => {
  const migration = await readFile(new URL("migrations/0006_unified_article_production.sql", root), "utf8");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS article_images/);
  assert.match(migration, /featured_image_url/);
  assert.match(migration, /wordpress_category_id/);
});
