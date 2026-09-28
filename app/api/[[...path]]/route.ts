import { json, now, parse, runtime, safeError, text } from "../../../lib/studio-server";
import {
  checkIntegration,
  finishGoogleOAuth,
  finishUbersuggestOAuth,
  selectGoogleResource,
  startGoogleOAuth,
  startUbersuggestOAuth,
  verifyStaticIntegration,
} from "../../../lib/studio-connections";
import { seoResearch } from "../../../lib/seo-research";
import {
  backfillWordPressPublicPreviews,
  getLiveWordPressCategories,
  sanitizeArticleHtml,
} from "../../../lib/unified-production";
import {
  articleContext,
  createBrowserProduction,
  freshPublicPreviewUrl,
  listArticleImages,
  listArticles,
  mediaObject,
  saveArticleImage,
  syncWordPressDraft,
  wordpressState,
  youtubeFrame,
  youtubeWatchDetails,
} from "../../../lib/browser-production";

// Storage and WordPress only. Articles and images are made in the user's logged-in
// Claude / ChatGPT screens by the Chrome extension; no AI API is called from here.
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ path?: string[] }> };
const notFound = () => json({ error: "この操作は見つかりません。画面を再読み込みしてください。" }, 404);
const body = (request: Request) => request.json().catch(() => ({})) as Promise<Record<string, unknown>>;

// Search data connections used for Claude's analysis (API access, no AI API).
async function dataConnections() {
  const rows = (await runtime().DB.prepare("SELECT provider,status,checked_at,public_config FROM integration_profiles WHERE provider IN ('gsc','ga4','ubersuggest')").all<{ provider: string; status: string; checked_at: string | null; public_config: string }>()).results;
  return ["gsc", "ga4", "ubersuggest"].map((provider) => {
    const row = rows.find((item) => item.provider === provider), config = parse<Record<string, unknown>>(row?.public_config || "{}", {});
    const resources = Array.isArray(config.resources) ? (config.resources as Array<Record<string, unknown>>).map((item) => ({ id: text(item.id, 500), label: text(item.label, 500) })).filter((item) => item.id) : [];
    return { provider, status: row?.status || "NOT_CONFIGURED", checkedAt: row?.checked_at || null, selectedId: text(config.selectedResourceId, 500), selectedLabel: text(config.selectedResourceLabel, 500), lastError: text(config.lastError, 240), resources };
  });
}

async function articleCount() {
  const row = await runtime().DB.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN wordpress_status='DRAFT' THEN 1 ELSE 0 END) AS drafts FROM articles WHERE batch_ready=1").first<{ total: number; drafts: number }>();
  return { total: Number(row?.total || 0), drafts: Number(row?.drafts || 0) };
}

export async function GET(request: Request, context: Context) {
  try {
    const path = (await context.params).path || [], route = path.join("/");
    if (route === "oauth/google/callback") return finishGoogleOAuth(request);
    if (route === "oauth/ubersuggest/callback") return finishUbersuggestOAuth(request);
    if (route === "integrations/data") return json({ connections: await dataConnections() });
    if (route === "health") return json({ ok: true, mode: "browser", wordpress: (await wordpressState()).connected ? "connected" : "not_connected", r2: runtime().FILES ? "connected" : "unavailable" });
    if (route === "bootstrap") return json({ articles: await listArticles(), wordpress: await wordpressState() });
    if (route === "dashboard") return json({ counts: await articleCount(), wordpress: await wordpressState() });
    if (route === "wordpress/categories") return json(await getLiveWordPressCategories());
    if (route === "youtube/metadata") return json({ metadata: await youtubeWatchDetails(new URL(request.url).searchParams.get("url") || "", request) });
    if (path[0] === "youtube" && path[1] === "frame" && path[2] && path[3]) {
      const bytes = await youtubeFrame(path[2], path[3].replace(/\.jpg$/, ""));
      return bytes ? new Response(bytes, { headers: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=86400" } }) : json({ error: "フレームがありません。" }, 404);
    }
    if (path[0] === "media" && path[1]) {
      const object = await mediaObject(path[1]);
      if (!object) return json({ error: "画像が見つかりません。" }, 404);
      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set("Cache-Control", "public, max-age=31536000, immutable");
      return new Response(object.body, { headers });
    }
    if (path[0] === "references" && path.length > 1) {
      const key = path.slice(1).join("/");
      if (!/^challenger-references\/[\w-]+\/portrait\.(?:jpg|png|webp)$/.test(key)) return notFound();
      const object = await runtime().FILES.get(key);
      if (!object) return json({ error: "参照画像が見つかりません。" }, 404);
      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set("Cache-Control", "private, max-age=0, no-store");
      return new Response(object.body, { headers });
    }
    if (path[0] === "preview" && /^[\w-]{10,80}$/.test(path[1] || "")) {
      try {
        return Response.redirect(await freshPublicPreviewUrl(path[1]), 302);
      } catch (error) {
        return new Response(`<!doctype html><meta charset="utf-8"><title>プレビューを表示できません</title><p style="font-family:sans-serif;padding:24px">プレビューを表示できません：${safeError(error).replace(/[<>&]/g, "")}</p>`, { status: 404, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
      }
    }
    if (path[0] === "articles" && path[1] && path[2] === "images") return json({ images: await listArticleImages(path[1]) });
    if (path[0] === "articles" && path[1] && path[2] === "context") return json({ context: await articleContext(path[1]) });
    return notFound();
  } catch (error) {
    return json({ error: safeError(error) }, 500);
  }
}

export async function POST(request: Request, context: Context) {
  try {
    const path = (await context.params).path || [], route = path.join("/");
    if (route === "challenger-reference") {
      const form = await request.formData(), file = form.get("file");
      if (!(file instanceof File)) return json({ error: "挑戦者本人の画像を選択してください。" }, 400);
      if (!/^image\/(?:jpeg|png|webp)$/i.test(file.type)) return json({ error: "挑戦者画像はJPEG・PNG・WebPを使用してください。" }, 400);
      if (file.size > 12 * 1024 * 1024) return json({ error: "挑戦者画像は12MB以下にしてください。" }, 400);
      const extension = /png/i.test(file.type) ? "png" : /webp/i.test(file.type) ? "webp" : "jpg",
        key = `challenger-references/${crypto.randomUUID()}/portrait.${extension}`,
        articleId = text(form.get("articleId"), 80);
      await runtime().FILES.put(key, file.stream(), { httpMetadata: { contentType: file.type, cacheControl: "private, max-age=0, no-store" } });
      if (articleId)
        await runtime().DB.prepare("UPDATE production_projects SET challenger_image_key=?,updated_at=? WHERE id=(SELECT project_id FROM articles WHERE id=?)").bind(key, now(), articleId).run();
      return json({ reference: { objectKey: key, url: `/api/references/${key}` }, notice: "挑戦者本人の参照画像を保存しました。ChatGPTでの画像制作時に自動で添付します。" }, 201);
    }
    if (route === "seo/research") {
      const input = await body(request);
      return json(await seoResearch(request, input.seeds));
    }
    if (route === "integrations/google/connect") return json(await startGoogleOAuth(request, {}));
    if (route === "integrations/ubersuggest/connect") return json(await startUbersuggestOAuth(request));
    if (path[0] === "integrations" && ["gsc", "ga4", "ubersuggest"].includes(path[1]) && path[2] === "check") {
      await checkIntegration(path[1], request);
      return json({ connections: await dataConnections(), notice: "接続を確認しました。" });
    }
    if (path[0] === "integrations" && ["gsc", "ga4"].includes(path[1]) && path[2] === "select") {
      await selectGoogleResource(path[1], await body(request));
      return json({ connections: await dataConnections(), notice: "利用する対象を保存しました。" });
    }
    if (route === "browser/articles") return json(await createBrowserProduction(await body(request)), 201);
    if (path[0] === "articles" && path[1] && path[2] === "images") return json({ image: await saveArticleImage(path[1], await body(request)) }, 201);
    if (path[0] === "articles" && path[1] && path[2] === "wordpress") {
      const result = await syncWordPressDraft(path[1]);
      return json({ wordpress: result, notice: result.publicPreviewUrl ? "WordPressへ下書き保存し、外部確認URLを発行しました。" : `WordPressへ下書き保存しました。${result.warning}` });
    }
    if (route === "wordpress/public-previews/backfill") {
      const result = await backfillWordPressPublicPreviews();
      return json({ result, notice: result.updatedCount ? `${result.updatedCount}本の外部確認URLを発行しました。` : "すべての下書きに外部確認URLが設定済みです。" });
    }
    if (route === "integrations/wordpress/check") {
      const profile = await verifyStaticIntegration("wordpress", await body(request));
      return json({ profile: { status: profile.status, siteUrl: (profile.public_config as Record<string, unknown>).siteUrl }, notice: "WordPressとの接続を確認しました。" });
    }
    return notFound();
  } catch (error) {
    return json({ error: safeError(error) }, 500);
  }
}

export async function PATCH(request: Request, context: Context) {
  try {
    const path = (await context.params).path || [];
    if (path[0] !== "articles" || !path[1] || path.length !== 2) return notFound();
    const input = await body(request);
    const allowed = ["title", "title_tag", "meta_description", "slug", "catch_copy", "main_keyword", "body_html", "category_id", "category_name", "related_keywords", "search_intent", "reader"];
    const updates = allowed.filter((key) => key in input);
    if (updates.length) {
      const values = updates.map((key) =>
        key === "body_html" ? sanitizeArticleHtml(input[key])
          : key === "related_keywords" ? JSON.stringify(Array.isArray(input[key]) ? (input[key] as unknown[]).map((item) => text(item, 100)).filter(Boolean) : [])
            : text(input[key], 2000),
      );
      await runtime().DB.prepare(`UPDATE articles SET ${updates.map((key) => `${key}=?`).join(",")},updated_at=? WHERE id=?`).bind(...values, now(), path[1]).run();
    }
    const article = await runtime().DB.prepare("SELECT wordpress_post_id FROM articles WHERE id=?").bind(path[1]).first<{ wordpress_post_id: string | null }>();
    if (!article) return json({ error: "記事が見つかりません。" }, 404);
    let notice = "記事を保存しました。", wordpress = null;
    if (article.wordpress_post_id)
      try {
        wordpress = await syncWordPressDraft(path[1]);
        notice += " WordPress下書きも更新しました。";
      } catch (error) {
        notice += ` WordPress下書きの更新は失敗しました: ${safeError(error)}`;
      }
    return json({ ok: true, notice, wordpress });
  } catch (error) {
    return json({ error: safeError(error) }, 500);
  }
}

export const PUT = notFound;
export const DELETE = notFound;
