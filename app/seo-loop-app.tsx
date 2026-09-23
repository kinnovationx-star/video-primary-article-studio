"use client";

import {
  FormEvent,
  MouseEvent as ReactMouseEvent,
  useEffect,
  useRef,
  useState,
} from "react";

type Article = {
  id: string;
  title: string;
  title_tag?: string;
  slug?: string;
  main_keyword: string;
  related_keywords?: string[];
  search_intent?: string;
  reader?: string;
  angle?: string;
  catch_copy?: string;
  meta_description?: string;
  category_id?: string;
  category_name?: string;
  body_html?: string;
  featured_image_url?: string;
  section_images_json?: string;
  image_suggestions_json?: string;
  status: string;
  wordpress_status: string;
  wordpress_edit_url?: string;
  wordpress_preview_url?: string;
  updated_at: string;
};
type ArticleImage = {
  id: string;
  kind: "featured" | "section";
  section_heading?: string;
  alt_text?: string;
  prompt?: string;
  url: string;
};
type Integration = {
  provider: string;
  name: string;
  purpose: string;
  status: string;
  checked_at?: string | null;
  public_config: Record<string, unknown>;
};
type GoogleResource = { id: string; label: string; detail?: string };
type Dashboard = {
  metrics: {
    articles: number;
    drafts: number;
    reviewReady: number;
    keywordCandidates: number;
    integrations: number;
  };
  integrations: Integration[];
  articles: Article[];
};
type TrendPoint = { date: string; primary: number; secondary: number };
type AutomatedReport = {
  id: string;
  generatedAt: string;
  period: { start: string; end: string };
  keyword: string;
  scores: {
    visibility: number;
    engagement: number;
    competitive: number;
    opportunity: number;
    overall: number;
  };
  sourceStatus: Array<{
    source: string;
    status: "取得済み" | "未取得";
    detail: string;
  }>;
  gsc: null | {
    summary: {
      clicks: number;
      impressions: number;
      ctr: number;
      position: number;
    };
    daily: Array<{ date: string; clicks: number; impressions: number }>;
    queries: Array<{
      query: string;
      clicks: number;
      impressions: number;
      ctr: number;
      position: number;
    }>;
  };
  ga4: null | {
    summary: {
      users: number;
      sessions: number;
      engagedSessions: number;
      keyEvents: number;
    };
    daily: Array<{
      date: string;
      users: number;
      sessions: number;
      engagedSessions: number;
      keyEvents: number;
    }>;
    pages: Array<{
      page: string;
      users: number;
      sessions: number;
      engagedSessions: number;
      keyEvents: number;
    }>;
  };
  competitors: Array<{
    rank: number;
    title: string;
    url: string;
    domain?: string;
  }>;
  competition: null | {
    commonTopics: string[];
    gaps: string[];
    scores: Record<string, number>;
  };
  ai: {
    executiveSummary: string;
    strengths: string[];
    issues: string[];
    actions: string[];
    pdca: { plan: string[]; do: string[]; check: string[]; act: string[] };
  };
  aiProvider: string;
  trend: { search: TrendPoint[]; traffic: TrendPoint[] };
};
const api = async <T,>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> => {
  const response = await fetch(`/api/${path}`, {
    method,
    headers:
      body instanceof FormData
        ? undefined
        : { "Content-Type": "application/json" },
    body:
      body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });
  const data = (await response.json().catch(() => ({}))) as T & {
    error?: string;
  };
  if (!response.ok) throw new Error(data.error || "処理できませんでした。");
  return data;
};
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "処理できませんでした。";
const configText = (config: Record<string, unknown>, key: string) =>
  typeof config[key] === "string" ? (config[key] as string) : "";
const googleResources = (config: Record<string, unknown>) =>
  Array.isArray(config.resources)
    ? config.resources.filter((item): item is GoogleResource =>
        Boolean(
          item && typeof item === "object" && "id" in item && "label" in item,
        ),
      )
    : [];
const nav = [
  ["dashboard", "⌂", "ダッシュボード"],
  ["studio", "✦", "動画一次情報記事制作"],
  ["library", "▣", "記事ライブラリー"],
  ["aio", "◌", "LLMO / AIO 分析"],
  ["reports", "◫", "レポート・PDCA"],
  ["connections", "⌁", "連携設定"],
] as const;

type GenerationProgressState = {
  label: string;
  percent: number;
  detail: string;
  status: "running" | "completed" | "failed";
};
type ActionProgressController = {
  progress: GenerationProgressState | null;
  start: (label: string) => void;
  complete: (detail: string) => void;
  fail: (detail: string) => void;
  pulse: (label: string) => void;
};
function useActionProgress(): ActionProgressController {
  const [progress, setProgress] = useState<GenerationProgressState | null>(
      null,
    ),
    timer = useRef<number | null>(null),
    pulseTimer = useRef<number | null>(null),
    dismissTimer = useRef<number | null>(null),
    activeLabel = useRef("処理"),
    actionVersion = useRef(0);
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearInterval(timer.current);
      if (pulseTimer.current !== null) window.clearTimeout(pulseTimer.current);
      if (dismissTimer.current !== null)
        window.clearTimeout(dismissTimer.current);
    },
    [],
  );
  const stopTimers = () => {
    if (timer.current !== null) window.clearInterval(timer.current);
    if (pulseTimer.current !== null) window.clearTimeout(pulseTimer.current);
    if (dismissTimer.current !== null)
      window.clearTimeout(dismissTimer.current);
    timer.current = null;
    pulseTimer.current = null;
    dismissTimer.current = null;
  };
  const start = (label: string) => {
    stopTimers();
    actionVersion.current += 1;
    activeLabel.current = label;
    setProgress({
      label,
      percent: 1,
      detail: "処理を開始しました",
      status: "running",
    });
    timer.current = window.setInterval(
      () =>
        setProgress((current) => {
          if (!current || current.status !== "running" || current.percent >= 92)
            return current;
          const next = Math.min(
            92,
            current.percent +
              (current.percent < 35 ? 9 : current.percent < 70 ? 6 : 3),
          );
          return {
            ...current,
            percent: next,
            detail:
              next < 35
                ? "入力内容を確認しています"
                : next < 70
                  ? "関連データを処理しています"
                  : "結果を画面へ反映しています",
          };
        }),
      650,
    );
  };
  const complete = (detail: string) => {
    stopTimers();
    setProgress({
      label: activeLabel.current,
      percent: 100,
      detail,
      status: "completed",
    });
    dismissTimer.current = window.setTimeout(() => setProgress(null), 3500);
  };
  const fail = (detail: string) => {
    stopTimers();
    setProgress((current) => ({
      label: activeLabel.current,
      percent: Math.max(1, current?.percent || 1),
      detail,
      status: "failed",
    }));
  };
  const pulse = (label: string) => {
    stopTimers();
    const version = ++actionVersion.current;
    activeLabel.current = label;
    setProgress({
      label,
      percent: 1,
      detail: "ボタン操作を受け付けました",
      status: "running",
    });
    pulseTimer.current = window.setTimeout(() => {
      if (actionVersion.current !== version) return;
      setProgress({
        label,
        percent: 100,
        detail: "画面へ反映しました",
        status: "completed",
      });
      dismissTimer.current = window.setTimeout(() => setProgress(null), 1800);
    }, 180);
  };
  return { progress, start, complete, fail, pulse };
}

function GenerationProgress({
  progress,
}: {
  progress: GenerationProgressState | null;
}) {
  if (!progress) return null;
  return (
    <section
      className={`generation-progress ${progress.status}`}
      aria-live="polite"
    >
      <div className="generation-progress-head">
        <div>
          <b>{progress.label}</b>
          <span>{progress.detail}</span>
        </div>
        <strong>{progress.percent}%</strong>
      </div>
      <div
        className="generation-progress-track"
        role="progressbar"
        aria-label={`${progress.label}の進捗`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress.percent}
      >
        <i style={{ width: `${progress.percent}%` }} />
      </div>
    </section>
  );
}

export function SeoLoopApp() {
  const [page, setPage] = useState<(typeof nav)[number][0]>("dashboard"),
    [articles, setArticles] = useState<Article[]>([]),
    [integrations, setIntegrations] = useState<Integration[]>([]),
    [dashboard, setDashboard] = useState<Dashboard | null>(null),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  const actionProgress = useActionProgress();
  const load = async () => {
    try {
      const [base, board] = await Promise.all([
        api<{ articles: Article[]; integrations: Integration[] }>("bootstrap"),
        api<Dashboard>("dashboard"),
      ]);
      setArticles(base.articles);
      setIntegrations(base.integrations);
      setDashboard(board);
    } catch (error) {
      setNotice(errorText(error));
    }
  };
  useEffect(() => {
    const callback = window.setTimeout(() => {
      const params = new URLSearchParams(window.location.search),
        connection = params.get("connection"),
        provider = params.get("provider");
      if (params.get("page") === "connections" || connection)
        setPage("connections");
      if (connection) {
        const labels: Record<string, string> = {
          connected: "認証と実通信の確認が完了しました。",
          denied: "外部サービスの認証がキャンセルされました。",
          session_expired:
            "認証の有効時間が切れました。もう一度お試しください。",
          failed: "外部サービスとの接続確認に失敗しました。",
        };
        setNotice(
          `${provider || "外部サービス"}: ${labels[connection] || connection}`,
        );
        window.history.replaceState({}, "", window.location.pathname);
      }
    }, 0);
    const initial = window.setTimeout(() => void load(), 0);
    const timer = window.setInterval(() => void load(), 15000);
    return () => {
      window.clearTimeout(callback);
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, []);
  const createProduction = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    actionProgress.start("記事・SEO情報・画像を一括生成（WordPress下書き保存を含む）");
    try {
      const form = event.currentTarget,
        body = Object.fromEntries(new FormData(form)),
        category = form.elements.namedItem(
          "wordpress_category_id",
        ) as HTMLSelectElement | null;
      body.wordpress_category_name =
        category?.selectedOptions[0]?.dataset.label || "";
      const data = await api<{
        production: { articles: Array<{ id: string }>; warnings: string[] };
        notice: string;
      }>("productions", "POST", body);
      setNotice(data.notice);
      await load();
      actionProgress.complete(
        `${data.production.articles.length}本の記事生成・画像保存・WordPress下書き作成が完了しました`,
      );
    } catch (error) {
      const message = errorText(error);
      actionProgress.fail(message);
      setNotice(message);
    } finally {
      setBusy(false);
    }
  };
  const trackButton = (event: ReactMouseEvent<HTMLDivElement>) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest("button");
    if (!button || button.disabled) return;
    actionProgress.pulse(
      button.dataset.progressLabel || button.textContent?.trim() || "画面操作",
    );
  };
  return (
    <div className="app" onClickCapture={trackButton}>
      <aside className="side">
        <div className="brand">
          <i>▶</i>
          <span>
            SEO
            <br />
            LOOP
          </span>
        </div>
        <small>VIDEO SEO WORKSPACE</small>
        <nav className="nav">
          {nav.map(([key, icon, label]) => (
            <button
              key={key}
              data-progress-label={`${label}を表示`}
              className={page === key ? "active" : ""}
              onClick={() => setPage(key)}
            >
              {icon} {label}
            </button>
          ))}
        </nav>
        <div className="engine">
          <i />
          Cloudflare D1 / R2
          <br />
          <span>全端末へ自動同期</span>
        </div>
      </aside>
      <main className="main">
        <header className="top">
          <div>
            <div className="eyebrow">VIDEO PRIMARY INFORMATION × SEO LOOP</div>
            <h1>{nav.find((item) => item[0] === page)?.[2]}</h1>
          </div>
          <div className="client-picker">
            記事 {articles.length} 本・連携{" "}
            {dashboard?.metrics.integrations || 0} 件
          </div>
        </header>
        <div className="content">
          <GenerationProgress progress={actionProgress.progress} />
          {notice && (
            <div className="alerts">
              <div className="alert">
                <b>処理状況</b>
                <span>{notice}</span>
              </div>
            </div>
          )}
          {page === "dashboard" && (
            <DashboardPage dashboard={dashboard} go={setPage} />
          )}
          {page === "studio" && (
            <Studio
              busy={busy}
              integrations={integrations}
              create={createProduction}
              setNotice={setNotice}
              articles={articles}
              refresh={load}
              progress={actionProgress}
            />
          )}
          {page === "library" && (
            <Library
              articles={articles}
              refresh={load}
              setNotice={setNotice}
              progress={actionProgress}
            />
          )}
          {page === "aio" && (
            <AioPage articles={articles} integrations={integrations} />
          )}
          {page === "reports" && (
            <Reports setNotice={setNotice} progress={actionProgress} />
          )}
          {page === "connections" && (
            <Connections
              integrations={integrations}
              refresh={load}
              setNotice={setNotice}
              progress={actionProgress}
            />
          )}
        </div>
      </main>
    </div>
  );
}

function DashboardPage({
  dashboard,
  go,
}: {
  dashboard: Dashboard | null;
  go: (page: "studio" | "connections" | "reports") => void;
}) {
  const metrics = dashboard?.metrics,
    google = new Set(["gsc", "ga4", "drive", "youtube"]);
  return (
    <>
      <div className="heading">
        <div>
          <h2>SEO運用の状況</h2>
          <p>
            動画一次情報の記事制作と、外部データ連携をひとつのダッシュボードで確認します。
          </p>
        </div>
        <button className="primary" onClick={() => go("studio")}>
          動画を登録
        </button>
      </div>
      <section className="kpis">
        <Kpi
          label="記事ライブラリー"
          value={metrics?.articles}
          hint="動画一次情報から作成"
        />
        <Kpi
          label="確認待ち下書き"
          value={metrics?.drafts}
          hint="発言根拠を確認"
        />
        <Kpi
          label="キーワード候補"
          value={metrics?.keywordCandidates}
          hint="Ubersuggest / 動画文脈"
        />
        <Kpi
          label="有効な連携"
          value={metrics?.integrations}
          hint="Secret設定済み"
        />
      </section>
      <section className="panel">
        <h3>データ連携の状態</h3>
        <div className="cards library-cards">
          {(dashboard?.integrations || []).slice(0, 6).map((item) => (
            <article className="connector" key={item.provider}>
              <span
                className={`status ${item.status === "CONFIGURED" ? "" : "draft"}`}
              >
                {item.status === "CONFIGURED" ? "接続済み" : "設定待ち"}
              </span>
              <h3>{item.name}</h3>
              <p>{item.purpose}</p>
              {google.has(item.provider) && item.status === "CONFIGURED" && (
                <small className="selected-target">
                  利用対象:{" "}
                  {configText(item.public_config, "selectedResourceLabel") ||
                    "未選択（連携設定で選択）"}
                </small>
              )}
            </article>
          ))}
        </div>
        <button className="secondary" onClick={() => go("connections")}>
          連携設定を開く
        </button>
      </section>
      <section className="panel">
        <h3>次に行うこと</h3>
        <ol>
          <li>Search ConsoleとGA4の利用対象を選択</li>
          <li>Ubersuggest MCP・Search Console・GA4を接続</li>
          <li>動画を登録し、一次情報に根ざした記事案を作成</li>
          <li>レポートで実測データをワンクリック分析</li>
        </ol>
        <button className="secondary" onClick={() => go("reports")}>
          レポートを見る
        </button>
      </section>
    </>
  );
}
function Kpi({
  label,
  value,
  hint,
}: {
  label: string;
  value?: number;
  hint: string;
}) {
  return (
    <article className="kpi">
      <span>{label}</span>
      <b>{value ?? "—"}</b>
      <small>{hint}</small>
    </article>
  );
}
function Studio({
  busy,
  integrations,
  create,
  setNotice,
  articles,
  refresh,
  progress,
}: {
  busy: boolean;
  integrations: Integration[];
  create: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  setNotice: (message: string) => void;
  articles: Article[];
  refresh: () => Promise<void>;
  progress: ActionProgressController;
}) {
  const wordpressConnected = integrations.some(
      (item) => item.provider === "wordpress" && item.status === "CONFIGURED",
    ),
    [categories, setCategories] = useState<
      Array<{ id: number; label: string; count: number }>
    >([]),
    [loadingCategories, setLoadingCategories] = useState(false),
    [loadingVideo, setLoadingVideo] = useState(false),
    [videoTitle, setVideoTitle] = useState(""),
    [videoDescription, setVideoDescription] = useState(""),
    [videoChapters, setVideoChapters] = useState("");
  const loadVideoMetadata = async (url: string) => {
    if (!url.trim()) return;
    setLoadingVideo(true);
    try {
      const result = await api<{
        metadata: {
          title: string;
          description: string;
          chapters: string;
        };
      }>(`youtube/metadata?url=${encodeURIComponent(url.trim())}`);
      setVideoTitle(result.metadata.title);
      setVideoDescription(result.metadata.description);
      setVideoChapters(result.metadata.chapters);
      setNotice(
        result.metadata.description
          ? "YouTubeのタイトル・概要・目次を読み込みました。"
          : "動画タイトルを読み込みました。概要・目次は記事作成時にも再取得します。",
      );
    } catch (error) {
      setNotice(errorText(error));
    } finally {
      setLoadingVideo(false);
    }
  };
  useEffect(() => {
    if (!wordpressConnected) return;
    const timer = window.setTimeout(() => {
      setLoadingCategories(true);
      void api<{
        categories: Array<{ id: number; label: string; count: number }>;
        warning?: string;
      }>("wordpress/categories")
        .then((result) => {
          setCategories(result.categories);
          if (result.warning) setNotice(result.warning);
        })
        .catch((error) => setNotice(errorText(error)))
        .finally(() => setLoadingCategories(false));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [wordpressConnected, setNotice]);
  return (
    <>
      <div className="heading">
        <div>
          <h2>動画から一次情報記事を制作</h2>
          <p>
            YouTube動画・タイトル・文字起こしをもとに、指定本数の記事、SEO情報、画像、WordPress下書きを一括生成します。
          </p>
        </div>
      </div>
      <form className="panel form-grid" onSubmit={create}>
        <label>
          YouTube動画URL
          <input
            name="youtube_url"
            type="url"
            required
            placeholder="https://www.youtube.com/watch?v=..."
            onBlur={(event) => void loadVideoMetadata(event.currentTarget.value)}
          />
          <small className="field-help">
            URL入力後に、動画タイトル・概要・目次を自動取得します。
          </small>
        </label>
        <label>
          動画タイトル
          <input
            name="youtube_title"
            placeholder="URLから自動取得。取得できない場合に使用します"
            value={videoTitle}
            onChange={(event) => setVideoTitle(event.currentTarget.value)}
          />
          <small className="field-help">
            {loadingVideo ? "YouTube情報を取得中…" : "自動取得後も編集できます。"}
          </small>
        </label>
        <label>
          制作する記事数
          <input
            name="article_limit"
            type="number"
            min="1"
            max="5"
            defaultValue="3"
            required
          />
          <small className="field-help">
            1回の実行で、この本数の記事を自動生成します。
          </small>
        </label>
        <label>
          画像数（1記事あたり）
          <input
            name="image_count"
            type="number"
            min="1"
            max="5"
            defaultValue="3"
            required
          />
          <small className="field-help">
            1枚目はYouTubeサムネイルを元に「A TRUTH STORY」とPART番号を加えた16:9アイキャッチ、2枚目以降は各H2の図解です。
          </small>
        </label>
        <label className="wide">
          記事の方向性
          <input
            name="direction"
            placeholder="例：経営者向けに、挑戦の意思決定を具体的に解説"
          />
        </label>
        <label>
          挑戦者の会社名
          <input
            name="challenger_company"
            required
            placeholder="例：株式会社〇〇"
          />
        </label>
        <label>
          挑戦者の役職
          <input
            name="challenger_role"
            required
            placeholder="例：代表取締役CEO"
          />
        </label>
        <label>
          挑戦者の出演者名
          <input name="challenger_name" required placeholder="例：山田 太郎" />
          <small className="field-help">
            記事では会社名・役職・出演者名を一組で表記します。
          </small>
        </label>
        <label>
          スペシャルゲスト（任意）
          <input name="special_guest" placeholder="例：会社名・役職・氏名" />
        </label>
        <label>
          MC（任意）
          <input name="mc_name" placeholder="例：氏名" />
        </label>
        <label className="wide">
          動画概要（YouTubeから自動取得）
          <textarea
            name="youtube_description"
            rows={6}
            value={videoDescription}
            onChange={(event) => setVideoDescription(event.currentTarget.value)}
            placeholder="YouTube動画の概要欄を自動取得します。必要に応じて追記できます。"
          />
        </label>
        <label className="wide">
          動画目次・チャプター（YouTubeから自動抽出）
          <textarea
            name="youtube_chapters"
            rows={5}
            value={videoChapters}
            onChange={(event) => setVideoChapters(event.currentTarget.value)}
            placeholder="00:00 オープニング のような目次を概要欄から抽出します。"
          />
        </label>
        {wordpressConnected && (
          <label className="wide">
            WordPress投稿カテゴリー
            <select
              name="wordpress_category_id"
              required
              disabled={loadingCategories || !categories.length}
            >
              <option value="">
                {loadingCategories
                  ? "カテゴリーを取得中…"
                  : categories.length
                    ? "投稿先カテゴリーを選択"
                    : "カテゴリーを取得できません"}
              </option>
              {categories.map((category) => (
                <option
                  key={category.id}
                  value={category.id}
                  data-label={category.label}
                >
                  {category.label}（{category.count}件）
                </option>
              ))}
            </select>
            <small className="field-help">
              「記事を作成する」を押すと、生成した全記事をこのカテゴリーへ下書きで自動保存します。
            </small>
          </label>
        )}
        <label className="wide">
          文字起こし
          <textarea
            name="transcript"
            required
            minLength={80}
            rows={15}
            placeholder="YouTubeの文字起こしを貼り付けてください。タイムスタンプ付きのままで構いません。"
          />
        </label>
        <div className="button-row wide">
          <button
            className="primary production-button"
            disabled={busy || (wordpressConnected && !categories.length)}
          >
            {busy ? "記事を制作中…" : "記事を作成する"}
          </button>
        </div>
        <p className="field-help wide">
          Claudeが動画概要・目次・文字起こしを照合して文章とSEO情報を作り、GPT Image 2.5 SunburstがYouTubeサムネイルのアイキャッチと16:9の情報図解を生成します。処理中は上部に進捗率を表示します。
        </p>
      </form>
      <section className="studio-generated">
        <div className="heading compact-heading">
          <div>
            <div className="eyebrow">GENERATED ARTICLES</div>
            <h2>生成済み記事</h2>
            <p>
              カードを押すと、この画面のまま本文・H2・画像・SEO情報を編集できます。
            </p>
          </div>
        </div>
        <Library
          articles={articles}
          refresh={refresh}
          setNotice={setNotice}
          progress={progress}
          embedded
        />
      </section>
    </>
  );
}
type EditorSection = { id: string; heading: string; bodyHtml: string };
function splitArticleBody(html = "") {
  const matches = [...html.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi)];
  if (!matches.length)
    return {
      intro: "",
      sections: [
        {
          id: "section-1",
          heading: "本文",
          bodyHtml: html || "<p>本文を入力してください。</p>",
        },
      ] as EditorSection[],
    };
  const intro = html.slice(0, matches[0].index || 0);
  return {
    intro,
    sections: matches.map((match, index) => ({
      id: `section-${index + 1}`,
      heading:
        String(match[1] || "")
          .replace(/<[^>]+>/g, "")
          .trim() || `セクション${index + 1}`,
      bodyHtml: html
        .slice(
          (match.index || 0) + match[0].length,
          matches[index + 1]?.index || html.length,
        )
        .trim(),
    })),
  };
}
const escapeEditorText = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ] || character,
  );
const combineArticleBody = (intro: string, sections: EditorSection[]) =>
  `${intro}${sections.map((section) => `<h2>${escapeEditorText(section.heading)}</h2>${section.bodyHtml}`).join("")}`;
function Library({
  articles,
  refresh,
  setNotice,
  progress,
  embedded = false,
}: {
  articles: Article[];
  refresh: () => Promise<void>;
  setNotice: (message: string) => void;
  progress: ActionProgressController;
  embedded?: boolean;
}) {
  const [openId, setOpenId] = useState("");
  return (
    <>
      {!embedded && (
        <div className="heading">
          <div>
            <h2>記事ライブラリー</h2>
            <p>
              SEO
              LOOPと同じ見た目で、本文・H2・画像・SEO情報を確認して直接編集できます。
            </p>
          </div>
        </div>
      )}
      <div className={`article-library-list ${embedded ? "embedded" : ""}`}>
        {articles.map((item) => (
          <ArticleLibraryItem
            key={item.id}
            item={item}
            open={openId === item.id}
            toggle={() => setOpenId(openId === item.id ? "" : item.id)}
            refresh={refresh}
            setNotice={setNotice}
            progress={progress}
          />
        ))}
      </div>
      {!articles.length && (
        <section className="panel empty-library">
          まだ記事はありません。上のフォームから動画一次情報を登録してください。
        </section>
      )}
    </>
  );
}
function ArticleLibraryItem({
  item,
  open,
  toggle,
  refresh,
  setNotice,
  progress,
}: {
  item: Article;
  open: boolean;
  toggle: () => void;
  refresh: () => Promise<void>;
  setNotice: (message: string) => void;
  progress: ActionProgressController;
}) {
  const [draft, setDraft] = useState(item),
    [editingSection, setEditingSection] = useState(""),
    [saving, setSaving] = useState(false),
    [busyAction, setBusyAction] = useState(""),
    [images, setImages] = useState<ArticleImage[]>([]),
    [instructions, setInstructions] = useState<Record<string, string>>({}),
    [imageSettings, setImageSettings] = useState<
      Record<string, { prompt: string; alt: string }>
    >({}),
    parsed = splitArticleBody(draft.body_html),
    sectionImages: string[] = (() => {
      try {
        const value = JSON.parse(draft.section_images_json || "[]");
        return Array.isArray(value) ? value : [];
      } catch {
        return [];
      }
    })(),
    suggestions: Array<{ heading?: string; prompt?: string; alt?: string }> =
      (() => {
        try {
          const value = JSON.parse(draft.image_suggestions_json || "[]");
          return Array.isArray(value) ? value : [];
        } catch {
          return [];
        }
      })();
  useEffect(() => {
    const timer = window.setTimeout(() => setDraft(item), 0);
    return () => window.clearTimeout(timer);
  }, [item]);
  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => {
      void api<{ images: ArticleImage[] }>(`articles/${item.id}/images`)
        .then((result) => {
          setImages(result.images);
          const settings: Record<string, { prompt: string; alt: string }> = {};
          for (const image of result.images)
            settings[
              image.kind === "featured"
                ? "featured"
                : image.section_heading || image.id
            ] = { prompt: image.prompt || "", alt: image.alt_text || "" };
          setImageSettings(settings);
        })
        .catch((error) => setNotice(errorText(error)));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [open, item.id, setNotice]);
  const updateSections = (intro: string, sections: EditorSection[]) =>
    setDraft((current) => ({
      ...current,
      body_html: combineArticleBody(intro, sections),
    }));
  const save = async () => {
    setSaving(true);
    progress.start("記事の編集内容を保存");
    try {
      const result = await api<{ notice: string }>(
        `articles/${item.id}`,
        "PATCH",
        {
          title: draft.title,
          title_tag: draft.title_tag,
          meta_description: draft.meta_description,
          slug: draft.slug,
          catch_copy: draft.catch_copy,
          main_keyword: draft.main_keyword,
          related_keywords: draft.related_keywords || [],
          search_intent: draft.search_intent,
          reader: draft.reader,
          angle: draft.angle,
          body_html: draft.body_html,
        },
      );
      setNotice(result.notice);
      await refresh();
      progress.complete("記事とWordPress下書きの保存処理が完了しました");
    } catch (error) {
      const message = errorText(error);
      setNotice(message);
      progress.fail(message);
    } finally {
      setSaving(false);
    }
  };
  const regenerateSection = async (section: EditorSection, index: number) => {
    const actionKey = `section-${index}`;
    setBusyAction(actionKey);
    progress.start(`H2「${section.heading}」をAIで再生成`);
    try {
      const result = await api<{
        section: {
          heading: string;
          html: string;
          imagePrompt: string;
          altText: string;
        };
        notice: string;
      }>(`articles/${item.id}/regenerate-section`, "POST", {
        heading: section.heading,
        currentHtml: section.bodyHtml,
        instruction: instructions[section.id] || "",
      });
      const nextSections = parsed.sections.map((current, currentIndex) =>
        currentIndex === index
          ? {
              ...current,
              heading: result.section.heading,
              bodyHtml: result.section.html,
            }
          : current,
      );
      updateSections(parsed.intro, nextSections);
      setImageSettings((current) => ({
        ...current,
        [result.section.heading]: {
          prompt: result.section.imagePrompt,
          alt: result.section.altText,
        },
      }));
      setNotice(result.notice);
      progress.complete("H2本文のAI再生成が完了しました");
    } catch (error) {
      const message = errorText(error);
      setNotice(message);
      progress.fail(message);
    } finally {
      setBusyAction("");
    }
  };
  const regenerateImage = async (
    kind: "featured" | "section",
    section: EditorSection | null,
    index: number,
  ) => {
    const key =
        kind === "featured"
          ? "featured"
          : section?.heading || `section-${index}`,
      suggestion = kind === "featured" ? null : suggestions[index],
      settings = imageSettings[key] || {
        prompt: suggestion?.prompt || "",
        alt: suggestion?.alt || "",
      },
      actionKey = `image-${key}`;
    setBusyAction(actionKey);
    progress.start(
      kind === "featured"
        ? "アイキャッチ画像をAIで再生成"
        : `H2「${section?.heading || ""}」の画像をAIで再生成`,
    );
    try {
      const result = await api<{ image: ArticleImage; notice: string }>(
        `articles/${item.id}/regenerate-image`,
        "POST",
        {
          kind,
          heading: section?.heading || "",
          sectionIndex: index,
          prompt: settings.prompt,
          altText: settings.alt,
        },
      );
      setImages((current) => [
        result.image,
        ...current.filter(
          (image) =>
            image.kind !== kind ||
            (kind === "section" && image.section_heading !== section?.heading),
        ),
      ]);
      if (kind === "featured")
        setDraft((current) => ({
          ...current,
          featured_image_url: result.image.url,
        }));
      else {
        const nextImages = [...sectionImages];
        nextImages[index] = result.image.url;
        setDraft((current) => ({
          ...current,
          section_images_json: JSON.stringify(nextImages),
        }));
      }
      setNotice(result.notice);
      progress.complete("AI画像の生成とWordPress下書きへの反映が完了しました");
    } catch (error) {
      const message = errorText(error);
      setNotice(message);
      progress.fail(message);
    } finally {
      setBusyAction("");
    }
  };
  const featuredSettings = imageSettings.featured || {
      prompt: `記事「${draft.title}」の主題と主要論点を整理した全体構造図`,
      alt: `${draft.title}の全体構造を整理した図解`,
    },
    featuredImage =
      images.find((image) => image.kind === "featured")?.url ||
      draft.featured_image_url,
    wordpressPreviewUrl =
      item.wordpress_preview_url ||
      item.wordpress_edit_url?.replace(
        /\/wp-admin\/post\.php\?post=(\d+)&action=edit/,
        "/?p=$1&preview=true",
      );
  return (
    <article className={`panel library-editor-item ${open ? "is-open" : ""}`}>
      <button className="library-editor-head" onClick={toggle}>
        <span>{item.category_name || "カテゴリー未指定"}</span>
        <b>{item.title}</b>
        <em
          className={
            item.wordpress_status === "DRAFT" ? "status connected" : "status"
          }
        >
          {item.wordpress_status === "DRAFT" ? "WordPress下書き" : "確認待ち"}
        </em>
      </button>
      <div className="library-editor-summary">
        <b>狙うキーワード:</b> {item.main_keyword}
        <br />
        <b>検索意図:</b> {item.search_intent || "情報収集"}
        <br />
        <small>
          最終更新: {new Date(item.updated_at).toLocaleString("ja-JP")}
        </small>
      </div>
      {open && (
        <div className="article-visual-editor">
          <section className="editor-guide">
            <b>WordPressと同じ見た目で、直接編集できます</b>
            <span>
              H2は手動編集とAI再生成の両方に対応します。保存すると記事ライブラリーとWordPress下書きを同時更新します。
            </span>
          </section>
          <article className="wp-article-canvas">
            <header className="wp-article-header">
              <p className="wp-article-kicker">記事プレビュー</p>
              <h1>{draft.title || "記事タイトル"}</h1>
              <p className="wp-article-description">
                {draft.meta_description ||
                  "検索結果に表示する説明文を設定できます。"}
              </p>
              {featuredImage && (
                <div
                  className="wp-featured-media"
                  role="img"
                  aria-label={featuredSettings.alt}
                  style={{ backgroundImage: `url(${featuredImage})` }}
                />
              )}
              <details className="image-ai-settings">
                <summary>記事全体の16:9図解を設定・AI再生成</summary>
                <label>
                  画像の指示
                  <textarea
                    value={featuredSettings.prompt}
                    onChange={(event) =>
                      setImageSettings((current) => ({
                        ...current,
                        featured: {
                          ...featuredSettings,
                          prompt: event.target.value,
                        },
                      }))
                    }
                  />
                </label>
                <label>
                  代替テキスト（alt）
                  <input
                    value={featuredSettings.alt}
                    onChange={(event) =>
                      setImageSettings((current) => ({
                        ...current,
                        featured: {
                          ...featuredSettings,
                          alt: event.target.value,
                        },
                      }))
                    }
                  />
                </label>
                <button
                  type="button"
                  className="secondary"
                  disabled={Boolean(busyAction)}
                  onClick={() => void regenerateImage("featured", null, 0)}
                >
                  {busyAction === "image-featured"
                    ? "AI画像を生成中…"
                    : "記事全体の図解をAIで再生成"}
                </button>
              </details>
            </header>
            {parsed.intro && (
              <div
                className="wp-article-intro"
                contentEditable
                suppressContentEditableWarning
                dangerouslySetInnerHTML={{ __html: parsed.intro }}
                onBlur={(event) =>
                  updateSections(event.currentTarget.innerHTML, parsed.sections)
                }
              />
            )}
            {parsed.sections.map((section, index) => {
              const isEditing = editingSection === section.id,
                image = images.find(
                  (candidate) =>
                    candidate.kind === "section" &&
                    candidate.section_heading === section.heading,
                ),
                settingKey = section.heading,
                setting = imageSettings[settingKey] || {
                  prompt:
                    suggestions[index]?.prompt ||
                    `H2「${section.heading}」の論点・因果関係・流れを整理した情報図解`,
                  alt:
                    suggestions[index]?.alt || `${section.heading}の解説画像`,
                },
                sectionImage = image?.url || sectionImages[index];
              return (
                <section
                  className={`wp-editor-section ${isEditing ? "is-editing" : ""}`}
                  key={section.id}
                >
                  {isEditing ? (
                    <input
                      className="wp-section-heading-input"
                      aria-label={`H2見出し ${index + 1}`}
                      value={section.heading}
                      onChange={(event) =>
                        updateSections(
                          parsed.intro,
                          parsed.sections.map((current, currentIndex) =>
                            currentIndex === index
                              ? { ...current, heading: event.target.value }
                              : current,
                          ),
                        )
                      }
                    />
                  ) : (
                    <h2>{section.heading}</h2>
                  )}
                  {isEditing ? (
                    <div
                      className="wp-content-editable"
                      contentEditable
                  suppressContentEditableWarning
                  dangerouslySetInnerHTML={{ __html: section.bodyHtml }}
                  onBlur={(event) =>
                    updateSections(
                      parsed.intro,
                      parsed.sections.map((current, currentIndex) =>
                        currentIndex === index
                          ? {
                              ...current,
                              bodyHtml: event.currentTarget.innerHTML,
                            }
                          : current,
                      ),
                    )
                  }
                />
                  ) : (
                    <div
                      className="wp-rendered-content"
                      dangerouslySetInnerHTML={{ __html: section.bodyHtml }}
                    />
                  )}
                  {sectionImage && (
                    <div
                      className="wp-section-media"
                      role="img"
                      aria-label={setting.alt}
                      style={{ backgroundImage: `url(${sectionImage})` }}
                    />
                  )}
                  {isEditing && (
                    <div className="h2-ai-tools">
                      <label>
                        AI本文再生成への追加指示（任意）
                        <textarea
                          value={instructions[section.id] || ""}
                          placeholder="例：初心者向けに、動画内の具体的な発言を中心に整理"
                          onChange={(event) =>
                            setInstructions((current) => ({
                              ...current,
                              [section.id]: event.target.value,
                            }))
                          }
                        />
                      </label>
                      <button
                        type="button"
                        className="secondary"
                        disabled={Boolean(busyAction)}
                        onClick={() => void regenerateSection(section, index)}
                      >
                        {busyAction === `section-${index}`
                          ? "AI本文を再生成中…"
                          : "このH2本文をAIで再生成"}
                      </button>
                      <div className="image-setting-grid">
                        <label>
                          16:9図解の内容・構造
                          <textarea
                            value={setting.prompt}
                            onChange={(event) =>
                              setImageSettings((current) => ({
                                ...current,
                                [settingKey]: {
                                  ...setting,
                                  prompt: event.target.value,
                                },
                              }))
                            }
                          />
                        </label>
                        <label>
                          画像の代替テキスト（alt）
                          <input
                            value={setting.alt}
                            onChange={(event) =>
                              setImageSettings((current) => ({
                                ...current,
                                [settingKey]: {
                                  ...setting,
                                  alt: event.target.value,
                                },
                              }))
                            }
                          />
                        </label>
                      </div>
                      <button
                        type="button"
                        className="secondary"
                        disabled={Boolean(busyAction)}
                        onClick={() =>
                          void regenerateImage("section", section, index)
                        }
                      >
                        {busyAction === `image-${settingKey}`
                          ? "AI画像を生成中…"
                          : "このH2画像をAIで再生成"}
                      </button>
                    </div>
                  )}
                  <div className="wp-section-actions">
                    <button
                      type="button"
                      className="secondary"
                      onClick={() =>
                        setEditingSection(isEditing ? "" : section.id)
                      }
                    >
                      {isEditing ? "編集を終了" : "このH2を編集"}
                    </button>
                    <button
                      type="button"
                      className="text-button"
                      disabled={parsed.sections.length === 1}
                      onClick={() =>
                        updateSections(
                          parsed.intro,
                          parsed.sections.filter(
                            (_, currentIndex) => currentIndex !== index,
                          ),
                        )
                      }
                    >
                      このH2を削除
                    </button>
                  </div>
                </section>
              );
            })}
            <button
              type="button"
              className="secondary wp-add-section"
              onClick={() =>
                updateSections(parsed.intro, [
                  ...parsed.sections,
                  {
                    id: `section-${parsed.sections.length + 1}`,
                    heading: "新しい見出し",
                    bodyHtml: "<p>本文を入力してください。</p>",
                  },
                ])
              }
            >
              H2セクションを追加
            </button>
          </article>
          <details className="seo-settings-panel" open>
            <summary>
              SEO設定（タイトルタグ・URL末尾・説明文・キーワード）
            </summary>
            <div className="seo-editor-grid">
              <label>
                記事タイトル（H1）
                <input
                  value={draft.title || ""}
                  onChange={(event) =>
                    setDraft({ ...draft, title: event.target.value })
                  }
                />
              </label>
              <label>
                SEOタイトル（titleタグ）
                <input
                  value={draft.title_tag || ""}
                  maxLength={80}
                  onChange={(event) =>
                    setDraft({ ...draft, title_tag: event.target.value })
                  }
                />
                <small>{String(draft.title_tag || "").length}/60文字目安</small>
              </label>
              <label>
                URL末尾（slug）
                <input
                  value={draft.slug || ""}
                  onChange={(event) =>
                    setDraft({ ...draft, slug: event.target.value })
                  }
                />
                <small>公開URL: /{draft.slug || "article"}</small>
              </label>
              <label>
                メタディスクリプション
                <textarea
                  value={draft.meta_description || ""}
                  maxLength={160}
                  onChange={(event) =>
                    setDraft({ ...draft, meta_description: event.target.value })
                  }
                />
                <small>
                  {String(draft.meta_description || "").length}/120文字目安
                </small>
              </label>
              <label>
                主軸キーワード
                <input
                  value={draft.main_keyword || ""}
                  onChange={(event) =>
                    setDraft({ ...draft, main_keyword: event.target.value })
                  }
                />
              </label>
              <label>
                関連キーワード
                <input
                  value={(draft.related_keywords || []).join("、")}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      related_keywords: event.target.value
                        .split(/[、,]+/)
                        .map((value) => value.trim())
                        .filter(Boolean),
                    })
                  }
                />
              </label>
            </div>
          </details>
          <details className="technical-details">
            <summary>詳細設定：WordPress用HTMLを確認・修正する</summary>
            <textarea
              className="article-html-editor"
              value={draft.body_html || ""}
              onChange={(event) =>
                setDraft({ ...draft, body_html: event.target.value })
              }
            />
          </details>
          <div className="button-row editor-save-row">
            <button
              type="button"
              className="primary"
              disabled={saving || Boolean(busyAction)}
              onClick={() => void save()}
            >
              {saving ? "保存中…" : "変更を保存してプレビューへ反映"}
            </button>
            {wordpressPreviewUrl && (
              <a
                className="secondary wp-edit-link"
                href={wordpressPreviewUrl}
                target="_blank"
                rel="noreferrer"
              >
                WordPress下書きを閲覧
              </a>
            )}
            {item.wordpress_edit_url && (
              <a
                className="secondary wp-edit-link"
                href={item.wordpress_edit_url}
                target="_blank"
                rel="noreferrer"
              >
                WordPressで編集
              </a>
            )}
          </div>
        </div>
      )}
    </article>
  );
}
function AioPage({
  articles,
  integrations,
}: {
  articles: Article[];
  integrations: Integration[];
}) {
  const claude =
    integrations.find((item) => item.provider === "anthropic")?.status ===
    "CONFIGURED";
  return (
    <>
      <div className="heading">
        <div>
          <h2>LLMO / AIO 分析</h2>
          <p>
            動画一次情報がAI検索の回答に使える構造になっているかを確認します。
          </p>
        </div>
      </div>
      <section className="kpis">
        <Kpi label="一次情報記事" value={articles.length} hint="分析対象" />
        <Kpi
          label="Claude分析"
          value={claude ? 1 : 0}
          hint={claude ? "接続済み" : "接続待ち"}
        />
        <Kpi label="根拠の明示" value={articles.length} hint="発言を保存" />
        <Kpi label="推測の追加" value={0} hint="禁止ルール" />
      </section>
      <section className="panel">
        <h3>分析の観点</h3>
        <ul>
          <li>動画内の発言者・出典・文脈が記事中で確認できるか</li>
          <li>検索意図に対する直接的な回答が冒頭にあるか</li>
          <li>動画に存在しない数値・比較・効果を追加していないか</li>
          <li>地域・言語・デバイス設定に合う語句になっているか</li>
        </ul>
        <p className="field-help">
          Claude
          Secretを設定後、Haikuで根拠抽出、Sonnetで構成と表現の監査を行います。
        </p>
      </section>
    </>
  );
}
function Reports({
  setNotice,
  progress,
}: {
  setNotice: (message: string) => void;
  progress: ActionProgressController;
}) {
  const [report, setReport] = useState<AutomatedReport | null>(null),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    const initial = window.setTimeout(
      () =>
        void api<{ report: AutomatedReport | null }>("reports/latest")
          .then((result) => setReport(result.report))
          .catch((error) => setNotice(errorText(error)))
          .finally(() => setLoading(false)),
      0,
    );
    return () => window.clearTimeout(initial);
  }, [setNotice]);
  const analyze = async () => {
    setBusy(true);
    progress.start("全データ自動分析");
    try {
      const result = await api<{ report: AutomatedReport; notice: string }>(
        "reports/analyze",
        "POST",
        {},
      );
      setReport(result.report);
      progress.complete("実データの取得とAI分析が完了しました");
      setNotice(result.notice);
    } catch (error) {
      const message = errorText(error);
      progress.fail(message);
      setNotice(message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="heading report-heading">
        <div>
          <div className="eyebrow">ONE CLICK SEO INTELLIGENCE</div>
          <h2>レポート・PDCA</h2>
          <p>
            Search
            Console・GA4・Ubersuggest・実SERP・競合ページをまとめて取得し、AIが自動分析します。
          </p>
        </div>
        <button
          className="primary report-run"
          disabled={busy}
          onClick={() => void analyze()}
        >
          {busy ? "分析中…" : "すべての実データを分析"}
        </button>
      </div>
      {loading ? (
        <section className="panel report-empty">
          保存済みレポートを読み込んでいます…
        </section>
      ) : !report ? (
        <section className="panel report-empty">
          <b>まだ分析レポートはありません</b>
          <p>
            右上のボタンを1回押すだけで、接続済みの全データを取得してAI分析を開始します。
          </p>
        </section>
      ) : (
        <ReportView report={report} />
      )}
    </>
  );
}

const compactNumber = (value: number) =>
  new Intl.NumberFormat("ja-JP", {
    notation: value >= 10000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(value);
function ReportView({ report }: { report: AutomatedReport }) {
  const searchMetrics = report.gsc?.summary,
    trafficMetrics = report.ga4?.summary;
  return (
    <div className="automated-report">
      <section className="panel report-hero">
        <div>
          <small>SEO PERFORMANCE REPORT · {report.aiProvider}</small>
          <h3>{report.keyword || "サイト全体"} の統合分析</h3>
          <p>
            {report.period.start} 〜 {report.period.end} / 最終更新{" "}
            {new Date(report.generatedAt).toLocaleString("ja-JP")}
          </p>
        </div>
        <div className="overall-score">
          <span>総合スコア</span>
          <b>{report.scores.overall}</b>
          <small>/ 100</small>
        </div>
      </section>
      <section className="report-source-grid">
        {report.sourceStatus.map((item) => (
          <article
            className={`source-state ${item.status === "取得済み" ? "ready" : "missing"}`}
            key={`${item.source}-${item.detail}`}
          >
            <span>{item.status === "取得済み" ? "✓" : "!"}</span>
            <div>
              <b>{item.source}</b>
              <p>{item.detail}</p>
            </div>
          </article>
        ))}
      </section>
      <section className="report-kpi-grid">
        <ReportMetric
          label="検索クリック"
          value={searchMetrics ? compactNumber(searchMetrics.clicks) : "—"}
          hint="Search Console・28日"
        />
        <ReportMetric
          label="検索表示回数"
          value={searchMetrics ? compactNumber(searchMetrics.impressions) : "—"}
          hint="Search Console・28日"
        />
        <ReportMetric
          label="CTR"
          value={
            searchMetrics ? `${(searchMetrics.ctr * 100).toFixed(1)}%` : "—"
          }
          hint="クリック率"
        />
        <ReportMetric
          label="平均掲載順位"
          value={searchMetrics ? searchMetrics.position.toFixed(1) : "—"}
          hint="Search Console"
        />
        <ReportMetric
          label="セッション"
          value={trafficMetrics ? compactNumber(trafficMetrics.sessions) : "—"}
          hint="GA4・28日"
        />
        <ReportMetric
          label="ユーザー"
          value={trafficMetrics ? compactNumber(trafficMetrics.users) : "—"}
          hint="GA4・28日"
        />
        <ReportMetric
          label="エンゲージメント"
          value={
            trafficMetrics?.sessions
              ? `${((trafficMetrics.engagedSessions / trafficMetrics.sessions) * 100).toFixed(1)}%`
              : "—"
          }
          hint="GA4"
        />
        <ReportMetric
          label="キーイベント"
          value={trafficMetrics ? compactNumber(trafficMetrics.keyEvents) : "—"}
          hint="GA4"
        />
      </section>
      <section className="analysis-grid">
        <article className="panel chart-panel">
          <h3>検索パフォーマンス推移</h3>
          <TrendChart
            points={report.trend.search}
            primaryLabel="クリック"
            secondaryLabel="表示回数"
          />
        </article>
        <article className="panel chart-panel">
          <h3>流入・エンゲージメント推移</h3>
          <TrendChart
            points={report.trend.traffic}
            primaryLabel="セッション"
            secondaryLabel="エンゲージ"
          />
        </article>
      </section>
      <section className="analysis-grid">
        <article className="panel score-panel">
          <h3>統合分析スコア</h3>
          <ReportScoreBars scores={report.scores} />
        </article>
        <article className="panel ai-summary">
          <small>AI EXECUTIVE SUMMARY</small>
          <h3>AI総合所見</h3>
          <p>{report.ai.executiveSummary}</p>
          <div className="ai-columns">
            <div>
              <h4>強み</h4>
              <ul>
                {report.ai.strengths.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
            <div>
              <h4>課題</h4>
              <ul>
                {report.ai.issues.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          </div>
        </article>
      </section>
      <section className="analysis-grid">
        <ReportTable
          title="Search Console 上位クエリ"
          empty="Search Consoleの対象サイトを選択すると表示されます。"
          headers={["クエリ", "クリック", "表示", "CTR", "順位"]}
          rows={(report.gsc?.queries || [])
            .slice(0, 10)
            .map((item) => [
              item.query,
              compactNumber(item.clicks),
              compactNumber(item.impressions),
              `${(item.ctr * 100).toFixed(1)}%`,
              item.position.toFixed(1),
            ])}
        />
        <ReportTable
          title="GA4 上位ランディングページ"
          empty="GA4の対象プロパティを選択すると表示されます。"
          headers={[
            "ページ",
            "ユーザー",
            "セッション",
            "エンゲージ",
            "イベント",
          ]}
          rows={(report.ga4?.pages || [])
            .slice(0, 10)
            .map((item) => [
              item.page,
              compactNumber(item.users),
              compactNumber(item.sessions),
              compactNumber(item.engagedSessions),
              compactNumber(item.keyEvents),
            ])}
        />
      </section>
      <section className="analysis-grid">
        <article className="panel">
          <h3>Ubersuggest・実SERP競合</h3>
          {report.competitors.length ? (
            <div className="competitor-list">
              {report.competitors.map((item) => (
                <a
                  href={item.url}
                  target="_blank"
                  rel="noreferrer"
                  key={`${item.rank}-${item.url}`}
                >
                  <span>{item.rank}</span>
                  <div>
                    <b>{item.title || item.domain || item.url}</b>
                    <small>{item.domain || item.url}</small>
                  </div>
                </a>
              ))}
            </div>
          ) : (
            <p className="field-help">
              Ubersuggest MCPを接続すると、実SERP上位の競合が自動表示されます。
            </p>
          )}
        </article>
        <article className="panel">
          <h3>競合テーマと機会</h3>
          <h4>共通テーマ</h4>
          <div className="tag-cloud">
            {(report.competition?.commonTopics || []).map((item) => (
              <span key={item}>{item}</span>
            ))}
          </div>
          <h4>コンテンツギャップ</h4>
          <div className="tag-cloud gaps">
            {(report.competition?.gaps || []).map((item) => (
              <span key={item}>{item}</span>
            ))}
          </div>
          {!report.competition && (
            <p className="field-help">
              競合ページを取得できると、自動的に共通テーマと不足領域を表示します。
            </p>
          )}
        </article>
      </section>
      <section className="panel action-panel">
        <h3>AI推奨アクション</h3>
        <ol>
          {report.ai.actions.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ol>
      </section>
      <section className="panel">
        <h3>自動PDCA</h3>
        <div className="pdca-board">
          {(["plan", "do", "check", "act"] as const).map((phase) => (
            <article key={phase}>
              <b>{phase.toUpperCase()}</b>
              {report.ai.pdca[phase].map((item) => (
                <p key={item}>{item}</p>
              ))}
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
function ReportMetric({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <article className="report-metric">
      <span>{label}</span>
      <b>{value}</b>
      <small>{hint}</small>
    </article>
  );
}
function ReportScoreBars({ scores }: { scores: AutomatedReport["scores"] }) {
  const labels: Array<[keyof AutomatedReport["scores"], string]> = [
    ["visibility", "検索可視性"],
    ["engagement", "流入後の質"],
    ["competitive", "競合分析深度"],
    ["opportunity", "成長機会"],
    ["overall", "総合"],
  ];
  return (
    <div className="score-bars">
      {labels.map(([key, label]) => (
        <div key={key}>
          <span>{label}</span>
          <i>
            <b
              style={{ width: `${Math.max(0, Math.min(100, scores[key]))}%` }}
            />
          </i>
          <strong>{scores[key]}</strong>
        </div>
      ))}
    </div>
  );
}
function TrendChart({
  points,
  primaryLabel,
  secondaryLabel,
}: {
  points: TrendPoint[];
  primaryLabel: string;
  secondaryLabel: string;
}) {
  if (!points.length)
    return (
      <div className="chart-empty">
        対象データを取得すると推移グラフを表示します。
      </div>
    );
  const width = 620,
    height = 210,
    pad = 22,
    x = (index: number) =>
      points.length === 1
        ? width / 2
        : pad + (index * (width - pad * 2)) / (points.length - 1),
    line = (key: "primary" | "secondary") => {
      const max = Math.max(1, ...points.map((item) => item[key]));
      return points
        .map(
          (item, index) =>
            `${x(index)},${height - pad - (item[key] / max) * (height - pad * 2)}`,
        )
        .join(" ");
    };
  return (
    <>
      <div className="chart-legend">
        <span className="primary-dot">{primaryLabel}</span>
        <span className="secondary-dot">{secondaryLabel}</span>
      </div>
      <svg
        className="trend-chart"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`${primaryLabel}と${secondaryLabel}の推移`}
      >
        <line x1={pad} y1={height - pad} x2={width - pad} y2={height - pad} />
        <polyline className="primary-line" points={line("primary")} />
        <polyline className="secondary-line" points={line("secondary")} />
      </svg>
      <div className="chart-range">
        <span>{points[0].date}</span>
        <span>{points.at(-1)?.date}</span>
      </div>
    </>
  );
}
function ReportTable({
  title,
  empty,
  headers,
  rows,
}: {
  title: string;
  empty: string;
  headers: string[];
  rows: string[][];
}) {
  return (
    <article className="panel report-table">
      <h3>{title}</h3>
      {rows.length ? (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                {headers.map((header) => (
                  <th key={header}>{header}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={`${row[0]}-${rowIndex}`}>
                  {row.map((cell, index) => (
                    <td key={`${index}-${cell}`}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="field-help">{empty}</p>
      )}
    </article>
  );
}
function Connections({
  integrations,
  refresh,
  setNotice,
  progress,
}: {
  integrations: Integration[];
  refresh: () => Promise<void>;
  setNotice: (message: string) => void;
  progress: ActionProgressController;
}) {
  const [expanded, setExpanded] = useState<string | null>(null),
    [working, setWorking] = useState<string | null>(null),
    icon: Record<string, string> = {
      ubersuggest: "U",
      gsc: "G",
      ga4: "A",
      drive: "D",
      youtube: "Y",
      anthropic: "C",
      openai: "I",
      wordpress: "W",
      pagespeed: "P",
      notion: "N",
    },
    google = new Set(["gsc", "ga4", "drive", "youtube"]);
  const providerName = (provider: string) =>
    integrations.find((item) => item.provider === provider)?.name || provider;
  const execute = async (
    provider: string,
    label: string,
    completed: string,
    task: () => Promise<void>,
  ) => {
    setWorking(provider);
    progress.start(label);
    try {
      await task();
      await refresh();
      progress.complete(completed);
    } catch (error) {
      const message = errorText(error);
      progress.fail(message);
      setNotice(message);
    } finally {
      setWorking(null);
    }
  };
  const check = (event: FormEvent<HTMLFormElement>, provider: string) => {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(event.currentTarget));
    void execute(
      provider,
      `${providerName(provider)}の接続確認`,
      "保存と接続テストが完了しました",
      async () => {
        const result = await api<{ notice: string }>(
          `integrations/${provider}/check`,
          "POST",
          body,
        );
        setNotice(result.notice);
      },
    );
  };
  const connect = (
    event: FormEvent<HTMLFormElement>,
    provider: "google" | "ubersuggest",
  ) => {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(event.currentTarget));
    void execute(
      provider,
      `${providerName(provider)}の認証準備`,
      "認証画面の準備が完了しました",
      async () => {
        const result = await api<{ authorizationUrl: string }>(
          `integrations/${provider}/connect`,
          "POST",
          body,
        );
        window.location.assign(result.authorizationUrl);
      },
    );
  };
  const disconnect = (provider: string) =>
    void execute(
      provider,
      `${providerName(provider)}の連携解除`,
      "連携解除が完了しました",
      async () => {
        const result = await api<{ notice: string }>(
          `integrations/${provider}/disconnect`,
          "POST",
          {},
        );
        setNotice(result.notice);
      },
    );
  const selectResource = (
    event: FormEvent<HTMLFormElement>,
    provider: string,
  ) => {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(event.currentTarget));
    void execute(
      provider,
      `${providerName(provider)}の利用対象を保存`,
      "利用対象の保存が完了しました",
      async () => {
        const result = await api<{ notice: string }>(
          `integrations/${provider}/select`,
          "POST",
          body,
        );
        setNotice(result.notice);
      },
    );
  };
  const staticFields = (provider: string, config: Record<string, unknown>) => {
    if (provider === "wordpress")
      return (
        <>
          <label>
            WordPress URL
            <input
              name="siteUrl"
              type="url"
              required
              defaultValue={configText(config, "siteUrl")}
              placeholder="https://example.com"
            />
          </label>
          <label>
            WordPressユーザー名
            <input
              name="username"
              required
              defaultValue={configText(config, "username")}
              autoComplete="username"
            />
          </label>
          <label>
            WordPressアプリパスワード
            <input
              name="applicationPassword"
              type="password"
              required
              autoComplete="new-password"
              placeholder="xxxx xxxx xxxx xxxx xxxx xxxx"
            />
          </label>
          <p className="field-help">
            WordPress管理画面の「ユーザー → プロフィール →
            アプリケーションパスワード」で発行できます。
          </p>
        </>
      );
    if (provider === "anthropic")
      return (
        <label>
          Anthropic APIキー
          <input
            name="apiKey"
            type="password"
            required
            autoComplete="off"
            placeholder="sk-ant-…"
          />
        </label>
      );
    if (provider === "openai")
      return (
        <label>
          OpenAI APIキー
          <input
            name="apiKey"
            type="password"
            required
            autoComplete="off"
            placeholder="sk-…"
          />
        </label>
      );
    if (provider === "notion")
      return (
        <label>
          Notion Integration Token
          <input
            name="token"
            type="password"
            required
            autoComplete="off"
            placeholder="ntn_…"
          />
        </label>
      );
    if (provider === "pagespeed")
      return (
        <>
          <label>
            計測するサイトURL
            <input
              name="siteUrl"
              type="url"
              required
              defaultValue={configText(config, "siteUrl")}
              placeholder="https://example.com"
            />
          </label>
          <label>
            PageSpeed APIキー（任意）
            <input name="apiKey" type="password" autoComplete="off" />
          </label>
        </>
      );
    return null;
  };
  const targetLabels: Record<string, string> = {
    gsc: "利用するSearch Consoleサイト",
    ga4: "利用するGA4プロパティ",
    drive: "利用するGoogle Drive",
    youtube: "利用するYouTubeチャンネル",
  };
  return (
    <>
      <div className="heading">
        <div>
          <h2>実連携設定</h2>
          <p>
            サイト上で認証し、実際に通信できた連携だけ「接続済み」と表示します。秘密情報は暗号化して保存します。
          </p>
        </div>
      </div>
      <section className="integration-grid">
        {integrations.map((item) => {
          const isOpen = expanded === item.provider,
            isConnected = item.status === "CONFIGURED",
            hasError = item.status === "CONNECTION_ERROR",
            isWorking =
              working === item.provider ||
              (google.has(item.provider) && working === "google"),
            statusLabel = isConnected
              ? "接続済み"
              : hasError
                ? "接続エラー"
                : item.status === "PENDING_SECRET"
                  ? "認証待ち"
                  : "未設定",
            resources = googleResources(item.public_config),
            selectedId = configText(item.public_config, "selectedResourceId");
          return (
            <article
              className={`integration-card ${isOpen ? "is-open" : ""}`}
              key={item.provider}
            >
              <div className="integration-card-head">
                <i>{icon[item.provider] || item.name.slice(0, 1)}</i>
                <div>
                  <h3>{item.name}</h3>
                  <p>{item.purpose}</p>
                </div>
              </div>
              <span
                className={`integration-status ${isConnected ? "connected" : hasError ? "error" : "pending"}`}
              >
                {statusLabel}
              </span>
              {isConnected && google.has(item.provider) && (
                <p
                  className={`integration-target ${selectedId ? "selected" : ""}`}
                >
                  {selectedId
                    ? `利用対象: ${configText(item.public_config, "selectedResourceLabel")}`
                    : "利用対象を選択してください"}
                </p>
              )}
              <button
                type="button"
                className="integration-toggle"
                aria-expanded={isOpen}
                onClick={() => setExpanded(isOpen ? null : item.provider)}
              >
                {isOpen
                  ? "設定を閉じる"
                  : isConnected
                    ? "接続先を確認・変更"
                    : "接続設定を開く"}
              </button>
              <p className="integration-checked">
                最終認証確認:
                <br />
                {item.checked_at
                  ? new Date(item.checked_at).toLocaleString("ja-JP")
                  : "未実施"}
              </p>
              {isOpen && item.provider === "ubersuggest" && (
                <form
                  className="integration-form"
                  onSubmit={(event) => connect(event, "ubersuggest")}
                >
                  <div className="official-connector">
                    <b>Ubersuggest公式MCP</b>
                    <span>
                      公式OAuth画面でログインし、SERP・キーワード・競合・被リンクツールを認可します。
                    </span>
                  </div>
                  <button className="primary" disabled={isWorking}>
                    {isWorking ? "認証画面を準備中…" : "Ubersuggest MCPに接続"}
                  </button>
                </form>
              )}
              {isOpen && google.has(item.provider) && isConnected && (
                <form
                  className="integration-form resource-form"
                  onSubmit={(event) => selectResource(event, item.provider)}
                >
                  <label>
                    {targetLabels[item.provider]}
                    <select
                      name="resourceId"
                      required
                      defaultValue={selectedId}
                    >
                      <option value="" disabled>
                        選択してください（{resources.length}件）
                      </option>
                      {resources.map((resource) => (
                        <option key={resource.id} value={resource.id}>
                          {resource.label}
                          {resource.detail ? ` — ${resource.detail}` : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                  <p className="field-help">
                    ここで選んだ対象を分析・レポート・記事制作に使用します。
                  </p>
                  <button
                    className="primary"
                    disabled={isWorking || !resources.length}
                  >
                    {isWorking ? "保存中…" : "利用対象を保存"}
                  </button>
                </form>
              )}
              {isOpen && google.has(item.provider) && (
                <form
                  className="integration-form reconnect-form"
                  onSubmit={(event) => connect(event, "google")}
                >
                  <h4>
                    {isConnected
                      ? "Googleアカウントを再接続"
                      : "Googleアカウントを接続"}
                  </h4>
                  <label>
                    Google OAuth Client ID
                    <input
                      name="client_id"
                      autoComplete="off"
                      placeholder="Worker側に設定済みなら空欄でOK"
                    />
                  </label>
                  <label>
                    Google OAuth Client Secret
                    <input
                      name="client_secret"
                      type="password"
                      autoComplete="off"
                      placeholder="Worker側に設定済みなら空欄でOK"
                    />
                  </label>
                  <p className="field-help">
                    Cloudflareに設定済みの場合は、上の2項目は空欄で進められます。
                    <br />
                    コールバックURL:{" "}
                    <code>
                      {typeof window === "undefined"
                        ? ""
                        : `${window.location.origin}/api/oauth/google/callback`}
                    </code>
                  </p>
                  <button className="secondary" disabled={isWorking}>
                    {isWorking
                      ? "認証画面を準備中…"
                      : isConnected
                        ? "再接続して一覧を更新"
                        : "Googleアカウントで4サービスを接続"}
                  </button>
                </form>
              )}
              {isOpen &&
                !google.has(item.provider) &&
                item.provider !== "ubersuggest" && (
                  <form
                    className="integration-form"
                    onSubmit={(event) => check(event, item.provider)}
                  >
                    {staticFields(item.provider, item.public_config)}
                    <button className="primary" disabled={isWorking}>
                      {isWorking ? "実通信を確認中…" : "保存して接続テスト"}
                    </button>
                  </form>
                )}
              {isOpen && isConnected && (
                <button
                  type="button"
                  className="disconnect-button"
                  disabled={isWorking}
                  onClick={() => disconnect(item.provider)}
                >
                  連携を解除
                </button>
              )}
            </article>
          );
        })}
      </section>
      <section className="panel">
        <h3>接続方法</h3>
        <p>
          WordPress・Claude・OpenAI・Notion・PageSpeedは各カード内で設定できます。Ubersuggest
          MCPとGoogle系サービスは公式OAuth画面へ移動して認証します。
        </p>
        <p className="field-help">
          APIキー、パスワード、OAuthトークンはレスポンスや画面へ再表示せず、AES-GCMで暗号化して専用D1へ保存します。
        </p>
      </section>
    </>
  );
}
