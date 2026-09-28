import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  articleBodyHtml,
  buildAnalysisSteps,
  buildMaterialStep,
  parseSeeds,
  buildFeaturedImageStep,
  sectionFrameTimes,
  timestampSeconds,
  parseClaudeArticle,
  parseSectionRewrite,
  validateMaterial,
} from "../lib/browser-pipeline.ts";

const material = {
  youtube_url: "https://www.youtube.com/watch?v=9kwwRmpmL14", youtube_title: "TKO木本 対談", youtube_description: "概要", youtube_chapters: "00:00 開始",
  transcript: "5:10 少年時代について語る。".repeat(20), direction: "", challenger_company: "株式会社テスト", challenger_role: "代表取締役",
  challenger_name: "青﨑曹", special_guest: "", mc_name: "宮崎宣子", article_limit: 3, category_id: "5", category_name: "対談",
};

// Mirrors the attribute-free HTML the extension serialises from Claude's rendered answer.
const claudeAnswer = `<div><h1>青﨑曹が語る挑戦の原点｜A TRUTH STORY</h1>
<ul><li>タイトルタグ: 青﨑曹の挑戦の原点</li><li><strong>メタディスクリプション</strong>: 説明文です。</li><li>スラッグ: aosaki-origin</li>
<li>主キーワード: 青﨑曹 経歴</li><li>関連キーワード: 起業、挑戦、経営者</li><li>検索意図: 経歴を知りたい</li><li>想定読者: 経営者</li><li>アイキャッチ画像指示: 右側に本人</li></ul>
<h2>はじめに</h2><p>導入です。</p>
<h2>少年時代</h2><p>本文1</p><p>画像指示: 幼少期を語る場面</p>
<h2>起業の決断</h2><p>本文2<br><strong>画像指示:</strong> 手振りを交えて話す場面</p>
<h2>挫折</h2><p>本文3</p><ul><li>画像指示：ワイドショット</li></ul>
<h2>これから</h2><h3>小見出し</h3><p>本文4</p><p><strong>画像指示</strong>：肩越し</p>
<h2>まとめ</h2><p>まとめです。</p></div>`;

test("material validation blocks missing essentials", () => {
  assert.doesNotThrow(() => validateMaterial(material));
  assert.throws(() => validateMaterial({ ...material, youtube_url: "https://example.com" }), /YouTube/);
  assert.throws(() => validateMaterial({ ...material, challenger_name: "" }), /出演者名/);
  assert.throws(() => validateMaterial({ ...material, transcript: "短い" }), /文字起こし/);
});

test("Claude reads the whole transcript first, then analyses API data, then writes each article", () => {
  const first = buildMaterialStep(material);
  assert.match(first.prompt, /文字起こし/);
  assert.ok(first.prompt.includes(material.transcript));
  assert.match(first.prompt, /挑戦者：株式会社テスト・代表取締役・青﨑曹/);
  assert.match(first.prompt, /全ての話題/);
  assert.match(first.prompt, /シードキーワード:/);
  const steps = buildAnalysisSteps({ ...material, article_limit: 9 }, "## Google Search Console（API取得）\n| クエリ |");
  assert.equal(steps.length, 6);
  assert.match(steps[0].prompt, /Google Search Console（API取得）/);
  assert.match(steps[0].prompt, /割り当て漏れゼロ/);
  for (const step of steps) assert.ok(!step.prompt.includes(material.transcript));
  assert.match(steps[2].prompt, /企画2/);
  assert.match(steps[1].prompt, /一つも省かず/);
});

test("seed keywords are read from the last machine line", () => {
  assert.deepEqual(parseSeeds("前置き\nシードキーワード: 例\n本文\nシードキーワード：木本武宏、TKO 木本 現在、「投資トラブル」、A"), ["木本武宏", "TKO 木本 現在", "投資トラブル"]);
  assert.deepEqual(parseSeeds("なし"), []);
});

test("rendered Claude article is parsed into SEO fields, sections and image prompts", () => {
  const article = parseClaudeArticle(claudeAnswer);
  assert.equal(article.title, "青﨑曹が語る挑戦の原点｜A TRUTH STORY");
  assert.equal(article.titleTag, "青﨑曹の挑戦の原点");
  assert.equal(article.metaDescription, "説明文です。");
  assert.equal(article.slug, "aosaki-origin");
  assert.deepEqual(article.relatedKeywords, ["起業", "挑戦", "経営者"]);
  assert.equal(article.featuredImagePrompt, "右側に本人");
  assert.equal(article.introHtml, "<p>導入です。</p>");
  assert.deepEqual(article.sections.map((s) => s.heading), ["少年時代", "起業の決断", "挫折", "これから"]);
  assert.deepEqual(article.sections.map((s) => s.imagePrompt), ["幼少期を語る場面", "手振りを交えて話す場面", "ワイドショット", "肩越し"]);
  for (const section of article.sections) assert.doesNotMatch(section.html, /画像指示/);
  assert.match(article.conclusionHtml, /<h2>まとめ<\/h2><p>まとめです。<\/p>/);
  const body = articleBodyHtml(article);
  assert.ok(body.startsWith("<p>導入です。</p><h2>少年時代</h2>"));
  assert.doesNotMatch(body, /はじめに/);
});

test("claude.ai heading demotion and thinking summary are normalised", () => {
  const demoted = "見出し構成を検討中。" + claudeAnswer.replace(/<(\/?)h([1-3])>/g, (_, slash, level) => `<${slash}h${Number(level) + 1}>`);
  const article = parseClaudeArticle(demoted);
  assert.equal(article.title, "青﨑曹が語る挑戦の原点｜A TRUTH STORY");
  assert.equal(article.sections.length, 4);
  assert.match(article.sections[3].html, /<h3>小見出し<\/h3>/);
  assert.equal(parseSectionRewrite("<h3>見出し</h3><p>本文</p>").heading, "見出し");
});

test("answers that are not an article are rejected with a readable message", () => {
  assert.throws(() => parseClaudeArticle("<p>承知しました。どの企画から書きますか？</p>"), /読み取れません/);
});

test("H2 images use real video times; only the eyecatch goes to ChatGPT", () => {
  const article = parseClaudeArticle(claudeAnswer.replace("幼少期を語る場面", "5:10 幼少期を語る場面").replace("<p>本文3</p>", "<p>本文3「発言」（12:34）</p>"));
  assert.deepEqual(sectionFrameTimes(article.sections), [310, -1, 754, -1]);
  assert.equal(timestampSeconds("1:02:03 場面"), 3723);
  assert.equal(timestampSeconds("場面のみ"), -1);
  const reference = { name: "ref.jpg", dataUrl: "data:image/jpeg;base64,AAAA" };
  const scene = { name: "scene.jpg", dataUrl: "data:image/jpeg;base64,BBBB" };
  const step = buildFeaturedImageStep(article, material, reference, scene, 2);
  assert.ok(step.expectImage);
  assert.deepEqual(step.attachments, [reference, scene]);
  assert.match(step.prompt, /PART 2/);
  assert.match(step.prompt, /A TRUTH STORY/);
  assert.equal(buildFeaturedImageStep(article, material, null, null, 1).attachments.length, 0);
});

test("section rewrite answer keeps heading and strips image prompt", () => {
  const result = parseSectionRewrite("<h2>新しい見出し</h2><p>書き直した本文</p><p>画像指示: 新しい場面</p>");
  assert.deepEqual(result, { heading: "新しい見出し", html: "<p>書き直した本文</p>", imagePrompt: "新しい場面" });
});

test("client never calls an AI API and WordPress stays draft-only", () => {
  const client = readFileSync(new URL("../app/seo-loop-app.tsx", import.meta.url), "utf8");
  const server = readFileSync(new URL("../lib/browser-production.ts", import.meta.url), "utf8");
  const route = readFileSync(new URL("../app/api/[[...path]]/route.ts", import.meta.url), "utf8");
  for (const source of [client, server, route]) assert.doesNotMatch(source, /api\.anthropic\.com|api\.openai\.com|getAnthropicApiKey|getOpenAiApiKey/);
  assert.match(server, /status: "draft"/);
  assert.doesNotMatch(server, /status: "publish"/);
  for (const label of ["ダッシュボード", "記事ライブラリー", "LLMO / AIO 分析", "レポート・PDCA", "挑戦者の会社名", "挑戦者の役職", "画像数（1記事あたり）", "WordPress投稿カテゴリー", "記事を作成する", "外部確認URL"])
    assert.ok(client.includes(label), label);
});
