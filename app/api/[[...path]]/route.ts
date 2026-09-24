import {
  articleDraft,
  id,
  json,
  makeCandidates,
  now,
  parse,
  runtime,
  safeError,
  text,
} from "../../../lib/studio-server";
import {
  analyzeCompetition,
  createCompetitiveDraft,
  fetchCompetitiveSource,
  type CompetitiveSource,
} from "../../../lib/competitive-intelligence";
import { normalizeUbersuggestSerp } from "../../../lib/serp-provider";
import { UbersuggestMcpClient } from "../../../cloud-runner/src/ubersuggest-mcp";
import {
  checkIntegration,
  disconnectIntegration,
  finishGoogleOAuth,
  finishUbersuggestOAuth,
  getUbersuggestAccessToken,
  selectGoogleResource,
  startGoogleOAuth,
  startUbersuggestOAuth,
} from "../../../lib/studio-connections";
import {
  generateAutomatedSeoReport,
  latestAutomatedSeoReport,
} from "../../../lib/automated-seo-report";
import {
  createUnifiedProduction,
  getArticleImage,
  getArticleImages,
  getLiveWordPressCategories,
  getYouTubeMetadata,
  regenerateArticleImage,
  regenerateArticleSection,
  sanitizeArticleHtml,
  updateWordPressDraft,
} from "../../../lib/unified-production";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ path?: string[] }> };
type Row = Record<string, unknown>;
const input = (request: Request) =>
  request
    .clone()
    .json()
    .catch(() => ({})) as Promise<Record<string, unknown>>;
const projectFields = [
  "youtube_url",
  "youtube_title",
  "transcript",
  "direction",
  "challenger_name",
  "challenger_company",
  "special_guest",
  "mc_name",
] as const;
const providers = [
  ["ubersuggest", "Ubersuggest MCP", "公式OAuth・KW・競合・被リンク"],
  ["gsc", "Search Console", "順位・CTR・index"],
  ["ga4", "Google Analytics 4", "流入・CV・LP成果"],
  ["drive", "Google Drive", "資料・写真・議事録"],
  ["youtube", "YouTube", "動画・文字起こし"],
  ["anthropic", "Claude API", "記事生成・採点・分析"],
  ["openai", "OpenAI GPT Image 2", "16:9・高精細アイキャッチ・H2対談画像"],
  ["wordpress", "WordPress", "下書き投稿・カテゴリ同期"],
  ["pagespeed", "PageSpeed Insights", "技術SEO"],
  ["notion", "Notion", "企画・下書き共有"],
] as const;
const projectFor = (projectId: string) =>
  runtime()
    .DB.prepare("SELECT * FROM production_projects WHERE id=?")
    .bind(projectId)
    .first<Record<string, string>>();
const rows = async (query: string) =>
  (await runtime().DB.prepare(query).all()).results as Row[];
async function workspace() {
  const saved = await runtime()
    .DB.prepare("SELECT * FROM workspace_settings WHERE id='default'")
    .first<Row>();
  return (
    saved || {
      id: "default",
      site_name: "",
      site_url: "",
      location_name: "日本",
      location_code: "jp",
      language_code: "ja",
      device: "desktop",
    }
  );
}
async function profiles() {
  const saved = await rows(
      "SELECT * FROM integration_profiles ORDER BY provider",
    ),
    credentials = await rows("SELECT provider FROM integration_credentials"),
    credentialSet = new Set(credentials.map((item) => String(item.provider))),
    map = new Map(saved.map((item) => [String(item.provider), item]));
  return providers.map(([provider, name, purpose]) => {
    const item = map.get(provider),
      checkedAt = item?.checked_at || null,
      savedStatus = String(item?.status || ""),
      verified = savedStatus === "CONFIGURED" && Boolean(checkedAt),
      hasSecret =
        provider === "anthropic"
          ? Boolean(runtime().ANTHROPIC_API_KEY)
          : provider === "openai"
            ? Boolean(runtime().OPENAI_API_KEY)
            : provider === "ubersuggest"
              ? Boolean(runtime().UBERSUGGEST_ACCESS_TOKEN)
              : provider === "wordpress"
                ? Boolean(
                    runtime().WORDPRESS_URL &&
                    runtime().WORDPRESS_APPLICATION_PASSWORD,
                  )
                : provider === "notion"
                  ? Boolean(runtime().NOTION_API_KEY)
                  : provider === "pagespeed"
                    ? Boolean(runtime().PAGESPEED_API_KEY)
                    : ["gsc", "ga4", "drive", "youtube"].includes(provider)
                      ? credentialSet.has("google_oauth")
                      : credentialSet.has(provider);
    const status = verified
      ? "CONFIGURED"
      : savedStatus === "CONNECTION_ERROR"
        ? savedStatus
        : hasSecret || item
          ? "PENDING_SECRET"
          : "NOT_CONFIGURED";
    return {
      provider,
      name,
      purpose,
      status,
      public_config: parse(String(item?.public_config || "{}"), {}),
      checked_at: checkedAt,
    };
  });
}
async function dashboard() {
  const [projects, articles, candidates, integrations, config] =
    await Promise.all([
      rows(
        "SELECT id,status,updated_at FROM production_projects ORDER BY updated_at DESC",
      ),
      rows(
        "SELECT id,status,wordpress_status,updated_at FROM articles WHERE batch_ready=1 ORDER BY updated_at DESC",
      ),
      rows("SELECT id,status FROM keyword_candidates"),
      profiles(),
      workspace(),
    ]);
  return {
    projects,
    articles,
    candidates,
    integrations,
    workspace: config,
    metrics: {
      articles: articles.length,
      drafts: articles.filter((item) => String(item.status) === "DRAFT").length,
      reviewReady: articles.filter(
        (item) => String(item.status) === "REVIEW_READY",
      ).length,
      keywordCandidates: candidates.filter(
        (item) => String(item.status) === "PROPOSED",
      ).length,
      integrations: integrations.filter((item) => item.status === "CONFIGURED")
        .length,
    },
  };
}
const parseCompetitiveSource = (row: Row): CompetitiveSource => ({
  url: String(row.url || ""),
  title: String(row.title || ""),
  description: String(row.description || ""),
  headings: parse(String(row.headings_json || "[]"), []),
  topics: parse(String(row.topics_json || "[]"), []),
  excerpt: String(row.text_excerpt || ""),
  wordCount: Number(row.word_count || 0),
  status: String(row.fetch_status || "UNAVAILABLE"),
});
async function competitiveBundle() {
  const [projects, sources, analyses, drafts, actions] = await Promise.all([
    rows("SELECT * FROM competitive_projects ORDER BY updated_at DESC"),
    rows("SELECT * FROM competitive_sources ORDER BY created_at"),
    rows("SELECT * FROM competitive_analyses ORDER BY created_at DESC"),
    rows("SELECT * FROM competitive_drafts ORDER BY updated_at DESC"),
    rows("SELECT * FROM pdca_actions ORDER BY created_at DESC"),
  ]);
  return {
    projects,
    sources: sources.map((row) => ({
      ...row,
      headings: parse(String(row.headings_json || "[]"), []),
      topics: parse(String(row.topics_json || "[]"), []),
    })),
    analyses: analyses.map((row) => ({
      ...row,
      scores: parse(String(row.scores_json || "{}"), {}),
      commonTopics: parse(String(row.common_topics_json || "[]"), []),
      gaps: parse(String(row.content_gaps_json || "[]"), []),
      differentiation: parse(String(row.differentiation_json || "[]"), []),
      outline: parse(String(row.outline_json || "[]"), []),
      serp: parse(String(row.serp_json || "{}"), {}),
    })),
    drafts,
    actions,
  };
}

export async function GET(request: Request, context: Context) {
  try {
    const path = (await context.params).path || [],
      route = path.join("/");
    if (route === "oauth/ubersuggest/callback")
      return finishUbersuggestOAuth(request);
    if (route === "oauth/google/callback") return finishGoogleOAuth(request);
    if (path[0] === "media" && path[1]) {
      const object = await getArticleImage(path[1]);
      if (!object) return json({ error: "画像が見つかりません。" }, 404);
      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set("ETag", object.httpEtag);
      headers.set("Cache-Control", "public, max-age=31536000, immutable");
      return new Response(object.body, { headers });
    }
    if (path[0] === "articles" && path[1] && path[2] === "images")
      return json({ images: await getArticleImages(path[1]) });
    if (route === "wordpress/categories")
      return json(await getLiveWordPressCategories());
    if (route === "youtube/metadata") {
      const url = new URL(request.url).searchParams.get("url") || "";
      return json({ metadata: await getYouTubeMetadata(request, url) });
    }
    if (route === "health")
      return json({
        ok: true,
        d1: "connected",
        r2: runtime().FILES ? "connected" : "unavailable",
        encryption: runtime().DATA_ENCRYPTION_KEY
          ? "configured"
          : "not_configured",
        google_oauth:
          runtime().GOOGLE_OAUTH_CLIENT_ID &&
          runtime().GOOGLE_OAUTH_CLIENT_SECRET
            ? "configured"
            : "not_configured",
        claude: runtime().ANTHROPIC_API_KEY ? "configured" : "not_configured",
        openai: runtime().OPENAI_API_KEY ? "configured" : "not_configured",
        wordpress:
          runtime().WORDPRESS_URL && runtime().WORDPRESS_APPLICATION_PASSWORD
            ? "configured"
            : "not_configured",
        ubersuggest: runtime().UBERSUGGEST_ACCESS_TOKEN
          ? "configured"
          : "not_configured",
      });
    if (route === "bootstrap") {
      const [projects, articles, files, workspaceData, integrations] =
        await Promise.all([
          rows("SELECT * FROM production_projects ORDER BY updated_at DESC"),
          rows(
            "SELECT * FROM articles WHERE batch_ready=1 ORDER BY updated_at DESC",
          ),
          rows("SELECT * FROM uploaded_files ORDER BY created_at DESC"),
          workspace(),
          profiles(),
        ]);
      return json({
        projects,
        articles: articles.map((row) => ({
          ...row,
          related_keywords: parse(String(row.related_keywords), []),
          evidence: parse(String(row.evidence_json), []),
          quality: parse(String(row.quality_json), {}),
        })),
        files,
        workspace: workspaceData,
        integrations,
      });
    }
    if (route === "dashboard") return json(await dashboard());
    if (route === "reports/latest")
      return json({ report: await latestAutomatedSeoReport() });
    if (route === "integrations")
      return json({ integrations: await profiles() });
    if (route === "workspace") return json({ workspace: await workspace() });
    if (route === "competitive") return json(await competitiveBundle());
    if (path[0] === "projects" && path[2] === "candidates") {
      const found = await runtime()
        .DB.prepare(
          "SELECT * FROM keyword_candidates WHERE project_id=? ORDER BY created_at",
        )
        .bind(path[1])
        .all();
      return json({
        candidates: found.results.map((row: Row) => ({
          ...row,
          related_keywords: parse(String(row.related_keywords), []),
        })),
      });
    }
    return json({ error: "見つかりません。" }, 404);
  } catch (error) {
    return json({ error: safeError(error), retryable: true }, 500);
  }
}

export async function POST(request: Request, context: Context) {
  try {
    const path = (await context.params).path || [],
      route = path.join("/");
    if (route === "challenger-reference") {
      const form = await request.formData(),
        file = form.get("file");
      if (!(file instanceof File))
        return json({ error: "挑戦者本人の画像を選択してください。" }, 400);
      if (!/^image\/(?:jpeg|png|webp)$/i.test(file.type))
        return json(
          { error: "挑戦者画像はJPEG・PNG・WebPを使用してください。" },
          400,
        );
      if (file.size > 12 * 1024 * 1024)
        return json({ error: "挑戦者画像は12MB以下にしてください。" }, 400);
      const referenceId = id(),
        extension = file.type.toLowerCase().includes("png")
          ? "png"
          : file.type.toLowerCase().includes("webp")
            ? "webp"
            : "jpg",
        key = `challenger-references/${referenceId}/portrait.${extension}`;
      await runtime().FILES.put(key, file.stream(), {
        httpMetadata: {
          contentType: file.type,
          cacheControl: "private, max-age=0, no-store",
        },
      });
      return json(
        {
          reference: {
            id: referenceId,
            objectKey: key,
            name: file.name,
            size: file.size,
          },
          notice:
            "挑戦者本人の参照画像を保存しました。GPT Image 2が本人識別の正本として使用します。",
        },
        201,
      );
    }
    if (route === "uploads") {
      const form = await request.formData(),
        file = form.get("file");
      if (!(file instanceof File))
        return json({ error: "ファイルを選択してください。" }, 400);
      if (file.size > 20 * 1024 * 1024)
        return json({ error: "ファイルは20MB以下にしてください。" }, 400);
      const projectId = text(form.get("projectId"), 80),
        fileId = id(),
        key = `transcripts/${fileId}/${file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
      await runtime().FILES.put(key, file.stream(), {
        httpMetadata: { contentType: file.type || "application/octet-stream" },
      });
      const isText = /text\/plain|\.txt$/i.test(file.type + file.name),
        transcript = isText ? await file.text() : "";
      await runtime()
        .DB.prepare(
          "INSERT INTO uploaded_files (id,project_id,object_key,name,content_type,size,extraction_status,created_at) VALUES (?,?,?,?,?,?,?,?)",
        )
        .bind(
          fileId,
          projectId,
          key,
          file.name,
          file.type || "application/octet-stream",
          file.size,
          transcript ? "EXTRACTED" : "STORED",
          now(),
        )
        .run();
      return json(
        {
          file: {
            id: fileId,
            name: file.name,
            transcript,
            needsPaste: !transcript,
          },
        },
        201,
      );
    }
    const body = await input(request);
    if (route === "productions") {
      const production = await createUnifiedProduction(body, request);
      return json(
        {
          production,
          notice: `${production.articles.length}本の記事を生成しました。${production.warnings.length ? ` 注意: ${production.warnings.join(" ")}` : "WordPress連携時は選択カテゴリーへ下書き保存済みです。"}`,
        },
        201,
      );
    }
    if (path[0] === "articles" && path[1] && path[2] === "regenerate-section") {
      const section = await regenerateArticleSection(
        path[1],
        text(body.heading, 200),
        text(body.currentHtml, 12000),
        text(body.instruction, 1000),
      );
      return json({
        section,
        notice:
          "H2本文を動画一次情報からAIで再生成しました。保存ボタンで記事とWordPress下書きへ反映できます。",
      });
    }
    if (path[0] === "articles" && path[1] && path[2] === "regenerate-image") {
      const image = await regenerateArticleImage(path[1], body);
      return json(
        {
          image,
          notice: "画像をAIで再生成し、記事とWordPress下書きへ反映しました。",
        },
        201,
      );
    }
    if (route === "reports/analyze")
      return json(
        {
          report: await generateAutomatedSeoReport(request),
          notice:
            "Search Console・GA4・Ubersuggest・競合ページを一括取得し、AI分析レポートを保存しました。",
        },
        201,
      );
    if (path[0] === "integrations" && path[1] && path[2] === "connect") {
      const result =
        path[1] === "ubersuggest"
          ? await startUbersuggestOAuth(request)
          : path[1] === "google"
            ? await startGoogleOAuth(request, body)
            : null;
      if (!result)
        return json(
          { error: "この連携先はOAuth接続に対応していません。" },
          400,
        );
      return json(result);
    }
    if (path[0] === "integrations" && path[1] && path[2] === "check")
      return json({
        integration: await checkIntegration(path[1], request, body),
        notice: "実通信に成功し、接続済みへ更新しました。",
      });
    if (path[0] === "integrations" && path[1] && path[2] === "select") {
      const integration = await selectGoogleResource(path[1], body);
      return json({
        integration,
        notice: `利用対象を「${String(integration.public_config.selectedResourceLabel || "")}」に設定しました。`,
      });
    }
    if (path[0] === "integrations" && path[1] && path[2] === "disconnect")
      return json({
        disconnected: await disconnectIntegration(path[1]),
        notice: "連携を解除しました。",
      });
    if (route === "competitive/projects") {
      const keyword = text(body.keyword, 160),
        primary = text(body.primary_information, 30000),
        companyContext = text(body.company_context, 2000);
      if (!keyword || primary.length < 80)
        return json(
          {
            error:
              "狙うキーワードと、80文字以上の自社一次情報を入力してください。",
          },
          400,
        );
      const config = await workspace(),
        projectId = id(),
        stamp = now();
      await runtime()
        .DB.prepare(
          "INSERT INTO competitive_projects (id,keyword,company_context,primary_information,location_name,status,created_at,updated_at) VALUES (?,?,?,?,?,'ANALYZING',?,?)",
        )
        .bind(
          projectId,
          keyword,
          companyContext,
          primary,
          String(config.location_name || ""),
          stamp,
          stamp,
        )
        .run();
      let urls = text(body.competitor_urls, 6000)
          .split(/[\n,]+/)
          .map((value) => value.trim())
          .filter(Boolean)
          .slice(0, 8),
        provider = "manual_urls",
        serp: Record<string, unknown> = {},
        providerNotice = "入力された競合URLを分析しました。";
      if (body.use_ubersuggest) {
        try {
          const accessToken = await getUbersuggestAccessToken(),
            call = await new UbersuggestMcpClient(accessToken).callSerp(
              keyword,
              { language: String(config.language_code || "ja"), limit: 10 },
            ),
            normalized = normalizeUbersuggestSerp(
              call.rawToolResult,
              call.requestedAt,
            );
          serp = {
            provider: normalized.provider,
            checkedAt: normalized.checkedAt,
            results: normalized.results,
            features: normalized.features,
          };
          urls = [
            ...new Set([
              ...normalized.results.map((item) => item.url),
              ...urls,
            ]),
          ].slice(0, 8);
          provider = "ubersuggest_mcp";
          providerNotice = "Ubersuggest実SERPと指定URLから競合を分析しました。";
        } catch (error) {
          providerNotice = `${safeError(error)} 指定URLだけで分析を続行しました。`;
        }
      }
      if (urls.length < 2)
        return json(
          {
            error:
              "競合URLを2件以上入力するか、Ubersuggest MCPを接続してください。",
          },
          400,
        );
      const fetched = await Promise.allSettled(
          urls.map((url) => fetchCompetitiveSource(url)),
        ),
        sourceRows: CompetitiveSource[] = [];
      for (let index = 0; index < fetched.length; index++) {
        const result = fetched[index],
          sourceId = id();
        if (result.status === "fulfilled") {
          const source = result.value;
          sourceRows.push(source);
          await runtime()
            .DB.prepare(
              "INSERT INTO competitive_sources (id,project_id,source_type,url,title,description,headings_json,topics_json,text_excerpt,word_count,fetch_status,fetched_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            )
            .bind(
              sourceId,
              projectId,
              provider === "ubersuggest_mcp" ? "serp" : "manual",
              source.url,
              source.title,
              source.description,
              JSON.stringify(source.headings),
              JSON.stringify(source.topics),
              source.excerpt,
              source.wordCount,
              source.status,
              stamp,
              stamp,
            )
            .run();
        } else {
          await runtime()
            .DB.prepare(
              "INSERT INTO competitive_sources (id,project_id,source_type,url,fetch_status,created_at) VALUES (?,?,?,?,?,?)",
            )
            .bind(
              sourceId,
              projectId,
              "manual",
              urls[index] || "",
              "UNAVAILABLE",
              stamp,
            )
            .run();
        }
      }
      if (!sourceRows.length)
        return json(
          {
            error:
              "競合記事を取得できませんでした。URLが公開HTMLか確認してください。",
          },
          400,
        );
      const analysis = analyzeCompetition(keyword, primary, sourceRows),
        analysisId = id();
      await runtime()
        .DB.prepare(
          "INSERT INTO competitive_analyses (id,project_id,provider,scores_json,common_topics_json,content_gaps_json,differentiation_json,outline_json,serp_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
        )
        .bind(
          analysisId,
          projectId,
          provider,
          JSON.stringify(analysis.scores),
          JSON.stringify(analysis.commonTopics),
          JSON.stringify(analysis.gaps),
          JSON.stringify(analysis.differentiation),
          JSON.stringify(analysis.outline),
          JSON.stringify(serp),
          stamp,
        )
        .run();
      const actions = [
        ["PLAN", `${keyword}の競合共通テーマと不足領域を確認する`],
        ["DO", "自社の動画・経験を根拠にオリジナル記事を制作する"],
        [
          "CHECK",
          "Search Console・Ubersuggestで順位、表示、競合変化を計測する",
        ],
        ["ACT", "不足テーマと独自情報を更新し、類似度を再検査する"],
      ];
      await runtime().DB.batch(
        actions.map(([phase, action]) =>
          runtime()
            .DB.prepare(
              "INSERT INTO pdca_actions (id,project_id,phase,action_text,evidence_json,status,created_at,updated_at) VALUES (?,?,?,?,?,'PLANNED',?,?)",
            )
            .bind(
              id(),
              projectId,
              phase,
              action,
              JSON.stringify({ analysisId }),
              stamp,
              stamp,
            ),
        ),
      );
      await runtime()
        .DB.prepare(
          "UPDATE competitive_projects SET status='ANALYZED',updated_at=? WHERE id=?",
        )
        .bind(stamp, projectId)
        .run();
      return json(
        {
          projectId,
          analysisId,
          notice: `${providerNotice} ${sourceRows.length}記事を取得し、共通テーマ・コンテンツギャップ・差別化案を保存しました。`,
          data: await competitiveBundle(),
        },
        201,
      );
    }
    if (
      path[0] === "competitive" &&
      path[1] === "projects" &&
      path[2] &&
      path[3] === "drafts"
    ) {
      const project = await runtime()
        .DB.prepare("SELECT * FROM competitive_projects WHERE id=?")
        .bind(path[2])
        .first<Row>();
      if (!project)
        return json({ error: "競合分析プロジェクトが見つかりません。" }, 404);
      const analysisRow = await runtime()
        .DB.prepare(
          "SELECT * FROM competitive_analyses WHERE project_id=? ORDER BY created_at DESC LIMIT 1",
        )
        .bind(path[2])
        .first<Row>();
      if (!analysisRow)
        return json({ error: "先に競合分析を実行してください。" }, 400);
      const sourceRecords = await runtime()
          .DB.prepare(
            "SELECT * FROM competitive_sources WHERE project_id=? AND fetch_status='FETCHED'",
          )
          .bind(path[2])
          .all(),
        sourceRows = (sourceRecords.results as Row[]).map(
          parseCompetitiveSource,
        ),
        analysis = {
          scores: parse(String(analysisRow.scores_json), {}),
          commonTopics: parse(String(analysisRow.common_topics_json), []),
          gaps: parse(String(analysisRow.content_gaps_json), []),
          differentiation: parse(String(analysisRow.differentiation_json), []),
          outline: parse(String(analysisRow.outline_json), []),
        },
        draft = createCompetitiveDraft(
          String(project.keyword),
          String(project.primary_information),
          String(project.company_context),
          analysis,
          sourceRows,
        ),
        draftId = id(),
        stamp = now();
      await runtime()
        .DB.prepare(
          "INSERT INTO competitive_drafts (id,project_id,analysis_id,title,body_html,originality_score,maximum_source_overlap,plagiarism_risk,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        )
        .bind(
          draftId,
          path[2],
          String(analysisRow.id),
          draft.title,
          draft.body,
          draft.originalityScore,
          draft.maximumSourceOverlap,
          draft.plagiarismRisk,
          draft.plagiarismRisk === "HIGH" ? "REVISION_REQUIRED" : "DRAFT",
          stamp,
          stamp,
        )
        .run();
      return json(
        {
          draft: { id: draftId, ...draft },
          notice:
            draft.plagiarismRisk === "HIGH"
              ? "競合との類似度が高いため要修正にしました。公開候補にはできません。"
              : "自社一次情報を中心に下書きを作成し、競合との重複率を検査しました。",
          data: await competitiveBundle(),
        },
        201,
      );
    }
    if (route === "workspace") {
      const stamp = now();
      await runtime()
        .DB.prepare(
          "INSERT INTO workspace_settings (id,site_name,site_url,location_name,location_code,language_code,device,updated_at) VALUES ('default',?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET site_name=excluded.site_name,site_url=excluded.site_url,location_name=excluded.location_name,location_code=excluded.location_code,language_code=excluded.language_code,device=excluded.device,updated_at=excluded.updated_at",
        )
        .bind(
          text(body.site_name, 120),
          text(body.site_url, 500),
          text(body.location_name, 120) || "日本",
          text(body.location_code, 32) || "jp",
          text(body.language_code, 16) || "ja",
          text(body.device, 16) || "desktop",
          stamp,
        )
        .run();
      return json({ workspace: await workspace() });
    }
    if (path[0] === "integrations" && path[1]) {
      const provider = path[1];
      if (!providers.some((item) => item[0] === provider))
        return json({ error: "未対応の連携先です。" }, 400);
      const config = {
        siteUrl: text(body.site_url, 500),
        location: text(body.location, 120),
        account: text(body.account, 160),
        note: text(body.note, 500),
      };
      await runtime()
        .DB.prepare(
          "INSERT INTO integration_profiles (provider,public_config,status,checked_at,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(provider) DO UPDATE SET public_config=excluded.public_config,status=excluded.status,checked_at=excluded.checked_at,updated_at=excluded.updated_at",
        )
        .bind(provider, JSON.stringify(config), "PENDING_SECRET", null, now())
        .run();
      return json({
        integration: (await profiles()).find(
          (item) => item.provider === provider,
        ),
        notice:
          "接続先を保存しました。認証情報はブラウザに保存せず、Cloudflare Worker Secretを設定すると有効になります。",
      });
    }
    if (route === "projects") {
      const values = Object.fromEntries(
        projectFields.map((key) => [key, text(body[key])]),
      ) as Record<string, string>;
      if (!values.transcript)
        return json(
          {
            error:
              "文字起こしを貼り付けるか、TXTファイルを読み込んでください。",
          },
          400,
        );
      const stamp = now(),
        projectId = id();
      await runtime()
        .DB.prepare(
          "INSERT INTO production_projects (id,youtube_url,youtube_title,transcript,transcript_chars,direction,challenger_name,challenger_company,special_guest,mc_name,strict_evidence,image_suggestions,article_limit,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .bind(
          projectId,
          values.youtube_url,
          values.youtube_title,
          values.transcript,
          values.transcript.length,
          values.direction,
          values.challenger_name,
          values.challenger_company,
          values.special_guest,
          values.mc_name,
          body.strict_evidence === false ? 0 : 1,
          body.image_suggestions === false ? 0 : 1,
          Math.min(5, Math.max(1, Number(body.article_limit) || 1)),
          "INPUT",
          stamp,
          stamp,
        )
        .run();
      return json(
        {
          project: {
            id: projectId,
            ...values,
            article_limit: Math.min(
              5,
              Math.max(1, Number(body.article_limit) || 1),
            ),
          },
        },
        201,
      );
    }
    if (path[0] === "projects" && path[2] === "candidates") {
      const project = await projectFor(path[1]);
      if (!project) return json({ error: "制作入力が見つかりません。" }, 404);
      await runtime()
        .DB.prepare(
          "DELETE FROM keyword_candidates WHERE project_id=? AND status='PROPOSED'",
        )
        .bind(path[1])
        .run();
      const candidates = makeCandidates(project),
        stamp = now();
      await runtime().DB.batch(
        candidates.map((candidate) =>
          runtime()
            .DB.prepare(
              "INSERT INTO keyword_candidates (id,project_id,keyword,related_keywords,search_intent,reader,angle,relevance,duplication_risk,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            )
            .bind(
              id(),
              path[1],
              candidate.keyword,
              candidate.related_keywords,
              candidate.search_intent,
              candidate.reader,
              candidate.angle,
              candidate.relevance,
              candidate.duplication_risk,
              "PROPOSED",
              stamp,
            ),
        ),
      );
      const found = await runtime()
        .DB.prepare(
          "SELECT * FROM keyword_candidates WHERE project_id=? ORDER BY created_at",
        )
        .bind(path[1])
        .all();
      return json({
        candidates: found.results.map((row: Row) => ({
          ...row,
          related_keywords: parse(String(row.related_keywords), []),
        })),
        provider: runtime().UBERSUGGEST_ACCESS_TOKEN
          ? "configured_fallback"
          : "analysis_fallback",
        notice: runtime().UBERSUGGEST_ACCESS_TOKEN
          ? "Ubersuggest連携を検出しました。候補の一次情報適合性を確認してください。"
          : "Ubersuggest MCPは連携設定で接続できます。現在は文字起こしから安全な候補案を作成しました。",
      });
    }
    if (path[0] === "candidates" && path[2] === "articles") {
      const candidate = await runtime()
        .DB.prepare("SELECT * FROM keyword_candidates WHERE id=?")
        .bind(path[1])
        .first<Record<string, string>>();
      if (!candidate)
        return json({ error: "キーワード候補が見つかりません。" }, 404);
      const project = await projectFor(candidate.project_id);
      if (!project) return json({ error: "制作入力が見つかりません。" }, 404);
      const made = await runtime()
        .DB.prepare("SELECT COUNT(*) count FROM articles WHERE project_id=?")
        .bind(project.id)
        .first<{ count: number }>();
      if (Number(made?.count || 0) >= Number(project.article_limit))
        return json(
          {
            error: `この入力では最大${project.article_limit}本まで制作できます。`,
          },
          400,
        );
      const draft = articleDraft(project, candidate),
        articleId = id(),
        stamp = now();
      await runtime()
        .DB.prepare(
          "INSERT INTO articles (id,project_id,candidate_id,title,title_tag,meta_description,slug,catch_copy,main_keyword,related_keywords,search_intent,reader,angle,body_html,evidence_json,image_suggestions_json,quality_json,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .bind(
          articleId,
          project.id,
          candidate.id,
          draft.title,
          draft.title_tag,
          draft.meta_description,
          draft.slug,
          draft.catch_copy,
          candidate.keyword,
          candidate.related_keywords,
          candidate.search_intent,
          candidate.reader,
          candidate.angle,
          draft.body_html,
          draft.evidence_json,
          draft.image_suggestions_json,
          draft.quality_json,
          runtime().ANTHROPIC_API_KEY ? "REVIEW_READY" : "DRAFT",
          stamp,
          stamp,
        )
        .run();
      await runtime()
        .DB.prepare("UPDATE keyword_candidates SET status='CREATED' WHERE id=?")
        .bind(candidate.id)
        .run();
      return json(
        {
          article: {
            id: articleId,
            ...draft,
            main_keyword: candidate.keyword,
            search_intent: candidate.search_intent,
            reader: candidate.reader,
            angle: candidate.angle,
            status: runtime().ANTHROPIC_API_KEY ? "REVIEW_READY" : "DRAFT",
          },
          notice: runtime().ANTHROPIC_API_KEY
            ? "Haiku→Sonnet工程を開始できる状態です。"
            : "Claude Secret未設定のため、一次情報を保持した下書きを保存しました。",
        },
        201,
      );
    }
    return json({ error: "見つかりません。" }, 404);
  } catch (error) {
    return json({ error: safeError(error), retryable: true }, 500);
  }
}
export async function PATCH(request: Request, context: Context) {
  try {
    const path = (await context.params).path || [],
      body = await input(request);
    if (path[0] !== "articles" || !path[1])
      return json({ error: "見つかりません。" }, 404);
    const allowed = [
        "title",
        "title_tag",
        "meta_description",
        "slug",
        "catch_copy",
        "main_keyword",
        "body_html",
        "category_id",
        "category_name",
        "related_keywords",
        "search_intent",
        "reader",
        "angle",
      ],
      updates = allowed.filter((key) => key in body);
    if (!updates.length)
      return json({ ok: true, notice: "変更はありません。" });
    const set = updates.map((key) => `${key}=?`).join(","),
      values = updates.map((key) =>
        key === "body_html"
          ? sanitizeArticleHtml(body[key])
          : key === "related_keywords"
            ? JSON.stringify(
                Array.isArray(body[key])
                  ? body[key]
                  : text(body[key])
                      .split(/[、,\n]+/)
                      .filter(Boolean),
              )
            : text(body[key]),
      );
    await runtime()
      .DB.prepare(`UPDATE articles SET ${set},updated_at=? WHERE id=?`)
      .bind(...values, now(), path[1])
      .run();
    const article = await runtime()
      .DB.prepare("SELECT * FROM articles WHERE id=?")
      .bind(path[1])
      .first<Row>();
    if (!article) return json({ error: "記事が見つかりません。" }, 404);
    let notice = "記事ライブラリーへ変更を保存しました。";
    if (article.wordpress_post_id)
      try {
        const synced = await updateWordPressDraft(article);
        await runtime()
          .DB.prepare(
            "UPDATE articles SET wordpress_status='DRAFT',wordpress_edit_url=?,wordpress_preview_url=?,updated_at=? WHERE id=?",
          )
          .bind(
            synced.editUrl || article.wordpress_edit_url || "",
            synced.previewUrl || article.wordpress_preview_url || "",
            now(),
            path[1],
          )
          .run();
        notice += " WordPress下書きも更新しました。";
      } catch (error) {
        await runtime()
          .DB.prepare(
            "UPDATE articles SET wordpress_status='ERROR',updated_at=? WHERE id=?",
          )
          .bind(now(), path[1])
          .run();
        notice += ` WordPress更新は失敗しました: ${safeError(error)}`;
      }
    return json({ ok: true, article, notice });
  } catch (error) {
    return json({ error: safeError(error), retryable: true }, 500);
  }
}
