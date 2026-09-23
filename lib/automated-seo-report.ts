import { fetchCompetitiveSource, analyzeCompetition, type CompetitiveSource } from "./competitive-intelligence";
import { getGoogleAccessToken, getUbersuggestAccessToken } from "./studio-connections";
import { id, now, parse, runtime, safeError, text } from "./studio-server";
import { normalizeUbersuggestSerp } from "./serp-provider";
import { UbersuggestMcpClient } from "../cloud-runner/src/ubersuggest-mcp";

type JsonObject = Record<string, unknown>;
type SourceStatus = { source: string; status: "取得済み" | "未取得"; detail: string };
type TrendPoint = { date: string; primary: number; secondary: number };
type ReportScores = { visibility: number; engagement: number; competitive: number; opportunity: number; overall: number };
type AiAnalysis = { executiveSummary: string; strengths: string[]; issues: string[]; actions: string[]; pdca: { plan: string[]; do: string[]; check: string[]; act: string[] } };

const numberValue = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : 0;
const clamp = (value: number) => Math.max(0, Math.min(100, Math.round(value)));
const isoDate = (date: Date) => date.toISOString().slice(0, 10);
const compact = (value: unknown, max = 24000) => JSON.stringify(value).slice(0, max);

async function jsonRequest(url: string, init: RequestInit = {}) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const size = Number(response.headers.get("content-length") || 0);
    if (size > 2_000_000) throw new Error("分析データの応答が大きすぎます。");
    const payload = await response.json().catch(() => ({})) as JsonObject;
    if (!response.ok) {
      const nested = payload.error && typeof payload.error === "object" ? payload.error as JsonObject : {};
      throw new Error(text(nested.message || payload.message || `APIエラー (${response.status})`, 240));
    }
    return payload;
  } finally { clearTimeout(timer); }
}

async function integrationConfig(provider: string) {
  const row = await runtime().DB.prepare("SELECT status,public_config FROM integration_profiles WHERE provider=?").bind(provider).first<{ status: string; public_config: string }>();
  return { status: row?.status || "NOT_CONFIGURED", config: parse(row?.public_config || "{}", {} as JsonObject) };
}

function gscRows(payload: JsonObject) {
  return Array.isArray(payload.rows) ? payload.rows.filter((row): row is JsonObject => Boolean(row && typeof row === "object")) : [];
}

async function loadGsc(token: string, siteUrl: string, startDate: string, endDate: string) {
  const endpoint = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`, headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const [dailyPayload, queryPayload] = await Promise.all([
    jsonRequest(endpoint, { method: "POST", headers, body: JSON.stringify({ startDate, endDate, dimensions: ["date"], rowLimit: 1000, dataState: "final" }) }),
    jsonRequest(endpoint, { method: "POST", headers, body: JSON.stringify({ startDate, endDate, dimensions: ["query"], rowLimit: 20, dataState: "final" }) }),
  ]);
  const daily = gscRows(dailyPayload).map(row => ({ date: text((row.keys as unknown[] | undefined)?.[0], 20), clicks: numberValue(row.clicks), impressions: numberValue(row.impressions), ctr: numberValue(row.ctr), position: numberValue(row.position) }));
  const queries = gscRows(queryPayload).map(row => ({ query: text((row.keys as unknown[] | undefined)?.[0], 240), clicks: numberValue(row.clicks), impressions: numberValue(row.impressions), ctr: numberValue(row.ctr), position: numberValue(row.position) }));
  const clicks = daily.reduce((sum, row) => sum + row.clicks, 0), impressions = daily.reduce((sum, row) => sum + row.impressions, 0);
  const weightedPosition = daily.reduce((sum, row) => sum + row.position * row.impressions, 0) / Math.max(1, impressions);
  return { siteUrl, summary: { clicks: Math.round(clicks), impressions: Math.round(impressions), ctr: impressions ? clicks / impressions : 0, position: Number(weightedPosition.toFixed(1)) }, daily, queries };
}

function gaRows(payload: JsonObject) {
  return Array.isArray(payload.rows) ? payload.rows.filter((row): row is JsonObject => Boolean(row && typeof row === "object")) : [];
}

function metric(row: JsonObject, index: number) {
  const values = Array.isArray(row.metricValues) ? row.metricValues as JsonObject[] : [];
  return numberValue(values[index]?.value);
}

function dimension(row: JsonObject, index: number) {
  const values = Array.isArray(row.dimensionValues) ? row.dimensionValues as JsonObject[] : [];
  return text(values[index]?.value, 500);
}

async function loadGa4(token: string, property: string, startDate: string, endDate: string) {
  const propertyResource = property.startsWith("properties/") ? property : `properties/${property}`;
  const endpoint = `https://analyticsdata.googleapis.com/v1beta/${propertyResource}:runReport`, headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, metrics = [{ name: "activeUsers" }, { name: "sessions" }, { name: "engagedSessions" }, { name: "keyEvents" }];
  const [dailyPayload, pagePayload] = await Promise.all([
    jsonRequest(endpoint, { method: "POST", headers, body: JSON.stringify({ dateRanges: [{ startDate, endDate }], dimensions: [{ name: "date" }], metrics, orderBys: [{ dimension: { dimensionName: "date" } }], limit: 1000 }) }),
    jsonRequest(endpoint, { method: "POST", headers, body: JSON.stringify({ dateRanges: [{ startDate, endDate }], dimensions: [{ name: "landingPagePlusQueryString" }], metrics, orderBys: [{ metric: { metricName: "sessions" }, desc: true }], limit: 20 }) }),
  ]);
  const daily = gaRows(dailyPayload).map(row => ({ date: dimension(row, 0).replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3"), users: metric(row, 0), sessions: metric(row, 1), engagedSessions: metric(row, 2), keyEvents: metric(row, 3) }));
  const pages = gaRows(pagePayload).map(row => ({ page: dimension(row, 0), users: metric(row, 0), sessions: metric(row, 1), engagedSessions: metric(row, 2), keyEvents: metric(row, 3) }));
  const summary = daily.reduce((result, row) => ({ users: result.users + row.users, sessions: result.sessions + row.sessions, engagedSessions: result.engagedSessions + row.engagedSessions, keyEvents: result.keyEvents + row.keyEvents }), { users: 0, sessions: 0, engagedSessions: 0, keyEvents: 0 });
  return { property, summary, daily, pages };
}

function fallbackAnalysis(scores: ReportScores, keyword: string, gsc: JsonObject | null, ga4: JsonObject | null, competitors: JsonObject[]): AiAnalysis {
  const hasSearch = numberValue((gsc?.summary as JsonObject | undefined)?.impressions) > 0, hasTraffic = numberValue((ga4?.summary as JsonObject | undefined)?.sessions) > 0;
  return {
    executiveSummary: `${keyword || "主要テーマ"}を中心に、検索露出・流入・競合状況を統合しました。取得できた実測値だけを使って改善優先度を算出しています。`,
    strengths: [hasSearch ? "Search Consoleで検索露出を確認できています" : "記事制作データを分析対象に含めています", hasTraffic ? "GA4で流入後の行動を確認できています" : "競合SERPから改善余地を抽出しています"],
    issues: [scores.visibility < 55 ? "検索表示からクリックへの転換に改善余地があります" : "上位クエリの順位維持と拡張が必要です", competitors.length ? "上位競合との差分を一次情報で埋める必要があります" : "競合データを取得できていません"],
    actions: [`「${keyword || "主要テーマ"}」の上位表示ページを優先して改善する`, "表示回数が多くCTRの低いクエリからタイトルを見直す", "流入後のエンゲージメントとキーイベントをページ単位で確認する"],
    pdca: { plan: ["GSC・GA4・競合データから改善対象を決める"], do: ["一次情報を追加して対象ページを更新する"], check: ["28日後にクリック・順位・キーイベントを比較する"], act: ["伸びたテーマを横展開し、未改善テーマを再設計する"] },
  };
}

function cleanClaudeJson(value: string) {
  const match = value.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("AI分析の形式を確認できませんでした。");
  return JSON.parse(match[0]) as AiAnalysis;
}

async function analyzeWithClaude(input: JsonObject, fallback: AiAnalysis) {
  const key = runtime().ANTHROPIC_API_KEY, profile = await integrationConfig("anthropic"), model = text(profile.config.model, 160) || "claude-sonnet-4-6";
  if (!key) return { analysis: fallback, provider: "ルールベース分析" };
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 60000);
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" }, body: JSON.stringify({ model, max_tokens: 2600, temperature: 0.2, system: "あなたはSEOデータアナリストです。提供された実測データだけを根拠にし、未取得値を推測しません。日本語のJSONだけを返してください。", messages: [{ role: "user", content: `GSC・GA4・Ubersuggest SERP・競合ページ・記事制作状況を統合し、経営者にも理解できる改善レポートを作成してください。JSON形式: {"executiveSummary":"","strengths":[""],"issues":[""],"actions":[""],"pdca":{"plan":[""],"do":[""],"check":[""],"act":[""]}}。データ:${compact(input)}` }] }), signal: controller.signal });
    const payload = await response.json().catch(() => ({})) as JsonObject;
    if (!response.ok) throw new Error(text((payload.error as JsonObject | undefined)?.message || `Claude APIエラー (${response.status})`, 240));
    const content = Array.isArray(payload.content) ? payload.content as JsonObject[] : [], output = content.map(item => text(item.text, 10000)).join("");
    return { analysis: cleanClaudeJson(output), provider: `Claude AI (${model})` };
  } catch { return { analysis: fallback, provider: "ルールベース分析（AI応答を取得できなかったため）" }; }
  finally { clearTimeout(timer); }
}

export async function generateAutomatedSeoReport(request: Request) {
  const end = new Date(), start = new Date(end.getTime() - 27 * 86400000), startDate = isoDate(start), endDate = isoDate(end), sourceStatus: SourceStatus[] = [];
  const [gscProfile, ga4Profile] = await Promise.all([integrationConfig("gsc"), integrationConfig("ga4")]);
  let googleToken = "";
  try { googleToken = await getGoogleAccessToken(request); } catch (error) { sourceStatus.push({ source: "Google OAuth", status: "未取得", detail: safeError(error) }); }
  let gsc: Awaited<ReturnType<typeof loadGsc>> | null = null, ga4: Awaited<ReturnType<typeof loadGa4>> | null = null;
  const gscSite = text(gscProfile.config.selectedResourceId, 500), gaProperty = text(ga4Profile.config.selectedResourceId, 500);
  if (googleToken && gscSite) {
    try { gsc = await loadGsc(googleToken, gscSite, startDate, endDate); sourceStatus.push({ source: "Search Console", status: "取得済み", detail: `${gscSite}・過去28日` }); }
    catch (error) { sourceStatus.push({ source: "Search Console", status: "未取得", detail: safeError(error) }); }
  } else sourceStatus.push({ source: "Search Console", status: "未取得", detail: gscSite ? "Googleの再接続が必要です" : "連携設定で対象サイトを選択してください" });
  if (googleToken && gaProperty) {
    try { ga4 = await loadGa4(googleToken, gaProperty, startDate, endDate); sourceStatus.push({ source: "Google Analytics 4", status: "取得済み", detail: `${text(ga4Profile.config.selectedResourceLabel, 300)}・過去28日` }); }
    catch (error) { sourceStatus.push({ source: "Google Analytics 4", status: "未取得", detail: safeError(error) }); }
  } else sourceStatus.push({ source: "Google Analytics 4", status: "未取得", detail: gaProperty ? "Googleの再接続が必要です" : "連携設定で対象プロパティを選択してください" });

  const latestArticle = await runtime().DB.prepare("SELECT main_keyword,title FROM articles ORDER BY updated_at DESC LIMIT 1").first<{ main_keyword: string; title: string }>();
  const latestProject = await runtime().DB.prepare("SELECT transcript,youtube_title,direction FROM production_projects ORDER BY updated_at DESC LIMIT 1").first<{ transcript: string; youtube_title: string; direction: string }>();
  const keyword = gsc?.queries[0]?.query || latestArticle?.main_keyword || latestProject?.youtube_title || (gscSite ? new URL(gscSite).hostname : "");
  let serp: ReturnType<typeof normalizeUbersuggestSerp> | null = null, competitorSources: CompetitiveSource[] = [];
  if (keyword) {
    try {
      const accessToken = await getUbersuggestAccessToken(), call = await new UbersuggestMcpClient(accessToken).callSerp(keyword, { language: "ja", limit: 10 });
      serp = normalizeUbersuggestSerp(call.rawToolResult, call.requestedAt);
      sourceStatus.push({ source: "Ubersuggest MCP", status: "取得済み", detail: `「${keyword}」の実SERP ${serp.results.length}件` });
      const fetched = await Promise.allSettled(serp.results.slice(0, 5).map(item => fetchCompetitiveSource(item.url)));
      competitorSources = fetched.filter((result): result is PromiseFulfilledResult<CompetitiveSource> => result.status === "fulfilled").map(result => result.value);
      sourceStatus.push({ source: "競合ページ", status: competitorSources.length ? "取得済み" : "未取得", detail: competitorSources.length ? `上位${competitorSources.length}ページを解析` : "公開HTMLを取得できませんでした" });
    } catch (error) { sourceStatus.push({ source: "Ubersuggest MCP・競合", status: "未取得", detail: safeError(error) }); }
  } else sourceStatus.push({ source: "Ubersuggest MCP・競合", status: "未取得", detail: "分析するキーワードがありません" });

  const primary = `${latestProject?.youtube_title || ""} ${latestProject?.direction || ""} ${latestProject?.transcript || ""}`.slice(0, 12000), competition = competitorSources.length ? analyzeCompetition(keyword, primary, competitorSources) : null;
  const gscSummary = gsc?.summary, gaSummary = ga4?.summary;
  const visibility = clamp((gscSummary?.ctr || 0) * 900 + Math.max(0, 55 - (gscSummary?.position || 55))), engagement = clamp(gaSummary?.sessions ? gaSummary.engagedSessions / gaSummary.sessions * 100 : 0), competitive = clamp(competition?.scores.competitorDepth || 0), opportunity = clamp(100 - (competition?.scores.keywordCoverage || 0)), scores: ReportScores = { visibility, engagement, competitive, opportunity, overall: clamp(visibility * .32 + engagement * .28 + competitive * .2 + opportunity * .2) };
  const fallback = fallbackAnalysis(scores, keyword, gsc as unknown as JsonObject | null, ga4 as unknown as JsonObject | null, (serp?.results || []) as unknown as JsonObject[]);
  const ai = await analyzeWithClaude({ period: { startDate, endDate }, keyword, gsc, ga4, serp: serp ? { results: serp.results.slice(0, 10), features: serp.features } : null, competition, articles: latestArticle ? [latestArticle] : [], sources: sourceStatus }, fallback);
  sourceStatus.push({ source: "AI統合分析", status: ai.provider.startsWith("Claude AI") ? "取得済み" : "未取得", detail: ai.provider });
  const report = { id: id(), generatedAt: now(), period: { start: startDate, end: endDate }, targets: { searchConsole: gscSite || null, ga4: gaProperty || null }, sourceStatus, keyword, scores, gsc, ga4, competitors: serp?.results.slice(0, 10) || [], competition, ai: ai.analysis, aiProvider: ai.provider, trend: { search: (gsc?.daily || []).map(row => ({ date: row.date, primary: row.clicks, secondary: row.impressions } satisfies TrendPoint)), traffic: (ga4?.daily || []).map(row => ({ date: row.date, primary: row.sessions, secondary: row.engagedSessions } satisfies TrendPoint)) } };
  await runtime().DB.prepare("INSERT INTO automated_reports (id,generated_at,period_start,period_end,report_json) VALUES (?,?,?,?,?)").bind(report.id, report.generatedAt, startDate, endDate, JSON.stringify(report)).run();
  return report;
}

export async function latestAutomatedSeoReport() {
  const row = await runtime().DB.prepare("SELECT report_json FROM automated_reports ORDER BY generated_at DESC LIMIT 1").first<{ report_json: string }>();
  return row?.report_json ? parse(row.report_json, null) : null;
}
