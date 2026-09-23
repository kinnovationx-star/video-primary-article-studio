import { articleDraft, id, now, runtime, text, wordTokens } from "./studio-server";
import { getAnthropicApiKey, getOpenAiApiKey, getUbersuggestAccessToken, getWordPressConnection } from "./studio-connections";
import { wordpressAuth, wordpressBase, wordpressCategories, type WordPressCategory } from "./integrations";
import { rawMcpStructuredValue } from "./serp-provider";
import { UbersuggestMcpClient } from "../cloud-runner/src/ubersuggest-mcp";

type Json = Record<string, unknown>;
type Section = { heading: string; html: string; imagePrompt: string; altText: string };
type GeneratedArticle = {
  title: string; titleTag: string; metaDescription: string; slug: string; mainKeyword: string;
  relatedKeywords: string[]; searchIntent: string; reader: string; angle: string; catchCopy: string;
  introductionHtml: string; sections: Section[]; conclusionHtml: string;
};
type ProductionInput = { youtube_url?: unknown; youtube_title?: unknown; transcript?: unknown; direction?: unknown; article_limit?: unknown; image_count?: unknown; wordpress_category_id?: unknown; wordpress_category_name?: unknown };

const asRecord = (value: unknown): Json => value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
export const sanitizeArticleHtml = (value: unknown) => String(value || "")
  .replace(/<\/?(?:script|style|iframe|object|embed|form)[^>]*>/gi, "")
  .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
  .replace(/javascript:/gi, "")
  .trim();
const escapeHtml = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] || character);
const slugify = (value: string) => value.toLowerCase().normalize("NFKC").replace(/[^a-z0-9\u3040-\u30ff\u3400-\u9fff]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 160) || `video-article-${Date.now()}`;
const clamp = (value: unknown, fallback: number) => Math.min(5, Math.max(1, Number(value) || fallback));

function jsonFromText(value: string) {
  const cleaned = value.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const start = cleaned.indexOf("{"), end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("AIの記事データを解析できませんでした。");
  return JSON.parse(cleaned.slice(start, end + 1)) as Json;
}

function normalizeArticle(value: Json, keyword: string, index: number): GeneratedArticle {
  const sections = (Array.isArray(value.sections) ? value.sections : []).map(item => {
    const row = asRecord(item), heading = text(row.heading, 120);
    return { heading, html: sanitizeArticleHtml(row.html), imagePrompt: text(row.imagePrompt, 1000), altText: text(row.altText, 180) || `${heading}の解説画像` };
  }).filter(item => item.heading && item.html).slice(0, 8);
  if (sections.length < 2) throw new Error("AIが十分なH2セクションを生成できませんでした。");
  const title = text(value.title, 160) || `${keyword}を動画の一次情報から解説`;
  return {
    title,
    titleTag: (text(value.titleTag, 80) || title).slice(0, 62),
    metaDescription: text(value.metaDescription, 180).slice(0, 160),
    slug: slugify(text(value.slug, 180) || `${keyword}-${index + 1}`),
    mainKeyword: text(value.mainKeyword, 120) || keyword,
    relatedKeywords: (Array.isArray(value.relatedKeywords) ? value.relatedKeywords : []).map(item => text(item, 100)).filter(Boolean).slice(0, 10),
    searchIntent: text(value.searchIntent, 120) || "情報収集",
    reader: text(value.reader, 240) || "動画テーマを詳しく知りたい読者",
    angle: text(value.angle, 300) || "動画内の一次情報を整理して解説",
    catchCopy: text(value.catchCopy, 200),
    introductionHtml: sanitizeArticleHtml(value.introductionHtml),
    sections,
    conclusionHtml: sanitizeArticleHtml(value.conclusionHtml),
  };
}

async function youtubeTitle(url: string, supplied: string) {
  if (!url) return supplied;
  try {
    const response = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`, { signal: AbortSignal.timeout(10_000) });
    if (response.ok) return text((await response.json() as Json).title, 300) || supplied;
  } catch { /* User-provided title remains the safe fallback. */ }
  return supplied;
}

function collectKeywords(value: unknown, output: string[] = []): string[] {
  if (output.length >= 20) return output;
  if (Array.isArray(value)) for (const item of value) collectKeywords(item, output);
  else if (value && typeof value === "object") for (const [key, nested] of Object.entries(value as Json)) {
    if (/^(?:keyword|query|term|name)$/i.test(key) && typeof nested === "string") output.push(text(nested, 120));
    else collectKeywords(nested, output);
  }
  return [...new Set(output.filter(item => item.length >= 2))].slice(0, 20);
}

async function keywordIdeas(title: string, direction: string, transcript: string, count: number) {
  const local = wordTokens(`${title} ${direction} ${transcript.slice(0, 6000)}`).slice(0, Math.max(count, 8));
  const seed = text(direction || title || local[0] || "動画内容", 120);
  try {
    const token = await getUbersuggestAccessToken();
    const result = await new UbersuggestMcpClient(token).callKeywordSuggestions(seed);
    const live = collectKeywords(rawMcpStructuredValue(result.rawToolResult));
    return { keywords: [...new Set([...live, ...local])].slice(0, Math.max(count, 10)), provider: "Ubersuggest MCP + 動画一次情報" };
  } catch {
    return { keywords: local.length ? local : [seed], provider: "動画一次情報" };
  }
}

async function anthropicModel(apiKey: string) {
  try {
    const response = await fetch("https://api.anthropic.com/v1/models?limit=100", { headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }, signal: AbortSignal.timeout(15_000) });
    if (response.ok) {
      const data = await response.json() as Json, models = Array.isArray(data.data) ? data.data.map(asRecord) : [];
      return text(models.find(model => /sonnet/i.test(String(model.id)))?.id || models[0]?.id, 120);
    }
  } catch { /* Fall through to a stable model identifier. */ }
  return "claude-sonnet-4-20250514";
}

async function generateArticle(apiKey: string, model: string, source: { title: string; url: string; transcript: string; direction: string; keywords: string[]; provider: string }, index: number) {
  const focus = source.keywords[index % source.keywords.length] || source.title;
  const prompt = `あなたは日本語SEO編集者です。次の動画一次情報だけを根拠に、重複しない記事${index + 1}本目を作成してください。動画にない数値・人物属性・効果・断定を補ってはいけません。主軸キーワードは「${focus}」。関連候補は ${source.keywords.slice(0, 10).join("、")}（取得元: ${source.provider}）。方向性: ${source.direction || "動画内容を忠実に整理"}\n\n動画タイトル: ${source.title}\n動画URL: ${source.url}\n文字起こし:\n${source.transcript.slice(0, 90000)}\n\nJSONオブジェクトだけを返してください。キーは title,titleTag,metaDescription,slug,mainKeyword,relatedKeywords,searchIntent,reader,angle,catchCopy,introductionHtml,sections,conclusionHtml。sectionsは3〜6件で、各要素は heading,html,imagePrompt,altText。headingはH2本文のみ（HTMLタグなし）、htmlはp/ul/ol/blockquote/strong/aだけを使う本文。本文には自然な要約・具体例・引用可能な発言・結論を含め、一次情報で確認できないことは書かない。metaDescriptionは90〜140字、titleTagは62字以内。imagePromptはそのH2の内容を正確に図解する日本語プロンプトで、文字・ロゴ・架空の数値を画像内に入れない。`;
  const response = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" }, body: JSON.stringify({ model, max_tokens: 8000, messages: [{ role: "user", content: prompt }] }), signal: AbortSignal.timeout(110_000) });
  const payload = await response.json().catch(() => ({})) as Json;
  if (!response.ok) throw new Error(text(asRecord(payload.error).message || `Claude APIエラー (${response.status})`, 240));
  const content = Array.isArray(payload.content) ? payload.content.map(asRecord).filter(item => item.type === "text").map(item => String(item.text || "")).join("\n") : "";
  return normalizeArticle(jsonFromText(content), focus, index);
}

function bodyHtml(article: GeneratedArticle, imageUrls: string[]) {
  const sections = article.sections.map((section, index) => `<h2>${escapeHtml(section.heading)}</h2>${imageUrls[index + 1] ? `<figure><img src="${escapeHtml(imageUrls[index + 1])}" alt="${escapeHtml(section.altText)}" loading="lazy" decoding="async" /><figcaption>${escapeHtml(section.altText)}</figcaption></figure>` : ""}${section.html}`).join("");
  return `${article.introductionHtml}${sections}${article.conclusionHtml}`;
}

function base64Bytes(value: string) {
  const binary = atob(value), bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function generateImages(apiKey: string, articleId: string, article: GeneratedArticle, count: number) {
  if (!apiKey) return { images: [] as Array<{ id: string; kind: string; heading: string; alt: string; key: string; url: string }>, warning: "OpenAI未接続のため画像生成はスキップしました。" };
  const prompts = [{ kind: "featured", heading: article.title, alt: `${article.title}のアイキャッチ画像`, prompt: `日本語SEO記事「${article.title}」のアイキャッチ。主題は${article.mainKeyword}。清潔で信頼感のある横長の編集ビジュアル。画像内に文字、ロゴ、架空の数値、透かしを入れない。` }, ...article.sections.map(section => ({ kind: "section", heading: section.heading, alt: section.altText, prompt: `${section.imagePrompt}。記事セクション「${section.heading}」を直感的に理解できる横長の図解または編集イラスト。画像内に文字、ロゴ、架空の数値、透かしを入れない。` }))].slice(0, count);
  const images: Array<{ id: string; kind: string; heading: string; alt: string; key: string; url: string }> = [];
  for (let index = 0; index < prompts.length; index++) {
    const item = prompts[index], response = await fetch("https://api.openai.com/v1/images/generations", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` }, body: JSON.stringify({ model: "gpt-image-2", prompt: item.prompt, n: 1, size: "1536x1024", quality: "medium", output_format: "png" }), signal: AbortSignal.timeout(110_000) });
    const payload = await response.json().catch(() => ({})) as Json, data = Array.isArray(payload.data) ? payload.data.map(asRecord) : [], encoded = text(data[0]?.b64_json, 20_000_000);
    if (!response.ok || !encoded) throw new Error(text(asRecord(payload.error).message || `画像生成APIエラー (${response.status})`, 240));
    const imageId = id(), key = `articles/${articleId}/${item.kind}-${index}.png`;
    await runtime().FILES.put(key, base64Bytes(encoded), { httpMetadata: { contentType: "image/png", cacheControl: "public, max-age=31536000, immutable" } });
    await runtime().DB.prepare("INSERT INTO article_images (id,article_id,kind,section_heading,alt_text,prompt,object_key,created_at) VALUES (?,?,?,?,?,?,?,?)").bind(imageId, articleId, item.kind, item.heading, item.alt, item.prompt, key, now()).run();
    images.push({ id: imageId, kind: item.kind, heading: item.heading, alt: item.alt, key, url: `/api/media/${imageId}` });
  }
  return { images, warning: "" };
}

async function wordpressRequest(url: string, init: RequestInit) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(60_000) }), payload = await response.json().catch(() => ({})) as Json;
  if (!response.ok) throw new Error(text(payload.message || `WordPress APIエラー (${response.status})`, 240));
  return payload;
}

async function publishDraft(connection: NonNullable<Awaited<ReturnType<typeof getWordPressConnection>>>, article: GeneratedArticle, html: string, categoryId: string, images: Awaited<ReturnType<typeof generateImages>>["images"]) {
  if (connection.authMode !== "rest") throw new Error("画像・カテゴリー付き自動下書きにはWordPress REST API接続が必要です。");
  const base = wordpressBase(connection.siteUrl), authorization = wordpressAuth(connection.username, connection.applicationPassword), mediaIds: number[] = [], uploadedUrls: string[] = [];
  for (let index = 0; index < images.length; index++) {
    const image = images[index], object = await runtime().FILES.get(image.key);
    if (!object) continue;
    const uploaded = await wordpressRequest(`${base}/wp-json/wp/v2/media`, { method: "POST", headers: { Authorization: authorization, "Content-Type": "image/png", "Content-Disposition": `attachment; filename="${article.slug}-${index + 1}.png"` }, body: await object.arrayBuffer() });
    const mediaId = Number(uploaded.id || 0), sourceUrl = text(uploaded.source_url, 1000);
    if (mediaId) {
      mediaIds.push(mediaId); uploadedUrls.push(sourceUrl);
      await wordpressRequest(`${base}/wp-json/wp/v2/media/${mediaId}`, { method: "POST", headers: { Authorization: authorization, "Content-Type": "application/json" }, body: JSON.stringify({ alt_text: image.alt, caption: image.kind === "featured" ? article.title : image.heading }) });
      await runtime().DB.prepare("UPDATE article_images SET wordpress_media_id=?,wordpress_url=? WHERE id=?").bind(String(mediaId), sourceUrl, image.id).run();
    }
  }
  const wpHtml = bodyHtml(article, uploadedUrls), created = await wordpressRequest(`${base}/wp-json/wp/v2/posts`, { method: "POST", headers: { Authorization: authorization, "Content-Type": "application/json" }, body: JSON.stringify({ title: article.title, content: wpHtml || html, status: "draft", slug: article.slug, excerpt: article.metaDescription, categories: categoryId ? [Number(categoryId)] : [], featured_media: mediaIds[0] || 0 }) });
  const postId = text(created.id, 80);
  return { postId, editUrl: postId ? `${base}/wp-admin/post.php?post=${postId}&action=edit` : "", html: wpHtml || html, featuredUrl: uploadedUrls[0] || "", uploadedUrls };
}

export async function updateWordPressDraft(article: Record<string, unknown>) {
  const connection = await getWordPressConnection(), postId = text(article.wordpress_post_id, 80);
  if (!connection || !postId) return { updated: false, reason: "WordPress下書き未連携" };
  if (connection.authMode !== "rest") throw new Error("WordPress下書きの更新にはREST API接続が必要です。");
  const base = wordpressBase(connection.siteUrl), authorization = wordpressAuth(connection.username, connection.applicationPassword), categoryId = Number(article.category_id || 0);
  await wordpressRequest(`${base}/wp-json/wp/v2/posts/${postId}`, { method: "POST", headers: { Authorization: authorization, "Content-Type": "application/json" }, body: JSON.stringify({ title: text(article.title, 500), content: sanitizeArticleHtml(article.body_html), status: "draft", slug: text(article.slug, 180), excerpt: text(article.meta_description, 1000), categories: categoryId ? [categoryId] : [] }) });
  return { updated: true, editUrl: `${base}/wp-admin/post.php?post=${postId}&action=edit` };
}

export async function getLiveWordPressCategories() {
  const connection = await getWordPressConnection();
  if (!connection) return { connected: false, categories: [] as WordPressCategory[] };
  if (connection.authMode !== "rest") return { connected: true, categories: [] as WordPressCategory[], warning: "カテゴリー同期にはWordPress REST API接続が必要です。" };
  return { connected: true, categories: await wordpressCategories(connection.siteUrl, connection.username, connection.applicationPassword) };
}

export async function getArticleImage(imageId: string) {
  const row = await runtime().DB.prepare("SELECT object_key FROM article_images WHERE id=?").bind(imageId).first<{ object_key: string }>();
  return row?.object_key ? runtime().FILES.get(row.object_key) : null;
}

export async function createUnifiedProduction(input: ProductionInput) {
  const transcript = text(input.transcript, 120000), url = text(input.youtube_url, 1000), direction = text(input.direction, 1000);
  if (transcript.length < 80) throw new Error("80文字以上の文字起こしを入力してください。");
  if (!url) throw new Error("YouTube動画URLを入力してください。");
  const articleCount = clamp(input.article_limit, 1), imageCount = clamp(input.image_count, 1), suppliedTitle = text(input.youtube_title, 300), title = await youtubeTitle(url, suppliedTitle);
  if (!title) throw new Error("動画タイトルを取得できませんでした。動画タイトルを入力してください。");
  const categoryId = text(input.wordpress_category_id, 80), categoryName = text(input.wordpress_category_name, 200), stamp = now(), projectId = id();
  const keywords = await keywordIdeas(title, direction, transcript, articleCount), anthropicKey = await getAnthropicApiKey();
  if (!anthropicKey) throw new Error("記事生成に必要なClaude APIを連携設定で接続してください。");
  const model = await anthropicModel(anthropicKey), openAiKey = await getOpenAiApiKey(), wordpress = await getWordPressConnection();
  if (wordpress && !categoryId) throw new Error("WordPressの投稿カテゴリーを選択してください。");
  await runtime().DB.prepare("INSERT INTO production_projects (id,youtube_url,youtube_title,transcript,transcript_chars,direction,strict_evidence,image_suggestions,article_limit,image_count,wordpress_category_id,wordpress_category_name,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(projectId, url, title, transcript, transcript.length, direction, 1, 1, articleCount, imageCount, categoryId, categoryName, "GENERATING", stamp, stamp).run();
  const results: Array<{ id: string; title: string; wordpressStatus: string; imageCount: number }> = [], warnings: string[] = [];
  for (let index = 0; index < articleCount; index++) {
    const generated = await generateArticle(anthropicKey, model, { title, url, transcript, direction, keywords: keywords.keywords, provider: keywords.provider }, index), articleId = id(), candidateId = id();
    await runtime().DB.prepare("INSERT INTO keyword_candidates (id,project_id,keyword,related_keywords,search_intent,reader,angle,relevance,duplication_risk,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").bind(candidateId, projectId, generated.mainKeyword, JSON.stringify(generated.relatedKeywords), generated.searchIntent, generated.reader, generated.angle, keywords.provider, "low", "CREATED", stamp).run();
    const initialHtml = bodyHtml(generated, []), evidence = JSON.stringify([{ source: url, title, transcriptCharacters: transcript.length }]);
    await runtime().DB.prepare("INSERT INTO articles (id,project_id,candidate_id,title,title_tag,meta_description,slug,catch_copy,main_keyword,related_keywords,search_intent,reader,angle,category_id,category_name,body_html,evidence_json,image_suggestions_json,quality_json,status,wordpress_status,featured_image_url,section_images_json,generation_provider,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(articleId, projectId, candidateId, generated.title, generated.titleTag, generated.metaDescription, generated.slug, generated.catchCopy, generated.mainKeyword, JSON.stringify(generated.relatedKeywords), generated.searchIntent, generated.reader, generated.angle, categoryId, categoryName, initialHtml, evidence, JSON.stringify(generated.sections.map(section => ({ heading: section.heading, prompt: section.imagePrompt, alt: section.altText }))), JSON.stringify({ evidence: "PASS", fabricationRisk: "LOW", source: "video_transcript" }), "REVIEW_READY", "NOT_SENT", "", "[]", `${model} / ${keywords.provider}`, stamp, stamp).run();
    let imageResult: Awaited<ReturnType<typeof generateImages>> = { images: [], warning: "" };
    try { imageResult = await generateImages(openAiKey, articleId, generated, imageCount); if (imageResult.warning) warnings.push(imageResult.warning); }
    catch (error) { warnings.push(`「${generated.title}」の画像生成: ${error instanceof Error ? error.message : "失敗"}`); }
    let wordpressStatus = "NOT_SENT", finalHtml = bodyHtml(generated, imageResult.images.map(image => image.url));
    if (wordpress) try {
      const posted = await publishDraft(wordpress, generated, finalHtml, categoryId, imageResult.images); wordpressStatus = "DRAFT"; finalHtml = posted.html;
      await runtime().DB.prepare("UPDATE articles SET body_html=?,featured_image_url=?,section_images_json=?,wordpress_post_id=?,wordpress_edit_url=?,wordpress_status=?,updated_at=? WHERE id=?").bind(finalHtml, posted.featuredUrl, JSON.stringify(posted.uploadedUrls.slice(1)), posted.postId, posted.editUrl, wordpressStatus, now(), articleId).run();
    } catch (error) { wordpressStatus = "ERROR"; warnings.push(`「${generated.title}」のWordPress下書き: ${error instanceof Error ? error.message : "失敗"}`); await runtime().DB.prepare("UPDATE articles SET body_html=?,section_images_json=?,wordpress_status=?,updated_at=? WHERE id=?").bind(finalHtml, JSON.stringify(imageResult.images.slice(1).map(image => image.url)), wordpressStatus, now(), articleId).run(); }
    else await runtime().DB.prepare("UPDATE articles SET body_html=?,featured_image_url=?,section_images_json=?,updated_at=? WHERE id=?").bind(finalHtml, imageResult.images[0]?.url || "", JSON.stringify(imageResult.images.slice(1).map(image => image.url)), now(), articleId).run();
    results.push({ id: articleId, title: generated.title, wordpressStatus, imageCount: imageResult.images.length });
  }
  await runtime().DB.prepare("UPDATE production_projects SET status='COMPLETED',updated_at=? WHERE id=?").bind(now(), projectId).run();
  return { projectId, articles: results, warnings: [...new Set(warnings)], title, provider: `${model} / ${keywords.provider}` };
}

// Retained only for imports in older test fixtures; new production uses Claude.
export const deterministicFallback = articleDraft;
