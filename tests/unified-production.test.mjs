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
  assert.match(source, /Array\.from\([\s\S]*length: articleCount - resumeRows\.length/);
  assert.match(source, /featured_media/);
  assert.match(source, /status: "draft"/);
  assert.match(source, /metaDescription/);
  assert.match(source, /section_images_json/);
  assert.match(source, /wordpress_category_id/);
  assert.doesNotMatch(source, /temperature:/);
});

test("migration isolates generated images in D1 and R2 metadata", async () => {
  const migration = await readFile(new URL("migrations/0006_unified_article_production.sql", root), "utf8");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS article_images/);
  assert.match(migration, /featured_image_url/);
  assert.match(migration, /wordpress_category_id/);
});

test("article library includes the SEO LOOP style visual editor", async () => {
  const source = await readFile(new URL("app/seo-loop-app.tsx", root), "utf8");
  assert.match(source, /WordPressと同じ見た目で、直接編集できます/);
  assert.match(source, /このH2を編集/);
  assert.match(source, /SEO設定（タイトルタグ・URL末尾・説明文・キーワード）/);
  assert.match(source, /変更を保存してプレビューへ反映/);
  assert.match(source, /`articles\/\$\{item\.id\}`[\s\S]*"PATCH"/);
});

test("generated article cards stay below the studio form and expose AI editing", async () => {
  const source = await readFile(new URL("app/seo-loop-app.tsx", root), "utf8");
  assert.match(source, /<Library[\s\S]*embedded/);
  assert.match(source, /このH2本文をAIで再生成/);
  assert.match(source, /このH2画像を動画から再取得/);
  assert.match(source, /アイキャッチ画像をAIで再生成/);
  assert.match(source, /WordPress下書きを閲覧/);
});

test("article regeneration APIs and WordPress preview URL are persisted", async () => {
  const route = await readFile(new URL("app/api/[[...path]]/route.ts", root), "utf8");
  const production = await readFile(new URL("lib/unified-production.ts", root), "utf8");
  const migration = await readFile(new URL("migrations/0007_article_editing_and_preview.sql", root), "utf8");
  assert.match(route, /regenerate-section/);
  assert.match(route, /regenerate-image/);
  assert.match(production, /preview=true/);
  assert.match(migration, /wordpress_preview_url/);
});

test("video frames and GPT Image 2.5 create 16:9 editorial visuals", async () => {
  const production = await readFile(new URL("lib/unified-production.ts", root), "utf8");
  const styles = await readFile(new URL("app/globals.css", root), "utf8");
  assert.match(production, /gpt-image-2\.5-sunburst/);
  assert.match(production, /2048x1152/);
  assert.match(production, /storyboard3|playerStoryboardSpecRenderer/);
  assert.match(production, /trim: \{ top, right, bottom, left \}/);
  assert.match(production, /動画内から取得した実際の対談フレーム/);
  assert.doesNotMatch(production, /size: "1536x1024"/);
  assert.match(styles, /aspect-ratio: 16 \/ 9/);
  assert.match(styles, /max-width: 620px/);
});

test("YouTube frames, canonical cast fields, PART 1-5, and end-video links are wired end to end", async () => {
  const studio = await readFile(new URL("app/seo-loop-app.tsx", root), "utf8");
  const production = await readFile(new URL("lib/unified-production.ts", root), "utf8");
  const route = await readFile(new URL("app/api/[[...path]]/route.ts", root), "utf8");
  const migration = await readFile(new URL("migrations/0008_youtube_metadata_and_cast.sql", root), "utf8");

  for (const field of [
    "challenger_company",
    "challenger_role",
    "challenger_name",
    "special_guest",
    "mc_name",
    "youtube_description",
    "youtube_chapters",
  ]) assert.match(studio, new RegExp(`name=["']${field}["']`));
  assert.match(studio, /youtube\/metadata\?url=/);
  assert.match(route, /youtube\/metadata/);
  assert.match(production, /youtube\/v3\/videos\?part=snippet/);
  assert.match(production, /i\.ytimg\.com\/vi/);
  assert.match(production, /v1\/images\/edits/);
  assert.match(production, /image\[\]/);
  assert.match(production, /quality", "max"/);
  assert.match(production, /固有名詞の正本/);
  assert.match(production, /文字起こし由来の別名/);
  assert.match(production, /youtube-video-link/);
  assert.match(production, /この動画をYouTubeで見る/);
  assert.match(production, /A TRUTH STORY/);
  assert.match(production, /PART \$\{source\.articleIndex \+ 1\}/);
  assert.match(production, /Math\.min\(5, Math\.max\(1/);
  assert.match(migration, /youtube_description/);
  assert.match(migration, /youtube_chapters/);
  assert.match(migration, /challenger_role/);
});

test("article batches become visible only after every article, image, and WordPress URL is complete", async () => {
  const studio = await readFile(new URL("app/seo-loop-app.tsx", root), "utf8");
  const production = await readFile(new URL("lib/unified-production.ts", root), "utf8");
  const route = await readFile(new URL("app/api/[[...path]]/route.ts", root), "utf8");
  const migration = await readFile(new URL("migrations/0009_atomic_article_batches.sql", root), "utf8");

  assert.match(production, /Promise\.all\(/);
  assert.match(production, /imageResult\.images\.length !== imageCount/);
  assert.match(production, /WordPress下書きURLを取得できませんでした/);
  assert.match(production, /UPDATE articles SET batch_ready=1 WHERE project_id=/);
  assert.match(production, /status='GENERATING' ORDER BY created_at DESC LIMIT 1/);
  assert.match(production, /articleCount - resumeRows\.length/);
  assert.match(route, /WHERE batch_ready=1 ORDER BY updated_at DESC/);
  assert.match(migration, /batch_ready INTEGER NOT NULL DEFAULT 1/);
  assert.match(studio, /visibleCreated\.length !== requestedCount/);
  assert.match(studio, /WordPress下書きURLを開く/);
  assert.match(studio, /WordPress下書きURL取得・記事カード反映がすべて完了/);
  assert.match(studio, /通信を自動再接続しています/);
  assert.match(studio, /project_id === project\.id/);
  assert.match(studio, /Date\.parse\(item\.created_at\) >= submittedAt - 60_000/);
});
