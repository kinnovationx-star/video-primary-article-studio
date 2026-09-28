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
  assert.match(studio, /name="image_count"[\s\S]*value="5"[\s\S]*readOnly/);
  assert.match(studio, /5枚固定です/);
  assert.match(studio, /同じ画像や似た構図は使用しません/);
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
  assert.match(source, /変更を保存/);
  assert.match(source, /`articles\/\$\{item\.id\}`, "PATCH"/);
});

test("generated article cards stay below the studio form and expose Claude / ChatGPT editing", async () => {
  const source = await readFile(new URL("app/seo-loop-app.tsx", root), "utf8");
  assert.match(source, /<Library[\s\S]*embedded/);
  assert.match(source, /このH2本文をClaudeで書き直す/);
  assert.match(source, /この時刻の場面を動画から切り出す/);
  assert.match(source, /アイキャッチ画像を作り直す/);
  assert.match(source, /WordPressへ下書き保存/);
  assert.match(source, /provider: "claude"/);
  assert.match(source, /provider: "gpt"/);
});

test("WordPress drafts get a public preview URL shown on every card", async () => {
  const route = await readFile(new URL("app/api/[[...path]]/route.ts", root), "utf8");
  const production = await readFile(new URL("lib/unified-production.ts", root), "utf8");
  const browser = await readFile(new URL("lib/browser-production.ts", root), "utf8");
  const studio = await readFile(new URL("app/seo-loop-app.tsx", root), "utf8");
  assert.match(production, /DS_Public_Post_Preview::get_preview_link/);
  assert.match(production, /video-primary-article\/v1\/public-preview/);
  assert.match(browser, /enableWordPressPublicPreview/);
  assert.match(browser, /wordpress_public_preview_url/);
  assert.match(browser, /featured_media/);
  assert.match(browser, /youtube-video-link/);
  assert.match(browser, /この動画をYouTubeで見る/);
  assert.match(route, /path\[2\] === "wordpress"/);
  assert.match(route, /wordpress\/public-previews\/backfill/);
  assert.match(studio, /外部確認URL/);
  assert.match(studio, /wordpress_public_preview_url/);
});

test("video frames and GPT Image 2 create sharp 16:9 editorial visuals", async () => {
  const production = await readFile(new URL("lib/unified-production.ts", root), "utf8");
  const styles = await readFile(new URL("app/globals.css", root), "utf8");
  assert.match(production, /const IMAGE_MODEL = "gpt-image-2"/);
  assert.match(production, /2048x1152/);
  assert.match(production, /storyboard3|playerStoryboardSpecRenderer/);
  assert.match(production, /trim: \{ top, right, bottom, left \}/);
  assert.match(production, /動画内から取得した実際の対談フレーム/);
  assert.match(production, /ぼかし、ソフトフォーカス/);
  assert.match(production, /createSectionImageAsset/);
  assert.match(production, /const IMAGES_PER_ARTICLE = 5/);
  assert.match(production, /SECTION_SHOT_PLANS/);
  assert.match(production, /同一フレーム、同じポーズ/);
  assert.match(production, /imageCount = IMAGES_PER_ARTICLE/);
  assert.match(production, /article\.sections\.slice\(0, IMAGES_PER_ARTICLE - 1\)/);
  assert.doesNotMatch(production, /size: "1536x1024"/);
  assert.match(styles, /aspect-ratio: 16 \/ 9/);
  assert.match(styles, /max-width: 620px/);
});

test("YouTube details, canonical cast fields and PART numbers are wired end to end", async () => {
  const studio = await readFile(new URL("app/seo-loop-app.tsx", root), "utf8");
  const pipeline = await readFile(new URL("lib/browser-pipeline.ts", root), "utf8");
  const route = await readFile(new URL("app/api/[[...path]]/route.ts", root), "utf8");
  for (const field of ["challenger_company", "challenger_role", "challenger_name", "special_guest", "mc_name", "youtube_description", "youtube_chapters", "wordpress_category_id"])
    assert.match(studio, new RegExp(`name=["']${field}["']`));
  assert.match(studio, /youtube\/metadata\?url=/);
  assert.match(route, /youtube\/metadata/);
  assert.match(route, /youtube" && path\[1\] === "frame"/);
  assert.match(pipeline, /A TRUTH STORY/);
  assert.match(pipeline, /PART \$\{articleNumber\}/);
  assert.match(pipeline, /Math\.min\(5, Math\.max\(1/);
});

test("challenger reference image is stored and attached to every ChatGPT image request", async () => {
  const studio = await readFile(new URL("app/seo-loop-app.tsx", root), "utf8");
  const route = await readFile(new URL("app/api/[[...path]]/route.ts", root), "utf8");
  const pipeline = await readFile(new URL("lib/browser-pipeline.ts", root), "utf8");
  assert.match(studio, /挑戦者本人の参照画像/);
  assert.match(studio, /accept="image\/jpeg,image\/png,image\/webp"/);
  assert.match(studio, /アイキャッチと全H2画像を作り直す/);
  assert.match(route, /route === "challenger-reference"/);
  assert.match(route, /challenger-references\//);
  assert.match(pipeline, /添付1枚目は挑戦者/);
  assert.match(studio, /captureFrames/);
});

test("progress reaches 100% only after articles, images and WordPress drafts are all done", async () => {
  const studio = await readFile(new URL("app/seo-loop-app.tsx", root), "utf8");
  assert.match(studio, /Math\.min\(99, percent\)/);
  assert.match(studio, /percent: 100, detail, status: "completed"/);
  assert.match(studio, /pipeline\.phase = "done"/);
  assert.match(studio, /PIPELINE_KEY/);
  assert.match(studio, /制作を再開/);
});
