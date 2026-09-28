// Server side of the browser production flow. Articles and images are produced in the
// user's logged-in Claude / ChatGPT screens; this module only stores them (D1 / R2) and
// saves WordPress drafts through the WordPress REST API. No AI API is called here.
import { id, now, parse, runtime, text } from "./studio-server";
import { getWordPressConnection } from "./studio-connections";
import { wordpressAuth, wordpressBase } from "./integrations";
import {
  descriptionChapters,
  enableWordPressPublicPreview,
  getYouTubeMetadata,
  escapeHtml,
  retry,
  sanitizeArticleHtml,
  wordpressRequest,
  youtubeVideoId,
} from "./unified-production";

type Row = Record<string, unknown>;
type ImageRow = { id: string; kind: string; section_heading: string; section_index: number; alt_text: string; prompt: string; object_key: string; wordpress_media_id: string | null; wordpress_url: string; created_at: string };

const rows = async <T = Row>(query: string, ...values: unknown[]) =>
  (await runtime().DB.prepare(query).bind(...values).all<T>()).results;

export async function wordpressState() {
  const connection = await getWordPressConnection().catch(() => null);
  return connection ? { connected: true, siteUrl: wordpressBase(connection.siteUrl), authMode: connection.authMode } : { connected: false, siteUrl: "", authMode: "" };
}

export async function listArticles() {
  const articles = await rows(
    "SELECT a.*,p.challenger_image_key,p.youtube_url,p.youtube_title,p.challenger_name,p.challenger_company,p.challenger_role FROM articles a JOIN production_projects p ON p.id=a.project_id WHERE a.batch_ready=1 ORDER BY a.updated_at DESC",
  );
  return articles.map((row) => ({ ...row, related_keywords: parse(String(row.related_keywords || "[]"), []) }));
}

// ---------- create articles from Claude answers ----------

type IncomingArticle = {
  title?: unknown; titleTag?: unknown; metaDescription?: unknown; slug?: unknown; mainKeyword?: unknown;
  relatedKeywords?: unknown; searchIntent?: unknown; reader?: unknown; bodyHtml?: unknown;
  featuredImagePrompt?: unknown; sections?: unknown; conversationUrl?: unknown;
};

export async function createBrowserProduction(body: Row) {
  const material = (body.material || {}) as Row;
  const incoming = Array.isArray(body.articles) ? (body.articles as IncomingArticle[]) : [];
  const productionId = text(body.productionId, 80);
  if (!incoming.length || incoming.length > 5) throw new Error("保存する記事がありません。");
  if (!youtubeVideoId(text(material.youtube_url, 500))) throw new Error("YouTube動画URLを確認してください。");
  // Idempotent: a retried save for the same production returns the rows already stored.
  if (productionId) {
    const existing = await rows<{ id: string }>("SELECT id FROM articles WHERE project_id=? ORDER BY created_at, rowid", productionId);
    if (existing.length) return { projectId: productionId, articleIds: existing.map((row) => row.id) };
  }
  const projectId = productionId || id(), stamp = now();
  const statements = [
    runtime().DB.prepare(
      "INSERT INTO production_projects (id,youtube_url,youtube_title,transcript,transcript_chars,direction,challenger_name,challenger_company,challenger_role,special_guest,mc_name,article_limit,image_count,wordpress_category_id,wordpress_category_name,youtube_description,youtube_chapters,challenger_image_key,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).bind(
      projectId, text(material.youtube_url, 500), text(material.youtube_title, 300), text(material.transcript, 120000), text(material.transcript, 120000).length,
      text(material.direction, 1000), text(material.challenger_name, 200), text(material.challenger_company, 200), text(material.challenger_role, 200),
      text(material.special_guest, 300), text(material.mc_name, 200), incoming.length, 5, text(material.category_id, 40), text(material.category_name, 200),
      text(material.youtube_description, 30000), text(material.youtube_chapters, 12000), text(material.challenger_image_key, 300), "COMPLETED", stamp, stamp,
    ),
  ];
  const articleIds: string[] = [];
  incoming.forEach((article, index) => {
    const articleId = id();
    articleIds.push(articleId);
    const sections = Array.isArray(article.sections) ? (article.sections as Row[]) : [];
    const suggestions = [
      { heading: "", prompt: text(article.featuredImagePrompt, 2000), alt: `${text(article.title, 300)}｜A TRUTH STORY` },
      ...sections.map((section) => ({ heading: text(section.heading, 300), prompt: text(section.imagePrompt, 2000), alt: `${text(section.heading, 300)}の対談シーン` })),
    ];
    statements.push(
      runtime().DB.prepare(
        "INSERT INTO articles (id,project_id,title,title_tag,meta_description,slug,main_keyword,related_keywords,search_intent,reader,angle,conversation_url,category_id,category_name,body_html,image_suggestions_json,status,wordpress_status,generation_provider,batch_ready,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      ).bind(
        articleId, projectId, text(article.title, 300), text(article.titleTag, 200), text(article.metaDescription, 400),
        text(article.slug, 180) || `${youtubeVideoId(text(material.youtube_url, 500)).toLowerCase()}-part-${index + 1}`,
        text(article.mainKeyword, 200), JSON.stringify(Array.isArray(article.relatedKeywords) ? article.relatedKeywords.map((item) => text(item, 100)).filter(Boolean).slice(0, 10) : []),
        text(article.searchIntent, 500), text(article.reader, 500), "動画一次情報", /^https:\/\/claude\.ai\/chat\//.test(text(article.conversationUrl, 500)) ? text(article.conversationUrl, 500) : "", text(material.category_id, 40), text(material.category_name, 200),
        sanitizeArticleHtml(text(article.bodyHtml, 200000)), JSON.stringify(suggestions), "REVIEW_READY", "NOT_SENT", "claude-browser", 1, stamp,
        // Keep the requested order stable in the library.
        new Date(Date.parse(stamp) - index).toISOString(),
      ),
    );
  });
  await runtime().DB.batch(statements);
  return { projectId, articleIds };
}

// ---------- images produced in ChatGPT ----------

export async function saveArticleImage(articleId: string, body: Row) {
  const article = await runtime().DB.prepare("SELECT id,section_images_json FROM articles WHERE id=?").bind(articleId).first<Row>();
  if (!article) throw new Error("対象の記事が見つかりません。");
  const match = String(body.dataUrl || "").match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/);
  if (!match) throw new Error("画像データの形式が正しくありません。");
  const bytes = Uint8Array.from(atob(match[2]), (character) => character.charCodeAt(0));
  if (bytes.length < 1000 || bytes.length > 15 * 1024 * 1024) throw new Error("画像サイズが正しくありません（15MBまで）。");
  const kind = body.kind === "featured" ? "featured" : "section",
    sectionIndex = kind === "featured" ? -1 : Math.max(0, Math.min(10, Number(body.sectionIndex) || 0)),
    imageId = id(),
    extension = match[1] === "jpeg" ? "jpg" : match[1],
    key = `article-images/${articleId}/${imageId}.${extension}`;
  await runtime().FILES.put(key, bytes, { httpMetadata: { contentType: `image/${match[1]}` } });
  await runtime().DB.prepare(
    "INSERT INTO article_images (id,article_id,kind,section_heading,section_index,alt_text,prompt,object_key,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
  ).bind(imageId, articleId, kind, text(body.heading, 300), sectionIndex, text(body.alt, 300), text(body.prompt, 4000), key, now()).run();
  const url = `/api/media/${imageId}`;
  if (kind === "featured") await runtime().DB.prepare("UPDATE articles SET featured_image_url=?,updated_at=? WHERE id=?").bind(url, now(), articleId).run();
  else {
    const list = parse<string[]>(String(article.section_images_json || "[]"), []);
    list[sectionIndex] = url;
    await runtime().DB.prepare("UPDATE articles SET section_images_json=?,updated_at=? WHERE id=?").bind(JSON.stringify(list), now(), articleId).run();
  }
  return { id: imageId, kind, section_heading: text(body.heading, 300), section_index: sectionIndex, alt_text: text(body.alt, 300), url };
}

async function latestImages(articleId: string) {
  const images = await rows<ImageRow>("SELECT * FROM article_images WHERE article_id=? ORDER BY created_at DESC", articleId);
  return images;
}

export async function listArticleImages(articleId: string) {
  const images = await latestImages(articleId), seen = new Set<string>();
  return images
    .filter((image) => {
      const slot = image.kind === "featured" ? "featured" : Number(image.section_index) >= 0 ? `index:${image.section_index}` : `heading:${image.section_heading}`;
      if (seen.has(slot)) return false;
      seen.add(slot);
      return true;
    })
    .map((image) => ({ id: image.id, kind: image.kind, section_heading: image.section_heading, section_index: Number(image.section_index), alt_text: image.alt_text, prompt: image.prompt, url: `/api/media/${image.id}` }));
}

export async function articleContext(articleId: string) {
  const row = await runtime().DB.prepare(
    "SELECT p.youtube_url,p.youtube_title,p.transcript,p.youtube_description,p.challenger_name,p.challenger_company,p.challenger_role,p.special_guest,p.mc_name,p.challenger_image_key FROM articles a JOIN production_projects p ON p.id=a.project_id WHERE a.id=?",
  ).bind(articleId).first<Row>();
  if (!row) throw new Error("対象の記事が見つかりません。");
  return row;
}

export async function mediaObject(imageId: string) {
  const row = await runtime().DB.prepare("SELECT object_key FROM article_images WHERE id=?").bind(imageId).first<{ object_key: string }>();
  return row?.object_key ? runtime().FILES.get(row.object_key) : null;
}

// ---------- WordPress draft + public preview URL ----------

const contentHeadings = (html: string) =>
  [...html.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi)].map((match) => ({ match, heading: match[1].replace(/<[^>]+>/g, "").trim() }));

export function composeWordPressHtml(
  bodyHtml: string,
  sectionFigures: Array<{ url: string; alt: string } | undefined>,
  video: { url: string; title: string; videoId: string },
) {
  const clean = sanitizeArticleHtml(bodyHtml)
    .replace(/<figure class="(?:video-scene|youtube-video-link)"[\s\S]*?<\/figure>/g, "");
  let output = "", cursor = 0, contentIndex = 0;
  for (const { match, heading } of contentHeadings(clean)) {
    const end = (match.index || 0) + match[0].length;
    output += clean.slice(cursor, end);
    cursor = end;
    if (/^(はじめに|まとめ|おわりに)/.test(heading)) continue;
    const figure = sectionFigures[contentIndex++];
    if (figure?.url)
      output += `<figure class="video-scene"><img src="${escapeHtml(figure.url)}" alt="${escapeHtml(figure.alt)}" width="1280" height="720" loading="lazy" decoding="async" style="display:block;width:100%;max-width:720px;height:auto;aspect-ratio:16/9;object-fit:cover;margin:0 auto" /></figure>`;
  }
  output += clean.slice(cursor);
  if (video.videoId) {
    const thumbnail = `https://i.ytimg.com/vi/${encodeURIComponent(video.videoId)}/maxresdefault.jpg`;
    output += `<figure class="youtube-video-link" style="margin:40px auto 0;max-width:720px"><a href="${escapeHtml(video.url)}" target="_blank" rel="noopener noreferrer" aria-label="${escapeHtml(video.title)}をYouTubeで見る"><img src="${thumbnail}" alt="${escapeHtml(video.title)}のYouTubeサムネイル" width="1280" height="720" loading="lazy" decoding="async" style="display:block;width:100%;height:auto;aspect-ratio:16/9;object-fit:cover" /></a><figcaption style="text-align:center"><a href="${escapeHtml(video.url)}" target="_blank" rel="noopener noreferrer">この動画をYouTubeで見る</a></figcaption></figure>`;
  }
  return output;
}

export async function syncWordPressDraft(articleId: string) {
  const connection = await getWordPressConnection();
  if (!connection) throw new Error("WordPressが未接続です。連携設定でWordPressを接続してください。");
  if (connection.authMode !== "rest") throw new Error("WordPress下書き保存にはREST API（アプリケーションパスワード）接続が必要です。");
  const article = await runtime().DB.prepare(
    "SELECT a.*,p.youtube_url,p.youtube_title FROM articles a JOIN production_projects p ON p.id=a.project_id WHERE a.id=?",
  ).bind(articleId).first<Row>();
  if (!article) throw new Error("対象の記事が見つかりません。");
  const base = wordpressBase(connection.siteUrl),
    authorization = wordpressAuth(connection.username, connection.applicationPassword),
    slug = text(article.slug, 180),
    images = await latestImages(articleId);
  const upload = async (image: ImageRow | undefined, caption: string) => {
    if (!image) return undefined;
    if (image.wordpress_media_id && image.wordpress_url) return { mediaId: Number(image.wordpress_media_id), url: image.wordpress_url, alt: image.alt_text };
    const object = await runtime().FILES.get(image.object_key);
    if (!object) return undefined;
    const extension = image.object_key.split(".").pop() || "png", bytes = await object.arrayBuffer();
    const uploaded = await retry(() => wordpressRequest(`${base}/wp-json/wp/v2/media`, {
      method: "POST",
      headers: { Authorization: authorization, "Content-Type": object.httpMetadata?.contentType || "image/png", "Content-Disposition": `attachment; filename="${slug || "article"}-${image.id.slice(0, 8)}.${extension}"` },
      body: bytes,
    }), 2);
    const mediaId = Number(uploaded.id || 0), url = text(uploaded.source_url, 1000);
    if (!mediaId || !url) return undefined;
    await wordpressRequest(`${base}/wp-json/wp/v2/media/${mediaId}`, {
      method: "POST",
      headers: { Authorization: authorization, "Content-Type": "application/json" },
      body: JSON.stringify({ alt_text: image.alt_text, caption }),
    }).catch(() => undefined);
    await runtime().DB.prepare("UPDATE article_images SET wordpress_media_id=?,wordpress_url=? WHERE id=?").bind(String(mediaId), url, image.id).run();
    return { mediaId, url, alt: image.alt_text };
  };
  const bodyHtml = String(article.body_html || "");
  const headings = contentHeadings(bodyHtml).map((item) => item.heading).filter((heading) => !/^(はじめに|まとめ|おわりに)/.test(heading));
  const featured = await upload(images.find((image) => image.kind === "featured"), text(article.title, 300));
  const figures = [];
  for (let index = 0; index < headings.length; index++) {
    const image = images.find((item) => item.kind === "section" && Number(item.section_index) === index) ||
      images.find((item) => item.kind === "section" && Number(item.section_index) < 0 && item.section_heading === headings[index]);
    figures.push(await upload(image, headings[index]));
  }
  const video = { url: text(article.youtube_url, 500), title: text(article.youtube_title, 300), videoId: youtubeVideoId(text(article.youtube_url, 500)) };
  const categoryId = Number(article.category_id || 0);
  const payload = {
    title: text(article.title, 500),
    content: composeWordPressHtml(bodyHtml, figures, video),
    status: "draft",
    slug,
    excerpt: text(article.meta_description, 1000),
    categories: categoryId ? [categoryId] : [],
    ...(featured?.mediaId ? { featured_media: featured.mediaId } : {}),
  };
  let postId = text(article.wordpress_post_id, 80);
  if (postId) {
    try {
      await wordpressRequest(`${base}/wp-json/wp/v2/posts/${postId}`, { method: "POST", headers: { Authorization: authorization, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    } catch (error) {
      // The draft was deleted in WordPress: create a fresh draft instead of failing forever.
      if (!/invalid post id|無効な投稿 ID|rest_post_invalid_id/i.test(String((error as Error).message))) throw error;
      postId = "";
    }
  }
  if (!postId) {
    const created = await wordpressRequest(`${base}/wp-json/wp/v2/posts`, { method: "POST", headers: { Authorization: authorization, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    postId = text(created.id, 80);
    if (!postId) throw new Error("WordPressの投稿IDを取得できませんでした。");
    // Store the post id immediately so a later failure never creates a duplicate draft.
    await runtime().DB.prepare("UPDATE articles SET wordpress_post_id=?,wordpress_status='DRAFT',wordpress_edit_url=?,wordpress_preview_url=?,updated_at=? WHERE id=?")
      .bind(postId, `${base}/wp-admin/post.php?post=${postId}&action=edit`, `${base}/?p=${postId}&preview=true`, now(), articleId).run();
  }
  let publicPreviewUrl = "", previewWarning = "";
  try {
    publicPreviewUrl = await retry(() => enableWordPressPublicPreview(connection, postId), 3);
  } catch (error) {
    previewWarning = `外部確認URLを発行できませんでした（${text((error as Error).message, 200)}）。Public Post PreviewとCode Snippetsプラグインが有効か確認してください。`;
  }
  const editUrl = `${base}/wp-admin/post.php?post=${postId}&action=edit`, previewUrl = `${base}/?p=${postId}&preview=true`;
  await runtime().DB.prepare(
    "UPDATE articles SET wordpress_post_id=?,wordpress_status='DRAFT',wordpress_edit_url=?,wordpress_preview_url=?,wordpress_public_preview_url=CASE WHEN ?<>'' THEN ? ELSE wordpress_public_preview_url END,featured_image_url=CASE WHEN ?<>'' THEN ? ELSE featured_image_url END,updated_at=? WHERE id=?",
  ).bind(postId, editUrl, previewUrl, publicPreviewUrl, publicPreviewUrl, featured?.url || "", featured?.url || "", now(), articleId).run();
  const saved = await runtime().DB.prepare("SELECT wordpress_public_preview_url FROM articles WHERE id=?").bind(articleId).first<{ wordpress_public_preview_url: string }>();
  return {
    postId, editUrl, previewUrl,
    publicPreviewUrl: saved?.wordpress_public_preview_url || "",
    imageCount: (featured ? 1 : 0) + figures.filter(Boolean).length,
    warning: previewWarning,
  };
}

// ---------- YouTube (public pages only, no API key) ----------

export async function youtubeWatchDetails(url: string, request?: Request) {
  const videoId = youtubeVideoId(url);
  if (!videoId) throw new Error("有効なYouTube動画URLを入力してください。");
  let title = "", description = "";
  try {
    const response = await fetch(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&hl=ja`, {
      headers: { "Accept-Language": "ja,en;q=0.8", "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36", Cookie: "CONSENT=YES+1" },
      signal: AbortSignal.timeout(15000),
    });
    const html = await response.text();
    const player = html.match(/ytInitialPlayerResponse\s*=\s*(\{[\s\S]+?\})\s*;\s*(?:var\s|<\/script>)/)?.[1];
    if (player) {
      const details = (JSON.parse(player).videoDetails || {}) as Row;
      title = text(details.title, 300);
      description = text(details.shortDescription, 30000);
    }
  } catch { /* oEmbed below keeps the title available */ }
  // YouTube often serves a consent/bot page to Cloudflare; the connected Google account is the fallback.
  if (!description && request)
    try {
      const official = await getYouTubeMetadata(request, `https://www.youtube.com/watch?v=${videoId}`);
      title ||= official.title;
      description = official.description;
    } catch { /* keep what the public page gave */ }
  if (!title)
    try {
      const response = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}&format=json`, { signal: AbortSignal.timeout(10000) });
      if (response.ok) title = text(((await response.json()) as Row).title, 300);
    } catch { /* the user can type the title */ }
  return { videoId, title, description, chapters: descriptionChapters(description) };
}

const FRAME_NAMES = ["maxresdefault", "maxres1", "maxres2", "maxres3", "hq1", "hq2", "hq3", "hqdefault"] as const;
export async function youtubeFrame(videoId: string, name: string) {
  if (!/^[A-Za-z0-9_-]{6,20}$/.test(videoId) || !(FRAME_NAMES as readonly string[]).includes(name)) return null;
  const response = await fetch(`https://i.ytimg.com/vi/${videoId}/${name}.jpg`, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) return null;
  const bytes = await response.arrayBuffer();
  // YouTube answers missing sizes with a tiny grey placeholder.
  return bytes.byteLength > 3000 ? bytes : null;
}

// Public Post Preview links expire (48h by default). This issues a fresh one on every visit,
// so the studio can share one permanent URL per article.
export async function freshPublicPreviewUrl(articleId: string) {
  const connection = await getWordPressConnection();
  if (!connection) throw new Error("WordPressが未接続です。");
  const article = await runtime().DB.prepare("SELECT wordpress_post_id FROM articles WHERE id=?").bind(articleId).first<{ wordpress_post_id: string | null }>();
  const postId = text(article?.wordpress_post_id, 80);
  if (!postId) throw new Error("この記事はまだWordPressへ下書き保存されていません。");
  const url = await retry(() => enableWordPressPublicPreview(connection, postId), 2);
  await runtime().DB.prepare("UPDATE articles SET wordpress_public_preview_url=? WHERE id=?").bind(url, articleId).run();
  return url;
}
