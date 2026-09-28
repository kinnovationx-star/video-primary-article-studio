// Fetches real search data (Search Console, GA4, Ubersuggest MCP) for Claude to analyse.
// Data APIs only: no AI API is called here. Every figure keeps its source, period and filters.
import { getGoogleAccessToken, getUbersuggestAccessToken } from "./studio-connections";
import { parse, runtime, text } from "./studio-server";
import { rawMcpStructuredValue } from "./serp-provider";
import { UbersuggestMcpClient } from "../cloud-runner/src/ubersuggest-mcp";

type Json = Record<string, unknown>;
export type SourceStatus = { source: string; ok: boolean; detail: string };
const LOCATION_JAPAN = 2392;
const record = (value: unknown): Json => (value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {});
const list = (value: unknown): Json[] => (Array.isArray(value) ? value.map(record) : []);
const num = (value: unknown) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const day = (offset: number) => new Date(Date.now() - offset * 86400_000).toISOString().slice(0, 10);
const cell = (value: unknown) => String(value ?? "").replace(/\|/g, "／").replace(/\s+/g, " ").trim();
const table = (headers: string[], rows: unknown[][]) =>
  rows.length ? [`| ${headers.join(" | ")} |`, `| ${headers.map(() => "---").join(" | ")} |`, ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`)].join("\n") : "（該当データなし）";

async function selected(provider: "gsc" | "ga4") {
  const row = await runtime().DB.prepare("SELECT public_config,status FROM integration_profiles WHERE provider=?").bind(provider).first<{ public_config: string; status: string }>();
  const config = parse(row?.public_config || "{}", {} as Json);
  return { id: text(config.selectedResourceId, 600), label: text(config.selectedResourceLabel, 600), status: row?.status || "NOT_CONFIGURED" };
}

async function googlePost(url: string, token: string, body: Json) {
  const response = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  const payload = record(await response.json().catch(() => ({})));
  if (!response.ok) throw new Error(text(record(payload.error).message || `Google APIエラー (${response.status})`, 200));
  return payload;
}

const relevant = (value: string, seeds: string[]) => {
  const lower = value.toLocaleLowerCase("ja-JP");
  return seeds.some((seed) => {
    const parts = seed.toLocaleLowerCase("ja-JP").split(/\s+/).filter((part) => part.length >= 2);
    return lower.includes(seed.toLocaleLowerCase("ja-JP")) || (parts[0] && parts[0].length >= 3 && lower.includes(parts[0]));
  });
};

async function searchConsole(request: Request, seeds: string[]) {
  const site = await selected("gsc");
  if (!site.id) throw new Error("Search Consoleの対象サイトが未選択です（連携設定で選択）。");
  const token = await getGoogleAccessToken(request);
  const endpoint = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site.id)}/searchAnalytics/query`;
  const startDate = day(91), endDate = day(3);
  const [queries, pages] = await Promise.all([
    googlePost(endpoint, token, { startDate, endDate, dimensions: ["query"], rowLimit: 1000 }),
    googlePost(endpoint, token, { startDate, endDate, dimensions: ["page"], rowLimit: 30 }),
  ]);
  const rows = list(queries.rows).map((row) => ({ query: text((row.keys as unknown[] | undefined)?.[0], 200), clicks: num(row.clicks), impressions: num(row.impressions), ctr: num(row.ctr), position: num(row.position) }));
  const matched = seeds.length ? rows.filter((row) => relevant(row.query, seeds)).slice(0, 60) : [];
  const top = rows.slice(0, 30);
  const format = (items: typeof rows) => table(["クエリ", "クリック", "表示回数", "CTR", "平均順位"], items.map((row) => [row.query, row.clicks, row.impressions, `${(row.ctr * 100).toFixed(1)}%`, row.position.toFixed(1)]));
  const pageRows = list(pages.rows).map((row) => [text((row.keys as unknown[] | undefined)?.[0], 300), num(row.clicks), num(row.impressions), num(row.position).toFixed(1)]);
  return {
    topQueries: top.map((row) => row.query),
    status: { source: "Google Search Console", ok: true, detail: `${site.label}／${startDate}〜${endDate}／クエリ${rows.length}件（候補語に一致${matched.length}件）` },
    markdown: `## Google Search Console（API取得）\n対象: ${site.label}／期間: ${startDate}〜${endDate}（直近90日）／検索タイプ: ウェブ\n\n### 動画テーマの候補語に一致するクエリ\n${seeds.length ? format(matched) : "（候補語なし）"}\n\n### サイト全体の上位クエリ（クリック順・上位30）\n${format(top)}\n\n### サイトの上位ページ（既存記事との競合確認用）\n${table(["ページ", "クリック", "表示回数", "平均順位"], pageRows)}`,
  };
}

async function analytics(request: Request) {
  const property = await selected("ga4");
  if (!property.id) throw new Error("GA4の対象プロパティが未選択です（連携設定で選択）。");
  const token = await getGoogleAccessToken(request);
  const resource = property.id.startsWith("properties/") ? property.id : `properties/${property.id}`;
  const startDate = day(90), endDate = day(1);
  const data = await googlePost(`https://analyticsdata.googleapis.com/v1beta/${resource}:runReport`, token, {
    dateRanges: [{ startDate, endDate }],
    dimensions: [{ name: "landingPagePlusQueryString" }],
    metrics: [{ name: "sessions" }, { name: "engagedSessions" }, { name: "averageSessionDuration" }, { name: "keyEvents" }],
    dimensionFilter: { filter: { fieldName: "sessionDefaultChannelGroup", stringFilter: { value: "Organic Search" } } },
    orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
    limit: 30,
  });
  const rows = list(data.rows).map((row) => {
    const metrics = list(row.metricValues).map((item) => num(item.value));
    return [text(list(row.dimensionValues)[0]?.value, 300), metrics[0], metrics[1], `${Math.round(metrics[2] || 0)}秒`, metrics[3]];
  });
  return {
    status: { source: "Google Analytics 4", ok: true, detail: `${property.label}／${startDate}〜${endDate}／自然検索ランディングページ${rows.length}件` },
    markdown: `## Google Analytics 4（API取得）\n対象: ${property.label}／期間: ${startDate}〜${endDate}／チャネル: Organic Search（自然検索）のみ\n※GA4には検索語別のデータはありません。ページ別の流入後の行動として扱うこと。\n\n${table(["ランディングページ", "セッション", "エンゲージ済みセッション", "平均セッション時間", "キーイベント"], rows)}`,
  };
}

async function ubersuggest(seeds: string[]) {
  if (!seeds.length) throw new Error("調査する候補語がありません。");
  const client = new UbersuggestMcpClient(await getUbersuggestAccessToken());
  const rows = new Map<string, { volume: number; sd: number; cpc: number; seed: string }>();
  const errors: string[] = [];
  for (let index = 0; index < Math.min(seeds.length, 12); index += 3) {
    const batch = seeds.slice(index, index + 3);
    try {
      const value = record(rawMcpStructuredValue(await client.callTool("keyword_suggestions", { keywords: batch, language: "ja", locId: LOCATION_JAPAN })));
      for (const row of list(value.results)) {
        const keyword = text(row.keyword, 120);
        if (keyword && !rows.has(keyword)) rows.set(keyword, { volume: num(row.volume), sd: num(row.sd), cpc: num(row.cpcDollars ?? row.cpc), seed: batch.join("・") });
      }
    } catch (error) { errors.push(text((error as Error).message, 120)); }
  }
  let serp = "";
  try {
    const value = record(rawMcpStructuredValue(await client.callTool("serp_analysis", { keyword: seeds[0], language: "ja", locId: LOCATION_JAPAN, limit: 10 })));
    const entries = list(value.serpEntries ?? value.results ?? value.serp);
    serp = table(["順位", "タイトル", "URL"], entries.slice(0, 10).map((entry, i) => [num(entry.position ?? entry.rank) || i + 1, text(entry.title, 160), text(entry.url ?? entry.link, 300)]));
  } catch (error) { errors.push(`SERP: ${text((error as Error).message, 120)}`); }
  if (!rows.size && errors.length) throw new Error(errors[0]);
  const sorted = [...rows.entries()].sort((a, b) => b[1].volume - a[1].volume).slice(0, 80);
  return {
    status: { source: "Ubersuggest", ok: true, detail: `日本・日本語／候補語${Math.min(seeds.length, 12)}件から関連語${rows.size}件${errors.length ? `（一部取得失敗: ${errors.length}件）` : ""}` },
    markdown: `## Ubersuggest（MCP API取得）\n地域: 日本／言語: 日本語／取得日: ${day(0)}\n候補語: ${seeds.slice(0, 12).join("、")}\n\n### 関連キーワード（月間検索ボリューム順）\n${table(["キーワード", "月間検索数", "SEO難易度(SD)", "CPC(USD)", "元の候補語"], sorted.map(([keyword, row]) => [keyword, row.volume, row.sd, row.cpc, row.seed]))}\n\n### 「${seeds[0]}」の検索上位ページ（競合）\n${serp || "（取得できませんでした）"}`,
  };
}

// Seeds come from Claude's reading of the transcript. With no seeds (site-wide report), the
// top Search Console queries are used as Ubersuggest seeds.
export async function seoResearch(request: Request, rawSeeds: unknown) {
  let seeds = (Array.isArray(rawSeeds) ? rawSeeds : []).map((item) => text(item, 60).replace(/\s+/g, " ")).filter((item) => item.length >= 2).slice(0, 12);
  const statuses: SourceStatus[] = [], sections: string[] = [];
  const fail = (source: string, error: unknown) => statuses.push({ source, ok: false, detail: text((error as Error)?.message || error, 200) });
  try {
    const result = await searchConsole(request, seeds);
    statuses.push(result.status); sections.push(result.markdown);
    if (!seeds.length) seeds = result.topQueries.slice(0, 6);
  } catch (error) { fail("Google Search Console", error); }
  try { const result = await analytics(request); statuses.push(result.status); sections.push(result.markdown); }
  catch (error) { fail("Google Analytics 4", error); }
  try { const result = await ubersuggest(seeds); statuses.push(result.status); sections.push(result.markdown); }
  catch (error) { fail("Ubersuggest", error); }
  const missing = statuses.filter((status) => !status.ok).map((status) => `- ${status.source}: 取得できませんでした（${status.detail}）。このデータの数値は推測しないこと。`);
  return {
    seeds,
    statuses,
    markdown: `${sections.join("\n\n")}${missing.length ? `\n\n## 取得できなかったデータ\n${missing.join("\n")}` : ""}`,
  };
}
