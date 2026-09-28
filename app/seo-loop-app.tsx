"use client";

import { ChangeEvent, FormEvent, useCallback, useEffect, useRef, useState } from "react";
import {
  articleBodyHtml,
  buildAnalysisSteps,
  buildFeaturedImageStep,
  buildMaterialStep,
  formatTime,
  IMAGES_PER_ARTICLE,
  parseClaudeArticle,
  parseSectionRewrite,
  parseSeeds,
  plainText,
  sectionFrameTimes,
  timestampSeconds,
  validateMaterial,
  type Attachment,
  type JobStep,
  type ParsedArticle,
  type ProductionMaterial,
} from "../lib/browser-pipeline";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type Article = {
  id: string;
  title: string;
  title_tag?: string;
  slug?: string;
  main_keyword: string;
  related_keywords?: string[];
  search_intent?: string;
  reader?: string;
  catch_copy?: string;
  meta_description?: string;
  category_id?: string;
  category_name?: string;
  body_html?: string;
  featured_image_url?: string;
  section_images_json?: string;
  image_suggestions_json?: string;
  challenger_image_key?: string;
  challenger_name?: string;
  challenger_company?: string;
  challenger_role?: string;
  youtube_url?: string;
  youtube_title?: string;
  conversation_url?: string;
  status: string;
  wordpress_status: string;
  wordpress_post_id?: string | null;
  wordpress_edit_url?: string;
  wordpress_preview_url?: string;
  wordpress_public_preview_url?: string;
  updated_at: string;
};
type ArticleImage = { id: string; kind: "featured" | "section"; section_heading?: string; section_index?: number; alt_text?: string; prompt?: string; url: string };
type WordPressState = { connected: boolean; siteUrl: string; authMode: string };
type Category = { id: number; label: string; count: number };
type JobSummary = {
  id: string; provider: "claude" | "gpt"; state: string; error: string; url: string; step: number; total: number;
  results: Array<null | { chars: number; imageCount: number }>; attachWarning?: string;
};
type Research = { seeds: string[]; markdown: string; statuses: Array<{ source: string; ok: boolean; detail: string }> };
type DataConnection = { provider: string; status: string; checkedAt: string | null; selectedId: string; selectedLabel: string; lastError: string; resources: Array<{ id: string; label: string }> };
type Progress = { label: string; percent: number; detail: string; status: "running" | "completed" | "failed" } | null;
type Pipeline = {
  id: string;
  material: ProductionMaterial;
  referenceKey: string;
  research?: Research;
  parsed?: ParsedArticle[];
  articleIds?: string[];
  uploaded: Record<string, number[]>;
  skippedImages: number[];
  wordpress: Record<string, { publicPreviewUrl: string; editUrl: string; warning?: string }>;
  phase: "running" | "attention" | "done";
  warnings?: string[];
  error?: string;
  attentionJob?: string;
  startedAt: string;
};

const EXTENSION_VERSION = "0.4.0"; // minimum supported
const LATEST_EXTENSION = "0.4.0";
const PIPELINE_KEY = "video-studio-pipeline-v2";
const FORM_KEY = "video-studio-form-v2";
const REPORT_KEY = "video-studio-report-v2";
const nav = [
  ["dashboard", "⌂", "ダッシュボード"],
  ["studio", "✦", "動画一次情報記事制作"],
  ["library", "▣", "記事ライブラリー"],
  ["aio", "◌", "LLMO / AIO 分析"],
  ["reports", "◫", "レポート・PDCA"],
  ["connections", "⌁", "連携設定"],
] as const;
type Page = (typeof nav)[number][0];

// ---------------------------------------------------------------------------
// Helpers: storage, server API, Chrome extension bridge
// ---------------------------------------------------------------------------
const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));
const errorText = (error: unknown) => (error instanceof Error ? error.message : "処理できませんでした。");
function readJson<T>(key: string, fallback: T): T {
  try { const raw = localStorage.getItem(key); return raw ? (JSON.parse(raw) as T) : fallback; } catch { return fallback; }
}
function writeJson(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full or blocked: the flow continues in memory */ }
}

async function api<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const init: RequestInit = { method, headers: {} };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) { init.body = JSON.stringify(body); init.headers = { "Content-Type": "application/json" }; }
  let response: Response;
  try { response = await fetch(`/api/${path}`, init); }
  catch { throw new Error("サーバーへ接続できません。ネットワークを確認してください。"); }
  const data = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new Error(data.error || `サーバーエラー（${response.status}）`);
  return data as T;
}

function bridge<T>(command: string, payload?: unknown, timeout = 150000): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const timer = window.setTimeout(() => {
      window.removeEventListener("message", receive);
      reject(new Error("PC連携（Chrome拡張）が応答しません。拡張機能を有効にして、この画面を再読み込みしてください。"));
    }, timeout);
    function receive(event: MessageEvent) {
      if (event.source !== window || event.origin !== location.origin || event.data?.channel !== "video-studio-response" || event.data.id !== id) return;
      window.clearTimeout(timer);
      window.removeEventListener("message", receive);
      if (event.data.error) reject(new Error(event.data.error)); else resolve(event.data.value as T);
    }
    window.addEventListener("message", receive);
    window.postMessage({ channel: "video-studio-request", id, command, payload }, location.origin);
  });
}
const versionAtLeast = (value: string, minimum: string) => {
  const a = value.split(".").map(Number), b = minimum.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  return true;
};
async function ensureExtension() {
  let version = "";
  try { version = (await bridge<{ version: string }>("PING", undefined, 5000)).version; }
  catch { throw new Error("Chrome拡張「動画一次情報制作・PCブラウザー連携」が見つかりません。連携設定からダウンロードして導入し、この画面を再読み込みしてください。"); }
  if (!versionAtLeast(version, EXTENSION_VERSION))
    throw new Error(`Chrome拡張が古い版（${version}）です。連携設定から最新版（${EXTENSION_VERSION}）をダウンロードし、chrome://extensions で入れ替えてから画面を再読み込みしてください。`);
  return version;
}

class JobAttention extends Error {
  constructor(public job: JobSummary) { super(job.error || "専用タブで確認が必要です。"); }
}
// Starts (idempotently) and follows a multi-step job until every step has a settled answer.
async function runJob(
  spec: { id: string; provider: "claude" | "gpt"; purpose: string; steps: JobStep[]; startUrl?: string },
  onUpdate?: (job: JobSummary) => Promise<void> | void,
) {
  let job = await bridge<JobSummary>("RUN", spec);
  let failures = 0;
  for (;;) {
    if (job.state === "review") { await onUpdate?.(job); return job; }
    if (job.state === "attention") throw new JobAttention(job);
    if (job.state === "cancelled") throw new Error("処理を中止しました。");
    await sleep(4000);
    try { job = await bridge<JobSummary>("STATUS", { id: spec.id }); failures = 0; }
    catch (error) { if (++failures >= 4) throw error; continue; }
    await onUpdate?.(job);
  }
}

async function imageAttachment(url: string, name: string, maxSide = 1600): Promise<Attachment | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const bitmap = await createImageBitmap(await response.blob());
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return { name, dataUrl: canvas.toDataURL("image/jpeg", 0.9) };
  } catch { return null; }
}
function youtubeId(url = "") {
  try {
    const u = new URL(url);
    if (u.hostname === "youtu.be") return u.pathname.slice(1, 20);
    return u.searchParams.get("v") || u.pathname.match(/^\/(?:shorts|embed|live)\/([^/?]+)/)?.[1] || "";
  } catch { return ""; }
}
type CapturedFrame = { ok: boolean; dataUrl?: string; seconds: number; source?: string; size?: string; reason?: string };
// Real video frames chosen by the extension: faces checked locally (eyes open, not in profile,
// whole head inside), the sharpest good frame cropped to 16:9 between the burned-in captions.
// When no good frame is found near a time, it searches further away; `ok: false` means none passed.
async function captureFrames(videoUrl: string, times: number[], taken: number[] = []) {
  const videoId = youtubeId(videoUrl);
  if (!videoId) throw new Error("YouTube動画URLを確認してください。");
  const frames: CapturedFrame[] = [], used = [...taken];
  for (const time of times) {
    const result = await bridge<{ frames: CapturedFrame[] }>("FRAMES", { videoId, times: [time], taken: used }, 900000);
    const frame = result.frames[0] || { ok: false, seconds: time, reason: "場面を取得できませんでした。" };
    if (frame.ok) used.push(frame.seconds);
    frames.push(frame);
  }
  return frames;
}
const stripFigures = (html = "") => html.replace(/<figure class="(?:video-scene|youtube-video-link)"[\s\S]*?<\/figure>/g, "");
// Permanent share link: the server issues a fresh (48h) WordPress preview URL on every visit.
const permanentPreviewUrl = (articleId: string) => `${typeof window === "undefined" ? "" : window.location.origin}/api/preview/${articleId}`;
const isFrame = (heading: string) => /^(はじめに|まとめ|おわりに)/.test(heading);

// ---------------------------------------------------------------------------
// The production pipeline: Claude (articles) → ChatGPT (images) → WordPress drafts
// ---------------------------------------------------------------------------
type Reporter = (percent: number, detail: string) => void;
async function runPipeline(pipeline: Pipeline, report: Reporter, wordpressConnected: boolean) {
  const save = () => writeJson(PIPELINE_KEY, pipeline);
  const m = pipeline.material, count = m.article_limit;
  const totalUnits = 3 + count + count * IMAGES_PER_ARTICLE + count;
  const materialJob = `${pipeline.id}-claude`, writingJob = `${pipeline.id}-claude-2`;
  await ensureExtension();

  if (!pipeline.articleIds) {
    // 1. Claude reads the whole transcript, lists every topic and proposes seed keywords.
    report(1, "Claudeが文字起こしを読み、全ての話題とキーワード候補を整理しています");
    const first = await runJob({ id: materialJob, provider: "claude", purpose: "production", steps: [buildMaterialStep(m)] });
    // 2. Real search data from the APIs (Search Console, GA4, Ubersuggest).
    if (!pipeline.research) {
      report((1 / totalUnits) * 100, "Search Console・GA4・UbersuggestからAPIで実測データを取得しています");
      const seeds = parseSeeds((await bridge<{ text: string }>("RESULT", { id: materialJob, step: 0 })).text);
      pipeline.research = await api<Research>("seo/research", "POST", { seeds: seeds.length ? seeds : [m.challenger_name] });
      save();
    }
    // 3. Same conversation: Claude analyses the data, selects keywords and writes each article.
    const job = await runJob(
      { id: writingJob, provider: "claude", purpose: "production", steps: buildAnalysisSteps(m, pipeline.research.markdown), startUrl: first.url },
      (current) => {
        const done = current.results.filter(Boolean).length;
        report(((2 + done) / totalUnits) * 100, done === 0 ? "Claudeが実測データを分析し、キーワードと記事企画を決めています" : `Claudeで記事を作成中（${Math.min(done, count)}/${count}本目）`);
      },
    );
    report(((3 + count) / totalUnits) * 100, "Claudeの回答を記事データへ変換しています");
    const parsed: ParsedArticle[] = [];
    for (let index = 1; index <= count; index++) {
      const result = await bridge<{ html: string }>("RESULT", { id: writingJob, step: index });
      try { parsed.push(parseClaudeArticle(result.html)); }
      catch (error) { throw new Error(`${index}本目の記事: ${errorText(error)}（Claudeの専用会話: ${job.url}）`); }
    }
    const saved = await api<{ articleIds: string[] }>("browser/articles", "POST", {
      productionId: pipeline.id,
      material: { ...m, challenger_image_key: pipeline.referenceKey },
      articles: parsed.map((article) => ({ ...article, bodyHtml: articleBodyHtml(article), conversationUrl: job.url || first.url })),
    });
    pipeline.parsed = parsed;
    pipeline.articleIds = saved.articleIds;
    save();
  }

  const articleIds = pipeline.articleIds, parsed = pipeline.parsed || [];
  const unitsBeforeImages = 3 + count;
  const reference = pipeline.referenceKey ? await imageAttachment(`/api/references/${pipeline.referenceKey}`, "challenger-reference.jpg") : null;
  const imagesDone = () => articleIds.reduce((sum, id) => sum + (pipeline.uploaded[id]?.length || 0), 0);
  for (let index = 0; index < articleIds.length; index++) {
    const articleId = articleIds[index], article = parsed[index];
    if (!article || pipeline.skippedImages.includes(index)) continue;
    const uploaded = (pipeline.uploaded[articleId] ||= []);
    const contentSections = article.sections.filter((section) => !isFrame(section.heading)).slice(0, IMAGES_PER_ARTICLE - 1);
    // H2 images (steps 1..4): real frames cut from the YouTube video, no AI.
    const missing = contentSections.map((_, i) => i).filter((i) => !uploaded.includes(i + 1));
    let scene: Attachment | null = null;
    if (missing.length) {
      report(((unitsBeforeImages + imagesDone()) / totalUnits) * 100, `${index + 1}本目のH2画像を、動画の実際の場面から切り出しています（${missing.length}枚）`);
      const times = sectionFrameTimes(contentSections);
      const frames = await captureFrames(m.youtube_url, missing.map((i) => times[i] ?? -1));
      for (let k = 0; k < missing.length; k++) {
        const i = missing[k], section = contentSections[i], frame = frames[k];
        if (!frame.ok || !frame.dataUrl) {
          pipeline.warnings = [...(pipeline.warnings || []), `${index + 1}本目「${section.heading}」: ${frame.reason || "良い場面が見つかりませんでした"}（記事ライブラリーで時刻を指定して切り出せます）`];
          continue;
        }
        await api(`articles/${articleId}/images`, "POST", {
          kind: "section", sectionIndex: i, heading: section.heading,
          alt: `${section.heading}｜${m.challenger_name}さんの対談シーン`,
          prompt: `動画 ${formatTime(frame.seconds)} の実際の場面`, dataUrl: frame.dataUrl,
        });
        uploaded.push(i + 1);
        save();
      }
      const firstGood = frames.find((frame) => frame.ok && frame.dataUrl);
      scene = firstGood?.dataUrl ? { name: "video-scene.jpg", dataUrl: firstGood.dataUrl } : null;
      // Frames that failed stay missing; they are not retried automatically on resume.
      missing.forEach((i, k) => { if (!frames[k].ok) uploaded.push(i + 1); });
      save();
    }
    // Eyecatch (step 0): designed by ChatGPT from the real scene and the reference portrait.
    if (!uploaded.includes(0)) {
      report(((unitsBeforeImages + imagesDone()) / totalUnits) * 100, `ChatGPTで${index + 1}本目のアイキャッチを作成しています`);
      scene ||= await imageAttachment(`/api/youtube/frame/${youtubeId(m.youtube_url)}/maxresdefault.jpg`, "video-scene.jpg", 1600);
      const jobId = `${pipeline.id}-feat-${index}`;
      await runJob({ id: jobId, provider: "gpt", purpose: "images", steps: [buildFeaturedImageStep(article, m, reference, scene, index + 1)] });
      const image = await bridge<{ dataUrl: string }>("IMAGE", { id: jobId, step: 0 });
      await api(`articles/${articleId}/images`, "POST", { kind: "featured", sectionIndex: -1, heading: "", alt: `${article.title}｜A TRUTH STORY`, prompt: article.featuredImagePrompt, dataUrl: image.dataUrl });
      uploaded.push(0);
      save();
    }
    report(((unitsBeforeImages + imagesDone()) / totalUnits) * 100, `${index + 1}本目の画像${IMAGES_PER_ARTICLE}枚を保存しました`);
  }

  if (wordpressConnected) {
    for (let index = 0; index < articleIds.length; index++) {
      const articleId = articleIds[index];
      if (pipeline.wordpress[articleId]) continue;
      report(((unitsBeforeImages + count * IMAGES_PER_ARTICLE + index) / totalUnits) * 100, `WordPressへ${index + 1}本目を下書き保存し、外部確認URLを発行しています`);
      const result = await api<{ wordpress: { publicPreviewUrl: string; editUrl: string; warning: string } }>(`articles/${articleId}/wordpress`, "POST", {});
      pipeline.wordpress[articleId] = { publicPreviewUrl: result.wordpress.publicPreviewUrl, editUrl: result.wordpress.editUrl, warning: result.wordpress.warning };
      save();
    }
  }
  pipeline.phase = "done";
  pipeline.error = "";
  save();
}

// ---------------------------------------------------------------------------
// Progress bar
// ---------------------------------------------------------------------------
function ProgressBar({ progress }: { progress: Progress }) {
  if (!progress) return null;
  return (
    <section className={`generation-progress ${progress.status}`} aria-live="polite">
      <div className="generation-progress-head">
        <div><b>{progress.label}</b><span>{progress.detail}</span></div>
        <strong>{Math.round(progress.percent)}%</strong>
      </div>
      <div className="generation-progress-track" role="progressbar" aria-label={`${progress.label}の進捗`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress.percent)}>
        <i style={{ width: `${progress.percent}%` }} />
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// App shell
// ---------------------------------------------------------------------------
export function SeoLoopApp() {
  const [page, setPage] = useState<Page>("dashboard");
  const [articles, setArticles] = useState<Article[]>([]);
  const [wordpress, setWordpress] = useState<WordPressState>({ connected: false, siteUrl: "", authMode: "" });
  const [notice, setNotice] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [pipeline, setPipeline] = useState<Pipeline | null>(null);
  const [progress, setProgress] = useState<Progress>(null);
  const running = useRef(false);
  const [executing, setExecuting] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api<{ articles: Article[]; wordpress: WordPressState }>("bootstrap");
      setArticles(data.articles);
      setWordpress(data.wordpress);
      return data.wordpress;
    } catch (error) {
      setNotice(errorText(error));
      return null;
    } finally {
      setLoaded(true);
    }
  }, []);

  const execute = useCallback(async (current: Pipeline, wp: WordPressState | null) => {
    if (running.current) return;
    running.current = true;
    setExecuting(true);
    setNotice("");
    const label = `${current.material.article_limit}本の記事・画像${current.material.article_limit * IMAGES_PER_ARTICLE}枚・WordPress下書きを制作`;
    setProgress({ label, percent: 1, detail: "Chrome拡張とClaudeの専用タブを準備しています", status: "running" });
    try {
      await runPipeline(current, (percent, detail) => setProgress({ label, percent: Math.max(1, Math.min(99, percent)), detail, status: "running" }), Boolean(wp?.connected));
      setPipeline({ ...current });
      await load();
      const urls = Object.values(current.wordpress).filter((item) => item.publicPreviewUrl).length;
      const detail = wp?.connected
        ? `完了：記事${current.articleIds?.length}本・画像・WordPress下書き（外部確認URL ${urls}件）を作成しました`
        : `完了：記事${current.articleIds?.length}本と画像を作成しました（WordPress未接続のため下書き保存はしていません）`;
      setProgress({ label, percent: 100, detail, status: "completed" });
      setNotice(`${detail}。記事ライブラリーで確認できます。${current.warnings?.length ? ` 画像の注意: ${current.warnings.join(" ／ ")}` : ""}`);
    } catch (error) {
      const message = errorText(error);
      current.phase = "attention";
      current.error = message;
      current.attentionJob = error instanceof JobAttention ? error.job.id : "";
      writeJson(PIPELINE_KEY, current);
      setPipeline({ ...current });
      setProgress((previous) => ({ label, percent: previous?.percent || 1, detail: message, status: "failed" }));
      setNotice(message);
    } finally {
      running.current = false;
      setExecuting(false);
    }
  }, [load]);

  useEffect(() => {
    const timer = window.setTimeout(async () => {
      const params = new URLSearchParams(window.location.search);
      if (params.get("page") === "connections") setPage("connections");
      const connection = params.get("connection");
      if (connection) {
        const labels: Record<string, string> = { connected: "接続が完了しました。", denied: "認証がキャンセルされました。", session_expired: "認証の有効時間が切れました。もう一度お試しください。", failed: "接続に失敗しました。もう一度お試しください。" };
        setNotice(`${params.get("provider") === "google" ? "Google（Search Console・GA4）" : "Ubersuggest"}: ${labels[connection] || connection}`);
        window.history.replaceState({}, "", window.location.pathname);
      }
      const wp = await load();
      const saved = readJson<Pipeline | null>(PIPELINE_KEY, null);
      if (saved && saved.phase !== "done") {
        setPipeline(saved);
        setPage("studio");
        // A production interrupted by a reload resumes from its last saved checkpoint.
        if (saved.phase === "running") void execute(saved, wp);
        else setNotice(saved.error || "前回の制作が途中で止まっています。「制作を再開」で続きから実行できます。");
      } else if (saved) setPipeline(saved);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load, execute]);

  const start = async (material: ProductionMaterial, referenceKey: string) => {
    const next: Pipeline = { id: crypto.randomUUID(), material, referenceKey, uploaded: {}, skippedImages: [], wordpress: {}, phase: "running", startedAt: new Date().toISOString() };
    writeJson(PIPELINE_KEY, next);
    setPipeline(next);
    await execute(next, wordpress);
  };
  const resume = async (mode: "retry" | "skip-images") => {
    if (!pipeline) return;
    const current = { ...pipeline };
    try {
      await ensureExtension();
      if (current.attentionJob) {
        if (mode === "skip-images" && /-img-(\d+)$/.test(current.attentionJob)) {
          current.skippedImages = [...current.skippedImages, Number(current.attentionJob.match(/-img-(\d+)$/)?.[1])];
          await bridge("CANCEL", { id: current.attentionJob }).catch(() => undefined);
        } else await bridge("RETRY", { id: current.attentionJob });
      }
    } catch (error) { setNotice(errorText(error)); return; }
    current.phase = "running";
    current.error = "";
    current.attentionJob = "";
    writeJson(PIPELINE_KEY, current);
    setPipeline(current);
    await execute(current, wordpress);
  };
  const discard = () => {
    if (pipeline?.attentionJob) void bridge("CANCEL", { id: pipeline.attentionJob }).catch(() => undefined);
    const done = pipeline ? { ...pipeline, phase: "done" as const } : null;
    writeJson(PIPELINE_KEY, done);
    setPipeline(done);
    setProgress(null);
    setNotice("途中の制作を終了しました。保存済みの記事は記事ライブラリーに残っています。");
    void load();
  };

  const busy = executing || pipeline?.phase === "running";
  return (
    <div className="app">
      <aside className="side">
        <div className="brand"><i>▶</i><span>SEO<br />LOOP</span></div>
        <small>VIDEO SEO WORKSPACE</small>
        <nav className="nav">
          {nav.map(([key, icon, label]) => (
            <button key={key} className={page === key ? "active" : ""} onClick={() => setPage(key)}>{icon} {label}</button>
          ))}
        </nav>
        <div className="engine"><i />PC BROWSER MODE<br /><span>Claude・ChatGPTの画面で制作<br />WordPressは下書き保存のみ</span></div>
      </aside>
      <main className="main">
        <header className="top">
          <div>
            <div className="eyebrow">VIDEO PRIMARY INFORMATION × SEO LOOP</div>
            <h1>{nav.find((item) => item[0] === page)?.[2]}</h1>
          </div>
          <div className="client-picker">記事 {articles.length} 本・WordPress {wordpress.connected ? "接続済み" : "未接続"}</div>
        </header>
        <div className="content">
          <ProgressBar progress={progress} />
          {notice && <div className="alerts"><div className="alert"><b>処理状況</b><span>{notice}</span><button type="button" className="text-button" onClick={() => setNotice("")}>閉じる</button></div></div>}
          {pipeline?.phase === "attention" && (
            <section className="panel pipeline-attention">
              <h3>制作が途中で止まっています</h3>
              <p>{pipeline.error}</p>
              <p className="field-help">Claude・ChatGPTの専用タブ（別ウィンドウ）で、ログイン・利用上限・エラー表示を確認してから再開してください。完了済みの工程はやり直しません。</p>
              <div className="button-row">
                <button className="primary" disabled={busy} onClick={() => void resume("retry")}>制作を再開</button>
                {/-img-\d+$/.test(pipeline.attentionJob || "") && <button className="secondary" disabled={busy} onClick={() => void resume("skip-images")}>この記事の画像を飛ばして続行</button>}
                <button className="text-button" disabled={busy} onClick={discard}>この制作を終了</button>
              </div>
            </section>
          )}
          {page === "dashboard" && <DashboardPage articles={articles} wordpress={wordpress} go={setPage} />}
          {page === "studio" && <Studio busy={Boolean(busy)} loaded={loaded} wordpress={wordpress} start={start} setNotice={setNotice} articles={articles} refresh={load} pipeline={pipeline} />}
          {page === "library" && <Library articles={articles} refresh={load} setNotice={setNotice} setProgress={setProgress} wordpress={wordpress} />}
          {page === "aio" && <AioPage articles={articles} />}
          {page === "reports" && <Reports setNotice={setNotice} setProgress={setProgress} />}
          {page === "connections" && <Connections wordpress={wordpress} refresh={load} setNotice={setNotice} />}
        </div>
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------
function Kpi({ label, value, hint }: { label: string; value?: number; hint: string }) {
  return <article className="kpi"><span>{label}</span><b>{value ?? "—"}</b><small>{hint}</small></article>;
}
function DashboardPage({ articles, wordpress, go }: { articles: Article[]; wordpress: WordPressState; go: (page: Page) => void }) {
  const drafts = articles.filter((item) => item.wordpress_status === "DRAFT").length;
  const previews = articles.filter((item) => item.wordpress_post_id).length;
  return (
    <>
      <div className="heading">
        <div><h2>SEO運用の状況</h2><p>動画の一次情報から、PCのClaude・ChatGPTで記事と画像を作り、WordPressへ下書き保存します。</p></div>
        <button className="primary" onClick={() => go("studio")}>動画を登録</button>
      </div>
      <section className="kpis">
        <Kpi label="記事ライブラリー" value={articles.length} hint="作成済みの記事" />
        <Kpi label="WordPress下書き" value={drafts} hint={wordpress.connected ? wordpress.siteUrl : "WordPress未接続"} />
        <Kpi label="外部確認URL" value={previews} hint="ログイン不要で確認できる記事" />
        <Kpi label="未入稿" value={articles.length - drafts} hint="ライブラリーから下書き保存" />
      </section>
      <section className="panel">
        <h3>制作の流れ</h3>
        <ol>
          <li>「連携設定」でChrome拡張（最新版 {LATEST_EXTENSION}）を導入し、Claude・ChatGPTにログイン</li>
          <li>「動画一次情報記事制作」で動画URL・出演者・文字起こしを入力し「記事を作成する」</li>
          <li>Search Console・GA4・Ubersuggestの実測データ（API取得）をClaudeが分析してキーワードを選定し、文字起こしを網羅した記事を執筆</li>
          <li>H2画像4枚は動画の実際の場面を4K/フルHDで切り出し、アイキャッチはChatGPTで作成（Claude・ChatGPTはAPIではなくログイン中の画面を使用）</li>
          <li>WordPressへ自動で下書き保存し、外部確認URL（ログイン不要のプレビュー）を発行</li>
        </ol>
        <div className="button-row">
          <button className="secondary" onClick={() => go("connections")}>連携設定を開く</button>
          <button className="secondary" onClick={() => go("library")}>記事ライブラリーを見る</button>
        </div>
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------
// Studio (production form)
// ---------------------------------------------------------------------------
type FormState = Omit<ProductionMaterial, "article_limit"> & { article_limit: string; reference_key: string };
const emptyForm: FormState = {
  youtube_url: "", youtube_title: "", youtube_description: "", youtube_chapters: "", transcript: "", direction: "",
  challenger_company: "", challenger_role: "", challenger_name: "", special_guest: "", mc_name: "",
  article_limit: "3", category_id: "", category_name: "", reference_key: "",
};
function initialForm(): FormState {
  const saved = readJson<Partial<FormState> | null>(FORM_KEY, null);
  if (saved) {
    const { use_sources: _unused, ...rest } = saved as Partial<FormState> & { use_sources?: boolean };
    void _unused;
    return { ...emptyForm, ...rest };
  }
  // One-time carry-over from the previous browser-mode version.
  const legacy = readJson<{ material?: Record<string, string> }>("video-studio-browser-v1", {}).material || {};
  return {
    ...emptyForm,
    youtube_url: legacy.url || "", youtube_title: legacy.title || "", transcript: legacy.transcript || "", direction: legacy.direction || "",
    youtube_description: legacy.youtube_description || "", youtube_chapters: legacy.youtube_chapters || "",
    challenger_company: legacy.challenger_company || "", challenger_role: legacy.challenger_role || "", challenger_name: legacy.challenger_name || "",
    special_guest: legacy.special_guest || "", mc_name: legacy.mc_name || "", article_limit: /^[1-5]$/.test(legacy.count || "") ? legacy.count : "3",
  };
}

function Studio({ busy, loaded, wordpress, start, setNotice, articles, refresh, pipeline }: {
  busy: boolean; loaded: boolean; wordpress: WordPressState; start: (material: ProductionMaterial, referenceKey: string) => Promise<void>;
  setNotice: (message: string) => void; articles: Article[]; refresh: () => Promise<unknown>; pipeline: Pipeline | null;
}) {
  const [form, setForm] = useState<FormState>(emptyForm);
  const [ready, setReady] = useState(false);
  const [categories, setCategories] = useState<Category[]>([]);
  const [categoryState, setCategoryState] = useState("");
  const [loadingVideo, setLoadingVideo] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => { setForm(initialForm()); setReady(true); }, 0);
    return () => window.clearTimeout(timer);
  }, []);
  useEffect(() => { if (ready) writeJson(FORM_KEY, form); }, [form, ready]);
  useEffect(() => {
    if (!wordpress.connected) return;
    let active = true;
    const timer = window.setTimeout(() => {
      setCategoryState("カテゴリーを取得中…");
      api<{ categories: Category[]; warning?: string }>("wordpress/categories")
        .then((result) => { if (!active) return; setCategories(result.categories); setCategoryState(result.warning || (result.categories.length ? "" : "カテゴリーを取得できませんでした")); })
        .catch((error) => active && setCategoryState(errorText(error)));
    }, 0);
    return () => { active = false; window.clearTimeout(timer); };
  }, [wordpress.connected]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((current) => ({ ...current, [key]: value }));
  const field = (key: keyof FormState) => ({ value: String(form[key] ?? ""), onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => set(key, event.currentTarget.value as never) });

  const loadVideo = async (url: string) => {
    if (!youtubeId(url)) return;
    setLoadingVideo(true);
    try {
      const { metadata } = await api<{ metadata: { title: string; description: string; chapters: string } }>(`youtube/metadata?url=${encodeURIComponent(url)}`);
      setForm((current) => ({
        ...current,
        youtube_title: current.youtube_title || metadata.title,
        youtube_description: current.youtube_description || metadata.description,
        youtube_chapters: current.youtube_chapters || metadata.chapters,
      }));
      if (!metadata.title) setNotice("YouTubeから情報を取得できませんでした。タイトルと概要を手入力してください。");
    } catch (error) {
      setNotice(`YouTube情報を自動取得できませんでした（${errorText(error)}）。手入力で続行できます。`);
    } finally { setLoadingVideo(false); }
  };
  const uploadReference = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget, file = input.files?.[0];
    if (!file) return;
    if (!/^image\/(?:jpeg|png|webp)$/i.test(file.type) || file.size > 12 * 1024 * 1024) { setNotice("挑戦者画像は12MB以下のJPEG・PNG・WebPを選んでください。"); input.value = ""; return; }
    const data = new FormData();
    data.append("file", file);
    setUploading(true);
    try {
      const result = await api<{ reference: { objectKey: string }; notice: string }>("challenger-reference", "POST", data);
      set("reference_key", result.reference.objectKey);
      setNotice(result.notice);
    } catch (error) { setNotice(errorText(error)); input.value = ""; }
    finally { setUploading(false); }
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || submitting) return;
    setSubmitting(true);
    try {
      const category = categories.find((item) => String(item.id) === form.category_id);
      if (wordpress.connected && !category) throw new Error("WordPressの投稿カテゴリーを選択してください。");
      const material: ProductionMaterial = {
        ...form,
        article_limit: Math.min(5, Math.max(1, Number(form.article_limit) || 1)),
        category_name: category?.label || "",
      };
      validateMaterial(material);
      await ensureExtension();
      await start(material, form.reference_key);
    } catch (error) { setNotice(errorText(error)); }
    finally { setSubmitting(false); }
  };

  const disabled = !ready || busy || submitting || uploading;
  return (
    <>
      <div className="heading">
        <div>
          <h2>動画から一次情報記事を制作</h2>
          <p>「記事を作成する」を押すと、Claudeが文字起こしを読み込み → Search Console・GA4・Ubersuggestの実測データ（API取得）を分析してキーワードを決め → 記事を執筆 → ChatGPTが画像を作成 → WordPressへ下書き保存、まで自動で進みます。記事と画像の生成AIはAPIではなく、Chromeでログイン中のClaude・ChatGPTを使います。</p>
        </div>
      </div>
      <form className="panel form-grid" onSubmit={(event) => void submit(event)}>
        <label>
          YouTube動画URL
          <input name="youtube_url" type="url" required placeholder="https://www.youtube.com/watch?v=..." {...field("youtube_url")} onBlur={(event) => void loadVideo(event.currentTarget.value)} />
          <small className="field-help">{loadingVideo ? "YouTubeからタイトル・概要を取得中…" : "入力後、タイトル・概要・チャプターを自動で取得します（空欄の項目だけ埋めます）。"}</small>
        </label>
        <label>
          動画タイトル
          <input name="youtube_title" required {...field("youtube_title")} />
        </label>
        <label>
          制作する記事数
          <select name="article_limit" value={form.article_limit} onChange={(event) => set("article_limit", event.currentTarget.value)}>
            {[1, 2, 3, 4, 5].map((value) => <option key={value} value={value}>{value}本</option>)}
          </select>
          <small className="field-help">1回で最大5本（PART 1〜PART 5）。</small>
        </label>
        <label>
          画像数（1記事あたり）
          <input name="image_count" type="number" value="5" readOnly aria-readonly="true" />
          <small className="field-help">5枚固定です。1枚目は16:9のアイキャッチ（ChatGPTで作成）、残り4枚は各H2の内容を話している動画の実際の場面を切り出します。同じ画像や似た構図は使用しません。</small>
        </label>
        <label className="wide">
          記事の方向性
          <input name="direction" placeholder="例：経営者向けに、挑戦の意思決定を具体的に解説" {...field("direction")} />
        </label>
        <label>挑戦者の会社名<input name="challenger_company" placeholder="例：株式会社〇〇" {...field("challenger_company")} /></label>
        <label>挑戦者の役職<input name="challenger_role" placeholder="例：代表取締役" {...field("challenger_role")} /></label>
        <label>
          挑戦者の出演者名
          <input name="challenger_name" required placeholder="例：山田 太郎" {...field("challenger_name")} />
          <small className="field-help">記事では会社名・役職・出演者名を一組で表記します。</small>
        </label>
        <label className="wide challenger-reference-field">
          挑戦者本人の参照画像（任意・推奨）
          <input type="file" accept="image/jpeg,image/png,image/webp" disabled={uploading} onChange={(event) => void uploadReference(event)} />
          <small className="field-help">登録すると、ChatGPTへ画像を依頼するたびに自動で添付し、本人の顔を維持するよう指示します。</small>
          {uploading && <span className="reference-status">参照画像を保存しています…</span>}
          {form.reference_key && (
            <span className="challenger-reference-preview">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`/api/references/${form.reference_key}`} alt="登録した挑戦者本人の参照画像" />
              <b>挑戦者本人として登録済み</b>
              <button type="button" className="text-button" onClick={() => set("reference_key", "")}>解除</button>
            </span>
          )}
        </label>
        <label>スペシャルゲスト（任意）<input name="special_guest" placeholder="例：会社名・役職・氏名" {...field("special_guest")} /></label>
        <label>MC（任意）<input name="mc_name" placeholder="例：氏名" {...field("mc_name")} /></label>
        <label className="wide">
          動画概要（YouTubeから自動取得）
          <textarea name="youtube_description" rows={5} {...field("youtube_description")} />
        </label>
        <label className="wide">
          動画目次・チャプター（YouTubeから自動抽出）
          <textarea name="youtube_chapters" rows={4} placeholder="00:00 オープニング のような目次" {...field("youtube_chapters")} />
        </label>
        {wordpress.connected ? (
          <label className="wide">
            WordPress投稿カテゴリー
            <select name="wordpress_category_id" required value={form.category_id} onChange={(event) => set("category_id", event.currentTarget.value)}>
              <option value="">{categoryState || "投稿先カテゴリーを選択"}</option>
              {categories.map((category) => <option key={category.id} value={category.id}>{category.label}（{category.count}件）</option>)}
            </select>
            <small className="field-help">完成した記事はこのカテゴリーでWordPressに「下書き」保存し、外部確認URLを発行します（公開はしません）。</small>
          </label>
        ) : (
          <p className="field-help wide">{loaded ? "WordPressが未接続のため、記事と画像の作成までを行います。連携設定でWordPressを接続すると下書き保存と外部確認URLの発行まで自動化されます。" : "WordPressの接続状態を確認しています…"}</p>
        )}
        <label className="wide">
          文字起こし
          <textarea name="transcript" required minLength={80} rows={14} placeholder="YouTubeの文字起こしを貼り付けてください。タイムスタンプ付きのままで構いません。" {...field("transcript")} />
          <small className="field-help">{form.transcript.length.toLocaleString()}文字（Claudeへは先頭60,000文字まで渡します）</small>
        </label>
        <p className="field-help wide">
          キーワード選定には、Search Console・GA4・Ubersuggestの実測データをAPIで自動取得してClaudeに分析させます（各サービスの画面を開く必要はありません）。
        </p>
        <div className="button-row wide">
          <button className="primary production-button" disabled={disabled}>
            {busy ? "記事を制作中…" : submitting ? "準備中…" : "記事を作成する"}
          </button>
        </div>
        <p className="field-help wide">
          Claude・ChatGPTは別ウィンドウの専用タブで動きます。制作中はこの画面とChromeを開いたままにしてください。途中で閉じても、再度開くと続きから再開します。
        </p>
      </form>
      {pipeline?.research && (
        <section className="panel">
          <h3>直近の制作で使った実測データ（API取得）</h3>
          <ul className="preview-url-list">
            {pipeline.research.statuses.map((status) => <li key={status.source}><b>{status.ok ? "✓" : "!"} {status.source}</b><span>{status.detail}</span></li>)}
          </ul>
          <details><summary>Claudeに渡したデータを表示</summary><pre className="research-markdown">{pipeline.research.markdown}</pre></details>
        </section>
      )}
      {pipeline && pipeline.phase === "done" && Object.keys(pipeline.wordpress).length > 0 && (
        <section className="panel">
          <h3>直近の制作結果（WordPress下書き）</h3>
          <ul className="preview-url-list">
            {(pipeline.articleIds || []).map((id, index) => {
              const result = pipeline.wordpress[id];
              return (
                <li key={id}>
                  <b>{pipeline.parsed?.[index]?.title || `${index + 1}本目`}</b>
                  {result?.publicPreviewUrl ? <a className="wordpress-card-link" href={permanentPreviewUrl(id)} target="_blank" rel="noreferrer">{permanentPreviewUrl(id)}</a> : <span>{result?.warning || "下書きのみ（外部確認URLなし）"}</span>}
                </li>
              );
            })}
          </ul>
        </section>
      )}
      <section className="studio-generated">
        <div className="heading compact-heading">
          <div>
            <div className="eyebrow">GENERATED ARTICLES</div>
            <h2>生成済み記事</h2>
            <p>カードを押すと、本文・H2・画像・SEO情報を編集し、WordPress下書きへ反映できます。</p>
          </div>
        </div>
        <Library articles={articles.slice(0, 10)} refresh={refresh} setNotice={setNotice} wordpress={wordpress} embedded />
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------
// Library & article editor
// ---------------------------------------------------------------------------
type EditorSection = { id: string; heading: string; bodyHtml: string };
function splitArticleBody(html = "") {
  const matches = [...html.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi)];
  if (!matches.length) return { intro: "", sections: [{ id: "section-1", heading: "本文", bodyHtml: html || "<p>本文を入力してください。</p>" }] as EditorSection[] };
  return {
    intro: html.slice(0, matches[0].index || 0),
    sections: matches.map((match, index) => ({
      id: `section-${index + 1}`,
      heading: String(match[1] || "").replace(/<[^>]+>/g, "").trim() || `セクション${index + 1}`,
      bodyHtml: html.slice((match.index || 0) + match[0].length, matches[index + 1]?.index ?? html.length).trim(),
    })),
  };
}
const escapeEditorText = (value: string) => value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] || c);
const combineArticleBody = (intro: string, sections: EditorSection[]) => `${intro}${sections.map((section) => `<h2>${escapeEditorText(section.heading)}</h2>${section.bodyHtml}`).join("")}`;

function Library({ articles, refresh, setNotice, setProgress, wordpress, embedded = false }: {
  articles: Article[]; refresh: () => Promise<unknown>; setNotice: (message: string) => void;
  setProgress?: (progress: Progress) => void; wordpress: WordPressState; embedded?: boolean;
}) {
  const [openId, setOpenId] = useState("");
  return (
    <>
      {!embedded && (
        <div className="heading">
          <div><h2>記事ライブラリー</h2><p>本文・H2・画像・SEO情報を確認・編集し、WordPress下書きと外部確認URLを管理します。</p></div>
        </div>
      )}
      <div className={`article-library-list ${embedded ? "embedded" : ""}`}>
        {articles.map((item) => (
          <ArticleLibraryItem key={item.id} item={item} open={openId === item.id} toggle={() => setOpenId(openId === item.id ? "" : item.id)} refresh={refresh} setNotice={setNotice} setProgress={setProgress} wordpress={wordpress} />
        ))}
      </div>
      {!articles.length && <section className="panel empty-library">まだ記事はありません。「動画一次情報記事制作」から動画を登録してください。</section>}
    </>
  );
}

function ArticleLibraryItem({ item, open, toggle, refresh, setNotice, setProgress, wordpress }: {
  item: Article; open: boolean; toggle: () => void; refresh: () => Promise<unknown>; setNotice: (message: string) => void;
  setProgress?: (progress: Progress) => void; wordpress: WordPressState;
}) {
  const [draft, setDraft] = useState<Article>({ ...item, body_html: stripFigures(item.body_html) });
  const [editingSection, setEditingSection] = useState("");
  const [busyAction, setBusyAction] = useState("");
  const [images, setImages] = useState<ArticleImage[]>([]);
  const [instructions, setInstructions] = useState<Record<string, string>>({});
  const [imageSettings, setImageSettings] = useState<Record<string, string>>({});
  const parsed = splitArticleBody(draft.body_html);
  const suggestions = (() => { try { const value = JSON.parse(draft.image_suggestions_json || "[]"); return Array.isArray(value) ? (value as Array<{ prompt?: string }>) : []; } catch { return []; } })();
  const contentSections = parsed.sections.filter((section) => !isFrame(section.heading));
  const report = (label: string, detail: string, status: "running" | "completed" | "failed", percent = 50) => setProgress?.({ label, detail, status, percent: status === "completed" ? 100 : percent });

  useEffect(() => {
    const timer = window.setTimeout(() => setDraft({ ...item, body_html: stripFigures(item.body_html) }), 0);
    return () => window.clearTimeout(timer);
  }, [item]);
  const loadImages = useCallback(async () => {
    try { setImages((await api<{ images: ArticleImage[] }>(`articles/${item.id}/images`)).images); }
    catch (error) { setNotice(errorText(error)); }
  }, [item.id, setNotice]);
  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => void loadImages(), 0);
    return () => window.clearTimeout(timer);
  }, [open, loadImages]);

  const imageFor = (contentIndex: number, heading: string) =>
    images.find((image) => image.kind === "section" && image.section_index === contentIndex) ||
    images.find((image) => image.kind === "section" && (image.section_index ?? -1) < 0 && image.section_heading === heading);
  const featuredImage = images.find((image) => image.kind === "featured")?.url || draft.featured_image_url;
  const promptFor = (key: string, fallback: string) => imageSettings[key] ?? fallback;
  const updateSections = (intro: string, sections: EditorSection[]) => setDraft((current) => ({ ...current, body_html: combineArticleBody(intro, sections) }));

  const guard = async (key: string, label: string, task: () => Promise<string>) => {
    if (busyAction) return;
    setBusyAction(key);
    report(label, "処理しています", "running", 20);
    try {
      const message = await task();
      setNotice(message);
      report(label, message, "completed");
    } catch (error) {
      const message = errorText(error);
      setNotice(message);
      report(label, message, "failed");
    } finally { setBusyAction(""); }
  };

  const save = () => guard("save", "記事の編集内容を保存", async () => {
    const result = await api<{ notice: string }>(`articles/${item.id}`, "PATCH", {
      title: draft.title, title_tag: draft.title_tag, meta_description: draft.meta_description, slug: draft.slug,
      main_keyword: draft.main_keyword, related_keywords: draft.related_keywords || [], search_intent: draft.search_intent,
      reader: draft.reader, body_html: draft.body_html,
    });
    await refresh();
    return result.notice;
  });
  const sendToWordPress = () => guard("wordpress", "WordPressへ下書き保存", async () => {
    await api(`articles/${item.id}`, "PATCH", { title: draft.title, title_tag: draft.title_tag, meta_description: draft.meta_description, slug: draft.slug, main_keyword: draft.main_keyword, related_keywords: draft.related_keywords || [], search_intent: draft.search_intent, reader: draft.reader, body_html: draft.body_html });
    const result = await api<{ notice: string }>(`articles/${item.id}/wordpress`, "POST", {});
    await refresh();
    return result.notice;
  });

  const regenerateSection = (section: EditorSection, index: number) => guard(`section-${index}`, `H2「${section.heading}」をClaudeで書き直し`, async () => {
    await ensureExtension();
    const hasConversation = /^https:\/\/claude\.ai\/chat\//.test(item.conversation_url || "");
    let context = "";
    if (!hasConversation) {
      const { context: source } = await api<{ context: Record<string, string> }>(`articles/${item.id}/context`);
      context = `\n\n# 動画の一次情報（この範囲だけを根拠にする）\n動画: ${source.youtube_title}\n出演者: ${[source.challenger_company, source.challenger_role, source.challenger_name].filter(Boolean).join("・")}\n${String(source.transcript || "").slice(0, 50000)}`;
    }
    const prompt = `記事「${draft.title}」のH2「${section.heading}」を書き直してください。${instructions[section.id] ? `\n追加指示: ${instructions[section.id]}` : ""}
文字起こしにない事実・数値は追加しない。アーティファクトは使わず会話本文に、次の形式だけで出力してください。

## （見出し）
（本文。必要ならH3を使う）
画像指示: （このH2に合う画像の場面・構図）

# 現在の本文
${plainText(section.bodyHtml)}${context}`;
    const jobId = `edit-${crypto.randomUUID()}`;
    report(`H2「${section.heading}」をClaudeで書き直し`, "Claudeの専用タブで書き直しています", "running", 40);
    await runJob({ id: jobId, provider: "claude", purpose: "section", steps: [{ prompt }], startUrl: hasConversation ? item.conversation_url : undefined });
    const result = parseSectionRewrite((await bridge<{ html: string }>("RESULT", { id: jobId, step: 0 })).html);
    updateSections(parsed.intro, parsed.sections.map((current, currentIndex) => currentIndex === index ? { ...current, heading: result.heading || current.heading, bodyHtml: result.html } : current));
    if (result.imagePrompt) setImageSettings((current) => ({ ...current, [`section-${index}`]: result.imagePrompt }));
    return "H2をClaudeで書き直しました。内容を確認して「変更を保存」を押すと記事とWordPress下書きに反映されます。";
  });

  // The time (mm:ss) used for each H2 image: the editor field, else Claude's instruction, else the first quote.
  const frameTimeFor = (contentIndex: number) => {
    const section = contentSections[contentIndex];
    const typed = timestampSeconds(imageSettings[`time-${contentIndex}`] || "");
    if (typed >= 0) return typed;
    return sectionFrameTimes([{ heading: section?.heading || "", html: section?.bodyHtml || "", imagePrompt: suggestions[contentIndex + 1]?.prompt || "" }])[0] ?? -1;
  };
  const cutFrames = async (contentIndexes: number[]) => {
    await ensureExtension();
    const { context } = await api<{ context: Record<string, string> }>(`articles/${item.id}/context`);
    const taken = images.filter((image) => image.kind === "section" && !contentIndexes.includes(image.section_index ?? -1)).map((image) => timestampSeconds(image.prompt || "")).filter((time) => time >= 0);
    const frames = await captureFrames(context.youtube_url || item.youtube_url || "", contentIndexes.map(frameTimeFor), taken);
    const failed: string[] = [];
    for (let k = 0; k < contentIndexes.length; k++) {
      const section = contentSections[contentIndexes[k]], frame = frames[k];
      if (!frame.ok || !frame.dataUrl) { failed.push(`「${section?.heading}」: ${frame.reason || "良い場面が見つかりませんでした"}`); continue; }
      await api(`articles/${item.id}/images`, "POST", {
        kind: "section", sectionIndex: contentIndexes[k], heading: section?.heading || "",
        alt: `${section?.heading || draft.title}｜${context.challenger_name || ""}さんの対談シーン`,
        prompt: `動画 ${formatTime(frame.seconds)} の実際の場面`, dataUrl: frame.dataUrl,
      });
      setImageSettings((current) => ({ ...current, [`time-${contentIndexes[k]}`]: formatTime(frame.seconds) }));
    }
    if (failed.length === contentIndexes.length) throw new Error(`条件（目が開いている・頭まで収まる・字幕なし・鮮明）を満たす場面が見つかりませんでした。別の時刻を指定してください。${failed.join(" ／ ")}`);
    if (failed.length) setNotice(`一部の画像は良い場面が見つかりませんでした: ${failed.join(" ／ ")}`);
    return { frames, context };
  };
  const makeFeatured = async (context?: Record<string, string>, scene?: Attachment | null) => {
    await ensureExtension();
    const source = context || (await api<{ context: Record<string, string> }>(`articles/${item.id}/context`)).context;
    const reference = source.challenger_image_key ? await imageAttachment(`/api/references/${source.challenger_image_key}`, "challenger-reference.jpg") : null;
    const firstScene = images.find((image) => image.kind === "section");
    const background = scene || (firstScene ? await imageAttachment(firstScene.url, "video-scene.jpg") : await imageAttachment(`/api/youtube/frame/${youtubeId(source.youtube_url)}/maxresdefault.jpg`, "video-scene.jpg"));
    const step = buildFeaturedImageStep(
      { title: draft.title, featuredImagePrompt: promptFor("featured", suggestions[0]?.prompt || "") },
      { challenger_company: source.challenger_company || "", challenger_role: source.challenger_role || "", challenger_name: source.challenger_name || "" },
      reference, background,
    );
    const jobId = `image-${crypto.randomUUID()}`;
    report("ChatGPTでアイキャッチを作成", "ChatGPTの専用タブで作成しています", "running", 60);
    await runJob({ id: jobId, provider: "gpt", purpose: "images", steps: [step] });
    const image = await bridge<{ dataUrl: string }>("IMAGE", { id: jobId, step: 0 });
    await api(`articles/${item.id}/images`, "POST", { kind: "featured", sectionIndex: -1, heading: "", alt: `${draft.title}｜A TRUTH STORY`, prompt: step.prompt, dataUrl: image.dataUrl });
  };
  const finishImages = async (message: string) => {
    await loadImages();
    await refresh();
    return `${message}${item.wordpress_status === "DRAFT" ? "「WordPress下書きを更新」でWordPressにも反映できます。" : ""}`;
  };
  const regenerateImage = (kind: "featured" | "section", contentIndex: number, label: string) =>
    guard(`image-${kind}-${contentIndex}`, label, async () => {
      if (kind === "featured") { await makeFeatured(); return finishImages("アイキャッチをChatGPTで作り直しました。"); }
      const { frames } = await cutFrames([contentIndex]);
      return finishImages(`動画 ${formatTime(frames[0].seconds)} の場面から、目が開いていて頭まで収まる最も鮮明なコマを切り出しました。`);
    });
  const regenerateAll = () =>
    guard("all-images", "H2画像（動画の場面）とアイキャッチを作り直し", async () => {
      const indexes = contentSections.slice(0, IMAGES_PER_ARTICLE - 1).map((_, index) => index);
      const { frames, context } = await cutFrames(indexes);
      const good = frames.filter((frame) => frame.ok && frame.dataUrl);
      await makeFeatured(context, good[0]?.dataUrl ? { name: "video-scene.jpg", dataUrl: good[0].dataUrl } : null);
      return finishImages(`H2画像${good.length}枚を動画の実際の場面から切り出し、アイキャッチをChatGPTで作成しました。`);
    });

  const publicPreviewUrl = item.wordpress_post_id ? permanentPreviewUrl(item.id) : "";
  let contentCounter = -1;
  return (
    <article className={`panel library-editor-item ${open ? "is-open" : ""}`}>
      <button className="library-editor-head" onClick={toggle}>
        <span>{item.category_name || "カテゴリー未指定"}</span>
        <b>{item.title}</b>
        <em className={item.wordpress_status === "DRAFT" ? "status connected" : "status"}>{item.wordpress_status === "DRAFT" ? "WordPress下書き" : item.wordpress_status === "ERROR" ? "WordPressエラー" : "未入稿"}</em>
      </button>
      <div className="library-editor-summary">
        <b>狙うキーワード:</b> {item.main_keyword}<br />
        <b>検索意図:</b> {item.search_intent || "情報収集"}<br />
        <small>最終更新: {new Date(item.updated_at).toLocaleString("ja-JP")}</small>
        {publicPreviewUrl && (
          <div className="wordpress-public-preview">
            <b>外部確認URL（ログイン不要・期限なし）</b>
            <a className="wordpress-card-link" href={publicPreviewUrl} target="_blank" rel="noreferrer">{publicPreviewUrl}</a>
          </div>
        )}
      </div>
      {open && (
        <div className="article-visual-editor">
          <section className="editor-guide">
            <b>WordPressと同じ見た目で、直接編集できます</b>
            <span>H2の書き直しはClaude、画像の作り直しはChatGPTの画面で行います（API不使用）。保存するとWordPress下書きにも反映されます。</span>
          </section>
          <section className="article-reference-panel">
            <div>
              <b>画像の一括作成</b>
              <span>H2画像4枚は動画の実際の場面から、顔を自動判定して「目が開いている・頭まで収まる・字幕なし・最も鮮明」なコマだけを切り出します（条件を満たさなければ別の時刻で取り直し）。アイキャッチ1枚はChatGPTでデザインします。</span>
            </div>
            <button type="button" className="primary" disabled={Boolean(busyAction)} onClick={() => void regenerateAll()}>
              {busyAction === "all-images" ? "画像を作成中…" : "アイキャッチと全H2画像を作り直す"}
            </button>
          </section>
          <article className="wp-article-canvas">
            <header className="wp-article-header">
              <p className="wp-article-kicker">記事プレビュー</p>
              <h1>{draft.title || "記事タイトル"}</h1>
              <p className="wp-article-description">{draft.meta_description || "検索結果に表示する説明文を設定できます。"}</p>
              {featuredImage && <div className="wp-featured-media" role="img" aria-label={`${draft.title}のアイキャッチ`} style={{ backgroundImage: `url(${featuredImage})` }} />}
              <details className="image-ai-settings">
                <summary>アイキャッチ画像の指示を変更してChatGPTで作り直す</summary>
                <label>
                  画像の指示
                  <textarea value={promptFor("featured", suggestions[0]?.prompt || "")} onChange={(event) => setImageSettings((current) => ({ ...current, featured: event.target.value }))} />
                </label>
                <button type="button" className="secondary" disabled={Boolean(busyAction)} onClick={() => void regenerateImage("featured", 0, "アイキャッチ画像をChatGPTで作り直し")}>
                  {busyAction === "image-featured-0" ? "ChatGPTで作成中…" : "アイキャッチ画像を作り直す"}
                </button>
              </details>
            </header>
            {parsed.intro && (
              <div className="wp-article-intro" contentEditable suppressContentEditableWarning dangerouslySetInnerHTML={{ __html: parsed.intro }} onBlur={(event) => updateSections(event.currentTarget.innerHTML, parsed.sections)} />
            )}
            {parsed.sections.map((section, index) => {
              const isEditing = editingSection === section.id;
              const contentIndex = isFrame(section.heading) ? -1 : ++contentCounter;
              const image = contentIndex >= 0 ? imageFor(contentIndex, section.heading) : undefined;
              return (
                <section className={`wp-editor-section ${isEditing ? "is-editing" : ""}`} key={section.id}>
                  {isEditing ? (
                    <input className="wp-section-heading-input" aria-label={`H2見出し ${index + 1}`} value={section.heading} onChange={(event) => updateSections(parsed.intro, parsed.sections.map((current, currentIndex) => currentIndex === index ? { ...current, heading: event.target.value } : current))} />
                  ) : <h2>{section.heading}</h2>}
                  {image && <div className="wp-section-media" role="img" aria-label={image.alt_text || section.heading} style={{ backgroundImage: `url(${image.url})` }} />}
                  {isEditing ? (
                    <div className="wp-content-editable" contentEditable suppressContentEditableWarning dangerouslySetInnerHTML={{ __html: section.bodyHtml }} onBlur={(event) => updateSections(parsed.intro, parsed.sections.map((current, currentIndex) => currentIndex === index ? { ...current, bodyHtml: event.currentTarget.innerHTML } : current))} />
                  ) : <div className="wp-rendered-content" dangerouslySetInnerHTML={{ __html: section.bodyHtml }} />}
                  {isEditing && (
                    <div className="h2-ai-tools">
                      <label>
                        Claudeへの書き直し指示（任意）
                        <textarea value={instructions[section.id] || ""} placeholder="例：初心者向けに、動画内の具体的な発言を中心に整理" onChange={(event) => setInstructions((current) => ({ ...current, [section.id]: event.target.value }))} />
                      </label>
                      <button type="button" className="secondary" disabled={Boolean(busyAction)} onClick={() => void regenerateSection(section, index)}>
                        {busyAction === `section-${index}` ? "Claudeで書き直し中…" : "このH2本文をClaudeで書き直す"}
                      </button>
                      {contentIndex >= 0 && contentIndex < IMAGES_PER_ARTICLE - 1 && (
                        <>
                          <label>
                            このH2の画像に使う動画の時刻（例 12:34）
                            <input value={imageSettings[`time-${contentIndex}`] ?? formatTime(frameTimeFor(contentIndex))} placeholder="空欄なら本文の発言時刻から自動" onChange={(event) => setImageSettings((current) => ({ ...current, [`time-${contentIndex}`]: event.target.value }))} />
                          </label>
                          <button type="button" className="secondary" disabled={Boolean(busyAction)} onClick={() => void regenerateImage("section", contentIndex, `H2「${section.heading}」の画像を動画から切り出し`)}>
                            {busyAction === `image-section-${contentIndex}` ? "動画から切り出し中…" : "この時刻の場面を動画から切り出す"}
                          </button>
                        </>
                      )}
                    </div>
                  )}
                  <div className="wp-section-actions">
                    <button type="button" className="secondary" onClick={() => setEditingSection(isEditing ? "" : section.id)}>{isEditing ? "編集を終了" : "このH2を編集"}</button>
                    <button type="button" className="text-button" disabled={parsed.sections.length === 1} onClick={() => updateSections(parsed.intro, parsed.sections.filter((_, currentIndex) => currentIndex !== index))}>このH2を削除</button>
                  </div>
                </section>
              );
            })}
            <button type="button" className="secondary wp-add-section" onClick={() => updateSections(parsed.intro, [...parsed.sections, { id: `section-${parsed.sections.length + 1}`, heading: "新しい見出し", bodyHtml: "<p>本文を入力してください。</p>" }])}>H2セクションを追加</button>
          </article>
          <details className="seo-settings-panel" open>
            <summary>SEO設定（タイトルタグ・URL末尾・説明文・キーワード）</summary>
            <div className="seo-editor-grid">
              <label>記事タイトル（H1）<input value={draft.title || ""} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label>
              <label>SEOタイトル（titleタグ）<input value={draft.title_tag || ""} maxLength={80} onChange={(event) => setDraft({ ...draft, title_tag: event.target.value })} /><small>{String(draft.title_tag || "").length}/60文字目安</small></label>
              <label>URL末尾（slug）<input value={draft.slug || ""} onChange={(event) => setDraft({ ...draft, slug: event.target.value })} /><small>公開URL: /{draft.slug || "article"}</small></label>
              <label>メタディスクリプション<textarea value={draft.meta_description || ""} maxLength={160} onChange={(event) => setDraft({ ...draft, meta_description: event.target.value })} /><small>{String(draft.meta_description || "").length}/120文字目安</small></label>
              <label>主軸キーワード<input value={draft.main_keyword || ""} onChange={(event) => setDraft({ ...draft, main_keyword: event.target.value })} /></label>
              <label>関連キーワード<input value={(draft.related_keywords || []).join("、")} onChange={(event) => setDraft({ ...draft, related_keywords: event.target.value.split(/[、,]+/).map((value) => value.trim()).filter(Boolean) })} /></label>
            </div>
          </details>
          <details className="technical-details">
            <summary>詳細設定：WordPress用HTMLを確認・修正する</summary>
            <textarea className="article-html-editor" value={draft.body_html || ""} onChange={(event) => setDraft({ ...draft, body_html: event.target.value })} />
          </details>
          <div className="button-row editor-save-row">
            <button type="button" className="primary" disabled={Boolean(busyAction)} onClick={() => void save()}>{busyAction === "save" ? "保存中…" : "変更を保存"}</button>
            {wordpress.connected && (
              <button type="button" className="primary" disabled={Boolean(busyAction)} onClick={() => void sendToWordPress()}>
                {busyAction === "wordpress" ? "WordPressへ保存中…" : item.wordpress_status === "DRAFT" ? "WordPress下書きを更新" : "WordPressへ下書き保存"}
              </button>
            )}
            {publicPreviewUrl && <a className="secondary wp-edit-link" href={publicPreviewUrl} target="_blank" rel="noreferrer">外部確認URLを開く</a>}
            {item.wordpress_edit_url && <a className="secondary wp-edit-link" href={item.wordpress_edit_url} target="_blank" rel="noreferrer">WordPressで編集</a>}
          </div>
        </div>
      )}
    </article>
  );
}

// ---------------------------------------------------------------------------
// LLMO / AIO and reports (Claude screen analysis)
// ---------------------------------------------------------------------------
function AioPage({ articles }: { articles: Article[] }) {
  return (
    <>
      <div className="heading"><div><h2>LLMO / AIO 分析</h2><p>動画一次情報がAI検索の回答に使える構造になっているかを確認します。</p></div></div>
      <section className="kpis">
        <Kpi label="一次情報記事" value={articles.length} hint="分析対象" />
        <Kpi label="WordPress下書き" value={articles.filter((item) => item.wordpress_status === "DRAFT").length} hint="確認待ち" />
        <Kpi label="外部確認URL" value={articles.filter((item) => item.wordpress_post_id).length} hint="共有可能" />
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
        <p className="field-help">「レポート・PDCA」から、Chromeで開いた実測画面をClaudeに分析させることができます。</p>
      </section>
    </>
  );
}

function Reports({ setNotice, setProgress }: { setNotice: (message: string) => void; setProgress: (progress: Progress) => void }) {
  const [report, setReport] = useState<{ html: string; createdAt: string; url: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setReport(readJson(REPORT_KEY, null)), 0);
    return () => window.clearTimeout(timer);
  }, []);
  const analyze = async () => {
    const label = "サイトの実測データをClaudeで分析";
    setBusy(true);
    try {
      await ensureExtension();
      setProgress({ label, percent: 10, detail: "Search Console・GA4・UbersuggestからAPIで実測データを取得しています", status: "running" });
      const research = await api<Research>("seo/research", "POST", { seeds: [] });
      if (!research.statuses.some((status) => status.ok)) throw new Error(`実測データを取得できませんでした（${research.statuses.map((status) => `${status.source}: ${status.detail}`).join("／")}）。連携設定を確認してください。`);
      const prompt = `次はGoogle Search Console・Google Analytics 4・UbersuggestからAPIで取得したサイトの実測データです。横断分析し、SEO・LLMO/AIO・競合・コンテンツ改善のレポートとPDCA（Plan/Do/Check/Act）を日本語で作成してください。データにない数値は推測せず、各数値の出典・期間を明記し、GSCのクエリ、GA4の自然検索ランディングページ、Ubersuggestの検索ボリューム・難易度を混同しないでください。最後に「次に作るべき記事テーマ」を優先度順に5つ、根拠データ付きで挙げてください。アーティファクトは使わず会話本文にMarkdownで書いてください。\n\n${research.markdown}`;
      const jobId = `report-${crypto.randomUUID()}`;
      setProgress({ label, percent: 30, detail: "Claudeの専用タブで分析しています", status: "running" });
      const job = await runJob({ id: jobId, provider: "claude", purpose: "report", steps: [{ prompt }] });
      const result = await bridge<{ html: string }>("RESULT", { id: jobId, step: 0 });
      const next = { html: result.html, createdAt: new Date().toISOString(), url: job.url };
      setReport(next);
      writeJson(REPORT_KEY, next);
      setProgress({ label, percent: 100, detail: "分析レポートを表示しました", status: "completed" });
    } catch (error) {
      const message = errorText(error);
      setNotice(message);
      setProgress({ label, percent: 30, detail: message, status: "failed" });
    } finally { setBusy(false); }
  };
  return (
    <>
      <div className="heading report-heading">
        <div>
          <div className="eyebrow">SEO INTELLIGENCE</div>
          <h2>レポート・PDCA</h2>
          <p>Search Console・GA4・UbersuggestのデータをAPIで取得し、ログイン中のClaudeの画面で分析します。</p>
        </div>
        <button className="primary report-run" disabled={busy} onClick={() => void analyze()}>{busy ? "分析中…" : "実測データをClaudeで分析"}</button>
      </div>
      {!report ? (
        <section className="panel report-empty"><b>まだ分析レポートはありません</b><p>右上のボタンを押すと、APIでデータを取得してClaudeが分析します。</p></section>
      ) : (
        <section className="panel report-body">
          <p className="field-help">作成日時: {new Date(report.createdAt).toLocaleString("ja-JP")}{report.url && <> ／ <a href={report.url} target="_blank" rel="noreferrer">Claudeの会話を開く</a></>}</p>
          <div className="wp-rendered-content" dangerouslySetInnerHTML={{ __html: report.html }} />
        </section>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------
function Connections({ wordpress, refresh, setNotice }: { wordpress: WordPressState; refresh: () => Promise<unknown>; setNotice: (message: string) => void }) {
  const [extension, setExtension] = useState("確認中…");
  const [working, setWorking] = useState("");
  const [showWordpressForm, setShowWordpressForm] = useState(false);
  const checkExtension = useCallback(async () => {
    try { setExtension(`接続済み（バージョン ${await ensureExtension()}）`); }
    catch (error) { setExtension(errorText(error)); }
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => void checkExtension(), 0);
    return () => window.clearTimeout(timer);
  }, [checkExtension]);
  const saveWordpress = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setWorking("wordpress");
    try {
      const result = await api<{ notice: string }>("integrations/wordpress/check", "POST", Object.fromEntries(new FormData(event.currentTarget)));
      setNotice(result.notice);
      setShowWordpressForm(false);
      await refresh();
    } catch (error) { setNotice(`WordPressに接続できませんでした: ${errorText(error)}`); }
    finally { setWorking(""); }
  };
  const backfill = async () => {
    setWorking("backfill");
    try { setNotice((await api<{ notice: string }>("wordpress/public-previews/backfill", "POST", {})).notice); await refresh(); }
    catch (error) { setNotice(errorText(error)); }
    finally { setWorking(""); }
  };
  const extensionOk = extension.startsWith("接続済み");
  const cards: Array<[string, string, string, string]> = [
    ["C", "Claude（Web版）", "記事・H2書き直し・分析をログイン済みの画面で実行", "https://claude.ai/new"],
    ["I", "ChatGPT（Web版）", "記事画像をログイン済みの画面で生成（ChatGPTで利用できる最新の画像生成）", "https://chatgpt.com/"],
  ];
  return (
    <>
      <div className="heading">
        <div><h2>連携設定</h2><p>記事・画像の生成はAPIキーを使わず、このPCのChromeでログイン済みのClaude・ChatGPTを専用拡張が操作します。検索データ（Search Console・GA4・Ubersuggest）はAPIで取得してClaudeの分析に使い、WordPressは下書き保存に使います。</p></div>
        <button className="primary" onClick={() => void checkExtension()}>PC連携を確認</button>
      </div>
      <section className="integration-grid">
        <article className="integration-card">
          <div className="integration-card-head"><i>E</i><div><h3>Chrome拡張（PC連携）</h3><p>Claude・ChatGPTの専用タブを開いて入力・送信・回答取得を行います</p></div></div>
          <span className={`integration-status ${extensionOk ? "connected" : "error"}`}>{extensionOk ? "接続済み" : "要対応"}</span>
          <p className="integration-checked">{extension}</p>
          <a className="integration-toggle" href="/downloads/video-studio-extension.zip" download>最新版をダウンロード（{LATEST_EXTENSION}）</a>
        </article>
        <article className={`integration-card ${showWordpressForm ? "is-open" : ""}`}>
          <div className="integration-card-head"><i>W</i><div><h3>WordPress</h3><p>記事を「下書き」で保存し、外部確認URLを発行（公開はしません）</p></div></div>
          <span className={`integration-status ${wordpress.connected ? "connected" : "pending"}`}>{wordpress.connected ? "接続済み" : "未接続"}</span>
          <p className="integration-checked">{wordpress.connected ? wordpress.siteUrl : "サイトURL・ユーザー名・アプリケーションパスワードで接続します"}</p>
          <button type="button" className="integration-toggle" onClick={() => setShowWordpressForm(!showWordpressForm)}>{showWordpressForm ? "閉じる" : wordpress.connected ? "接続先を変更" : "接続する"}</button>
          {wordpress.connected && <button type="button" className="integration-toggle" disabled={Boolean(working)} onClick={() => void backfill()}>{working === "backfill" ? "発行中…" : "外部確認URLが無い下書きに発行"}</button>}
          {showWordpressForm && (
            <form className="integration-form" onSubmit={(event) => void saveWordpress(event)}>
              <label>WordPress URL<input name="siteUrl" type="url" required defaultValue={wordpress.siteUrl} placeholder="https://example.com" /></label>
              <label>ユーザー名<input name="username" required autoComplete="username" /></label>
              <label>アプリケーションパスワード<input name="applicationPassword" type="password" required autoComplete="new-password" placeholder="xxxx xxxx xxxx xxxx xxxx xxxx" /></label>
              <p className="field-help">WordPress管理画面「ユーザー → プロフィール → アプリケーションパスワード」で発行します。パスワードは暗号化して保存し、画面には再表示しません。</p>
              <button className="primary" disabled={Boolean(working)}>{working === "wordpress" ? "接続を確認中…" : "保存して接続テスト"}</button>
            </form>
          )}
        </article>
        <DataConnectionCards setNotice={setNotice} />
        {cards.map(([icon, name, purpose, url]) => (
          <article className="integration-card" key={name}>
            <div className="integration-card-head"><i>{icon}</i><div><h3>{name}</h3><p>{purpose}</p></div></div>
            <span className="integration-status connected">Chrome画面</span>
            <a className="integration-toggle" href={url} target="_blank" rel="noreferrer">ログイン画面を開く</a>
          </article>
        ))}
      </section>
      <section className="panel">
        <h3>Chrome拡張の導入・更新</h3>
        <ol>
          <li>上の「最新版をダウンロード」でZIPを保存し、書類フォルダーなど消さない場所に展開します。</li>
          <li>Chromeのアドレス欄に <code>chrome://extensions</code> と入力し、右上の「デベロッパーモード」をONにします。</li>
          <li>古い版が入っている場合は削除し、「パッケージ化されていない拡張機能を読み込む」で展開したフォルダーを選びます。</li>
          <li>同じChromeでClaude（claude.ai）とChatGPT（chatgpt.com）にログインします。</li>
          <li>この画面を再読み込みし「PC連携を確認」を押します。</li>
        </ol>
        <p className="field-help">制作中、Claude・ChatGPTは別ウィンドウの専用タブで動きます。PCとChromeを閉じると処理は止まりますが、再度この画面を開くと続きから再開します。ChatGPTの画像モデルはChatGPT側で提供される最新のものが使われます（画面から特定のモデル名を固定することはできません）。</p>
      </section>
    </>
  );
}

const DATA_SOURCES: Record<string, { icon: string; name: string; purpose: string }> = {
  gsc: { icon: "G", name: "Google Search Console（API）", purpose: "検索クエリ・表示回数・CTR・順位を取得してキーワード分析に使用" },
  ga4: { icon: "A", name: "Google Analytics 4（API）", purpose: "自然検索で流入したページの行動データを取得して分析に使用" },
  ubersuggest: { icon: "U", name: "Ubersuggest（MCP API）", purpose: "関連キーワードの月間検索数・SEO難易度・検索上位ページを取得" },
};
function DataConnectionCards({ setNotice }: { setNotice: (message: string) => void }) {
  const [connections, setConnections] = useState<DataConnection[]>([]);
  const [working, setWorking] = useState("");
  const loadConnections = useCallback(async () => {
    try { setConnections((await api<{ connections: DataConnection[] }>("integrations/data")).connections); }
    catch (error) { setNotice(errorText(error)); }
  }, [setNotice]);
  useEffect(() => {
    const timer = window.setTimeout(() => void loadConnections(), 0);
    return () => window.clearTimeout(timer);
  }, [loadConnections]);
  const act = async (key: string, task: () => Promise<void>) => {
    setWorking(key);
    try { await task(); } catch (error) { setNotice(errorText(error)); } finally { setWorking(""); }
  };
  const connect = (provider: string) => act(`connect-${provider}`, async () => {
    const result = await api<{ authorizationUrl: string }>(`integrations/${provider === "ubersuggest" ? "ubersuggest" : "google"}/connect`, "POST", {});
    window.location.assign(result.authorizationUrl);
  });
  const check = (provider: string) => act(`check-${provider}`, async () => {
    const result = await api<{ connections: DataConnection[]; notice: string }>(`integrations/${provider}/check`, "POST", {});
    setConnections(result.connections);
    setNotice(result.notice);
  });
  const select = (provider: string, resourceId: string) => act(`select-${provider}`, async () => {
    const result = await api<{ connections: DataConnection[]; notice: string }>(`integrations/${provider}/select`, "POST", { resourceId });
    setConnections(result.connections);
    setNotice(result.notice);
  });
  return (
    <>
      {connections.map((item) => {
        const meta = DATA_SOURCES[item.provider], ok = item.status === "CONFIGURED";
        return (
          <article className="integration-card" key={item.provider}>
            <div className="integration-card-head"><i>{meta.icon}</i><div><h3>{meta.name}</h3><p>{meta.purpose}</p></div></div>
            <span className={`integration-status ${ok ? "connected" : item.status === "CONNECTION_ERROR" ? "error" : "pending"}`}>{ok ? "API接続済み" : item.status === "CONNECTION_ERROR" ? "接続エラー" : "未接続"}</span>
            <p className="integration-checked">
              {item.provider !== "ubersuggest" ? `利用対象: ${item.selectedLabel || "未選択"}` : "地域: 日本／言語: 日本語"}
              {item.lastError && !ok ? <><br />{item.lastError}</> : null}
              <br />最終確認: {item.checkedAt ? new Date(item.checkedAt).toLocaleString("ja-JP") : "未確認"}
            </p>
            {ok && item.provider !== "ubersuggest" && item.resources.length > 0 && (
              <label className="integration-form">
                利用する{item.provider === "gsc" ? "サイト" : "プロパティ"}
                <select value={item.selectedId} disabled={Boolean(working)} onChange={(event) => void select(item.provider, event.currentTarget.value)}>
                  <option value="">選択してください</option>
                  {item.resources.map((resource) => <option key={resource.id} value={resource.id}>{resource.label}</option>)}
                </select>
              </label>
            )}
            {ok && <button type="button" className="integration-toggle" disabled={Boolean(working)} onClick={() => void check(item.provider)}>{working === `check-${item.provider}` ? "確認中…" : "接続を確認"}</button>}
            <button type="button" className="integration-toggle" disabled={Boolean(working)} onClick={() => void connect(item.provider)}>
              {working === `connect-${item.provider}` ? "認証画面を準備中…" : ok ? "再接続" : item.provider === "ubersuggest" ? "Ubersuggestに接続" : "Googleアカウントで接続"}
            </button>
          </article>
        );
      })}
    </>
  );
}
