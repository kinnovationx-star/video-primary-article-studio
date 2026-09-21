const entities: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " };
const decode = (value: string) => value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (_, code: string) => code[0] === "#" ? String.fromCodePoint(code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10)) : entities[code.toLowerCase()] || " ");
const clean = (value: string) => decode(value.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ").replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ").replace(/<!--([\s\S]*?)-->/g, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
const tagText = (html: string, pattern: RegExp) => clean(html.match(pattern)?.[1] || "");
const stop = new Set(["について", "ための", "できる", "による", "から", "まで", "とは", "方法", "解説", "紹介", "まとめ", "する", "した", "して", "です", "ます", "こと", "これ", "その", "the", "and", "for", "with"]);
export const topicTokens = (value: string) => (value.toLowerCase().match(/[一-龯ぁ-んァ-ン]{2,12}|[a-z0-9][a-z0-9+._-]{2,}/g) || []).filter(token => !stop.has(token));
const unique = <T,>(items: T[]) => [...new Set(items)];
export type CompetitiveSource = { url: string; title: string; description: string; headings: string[]; topics: string[]; excerpt: string; wordCount: number; status: string };

export function safeCompetitorUrl(value: string) {
  const url = new URL(value);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || (url.port && !["80", "443"].includes(url.port))) throw new Error("競合URLは通常のHTTP/HTTPS URLを指定してください。");
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || host === "0.0.0.0" || host === "::1" || /^(127\.|10\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) throw new Error("ローカル・プライベートネットワークのURLは取得できません。");
  return url.toString();
}
export async function fetchCompetitiveSource(inputUrl: string): Promise<CompetitiveSource> {
  const url = safeCompetitorUrl(inputUrl), response = await fetch(url, { headers: { "User-Agent": "VideoPrimaryArticleStudio/1.0 (+competitive-research)" }, redirect: "follow", signal: AbortSignal.timeout(15000) });
  const contentType = response.headers.get("content-type") || "";
  if (!response.ok || !contentType.includes("text/html")) throw new Error(`HTMLを取得できませんでした（${response.status}）。`);
  const html = (await response.text()).slice(0, 1_500_000);
  const headings = unique([...html.matchAll(/<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/gi)].map(match => clean(match[1])).filter(Boolean)).slice(0, 40);
  const title = tagText(html, /<title\b[^>]*>([\s\S]*?)<\/title>/i) || headings[0] || new URL(url).hostname;
  const description = decode(html.match(/<meta\b[^>]*name=["']description["'][^>]*content=["']([^"']*)/i)?.[1] || html.match(/<meta\b[^>]*content=["']([^"']*)["'][^>]*name=["']description["']/i)?.[1] || "");
  const excerpt = clean(html).slice(0, 8000), topics = unique(topicTokens(`${title} ${headings.join(" ")}`)).slice(0, 30);
  return { url, title: title.slice(0, 240), description: description.slice(0, 500), headings, topics, excerpt, wordCount: topicTokens(excerpt).length, status: "FETCHED" };
}
export function analyzeCompetition(keyword: string, primary: string, sources: CompetitiveSource[]) {
  const frequency = new Map<string, number>();
  for (const source of sources) for (const topic of new Set(source.topics)) frequency.set(topic, (frequency.get(topic) || 0) + 1);
  const commonTopics = [...frequency].sort((a, b) => b[1] - a[1]).filter(([, count]) => count >= Math.max(2, Math.ceil(sources.length / 2))).slice(0, 12).map(([topic]) => topic);
  const primaryTokens = new Set(topicTokens(primary));
  const gaps = [...frequency].filter(([topic]) => !primaryTokens.has(topic)).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([topic]) => topic);
  const ownTopics = unique(topicTokens(primary)).filter(topic => !frequency.has(topic)).slice(0, 10);
  const primaryOriginality = Math.min(100, 35 + ownTopics.length * 6 + (primary.length > 1200 ? 15 : primary.length > 500 ? 8 : 0));
  const competitorDepth = Math.min(100, Math.round(sources.reduce((sum, source) => sum + Math.min(100, source.headings.length * 5 + source.wordCount / 30), 0) / Math.max(1, sources.length)));
  const keywordCoverage = Math.min(100, Math.round((commonTopics.filter(topic => primaryTokens.has(topic)).length / Math.max(1, commonTopics.length)) * 100));
  const contentGap = Math.max(0, 100 - keywordCoverage);
  const readiness = Math.round(primaryOriginality * .4 + keywordCoverage * .25 + Math.min(100, sources.length * 20) * .2 + (keyword ? 15 : 0));
  const differentiation = unique(["動画・対談で確認できる発言と経験を中心にする", "競合にない自社の判断基準・手順・失敗談を入れる", ...ownTopics.map(topic => `自社一次情報「${topic}」を具体例として使う`)]).slice(0, 8);
  const outline = unique([`${keyword}の結論と読者が最初に知りたいこと`, ...commonTopics.slice(0, 4).map(topic => `${topic}を理解するための要点`), ...gaps.slice(0, 3).map(topic => `${topic}について一次情報で補うポイント`), "自社の動画・経験からわかる独自の判断基準", "実行前のチェックリスト"]);
  return { scores: { keywordCoverage, competitorDepth, primaryOriginality, contentGap, readiness }, commonTopics, gaps, differentiation, outline };
}
const normalized = (value: string) => clean(value).replace(/[\s。、，．！？!?,.・:：;；「」『』（）()【】\[\]]/g, "").toLowerCase();
function overlap(a: string, b: string) { const left = normalized(a), right = normalized(b); if (!left || !right) return 0; const size = 16, chunks = new Set<string>(); for (let i = 0; i <= left.length - size; i += 4) chunks.add(left.slice(i, i + size)); if (!chunks.size) return right.includes(left) ? 1 : 0; let hits = 0; for (const chunk of chunks) if (right.includes(chunk)) hits++; return hits / chunks.size; }
export function createCompetitiveDraft(keyword: string, primary: string, companyContext: string, analysis: Pick<ReturnType<typeof analyzeCompetition>, "outline">, sources: CompetitiveSource[]) {
  const evidence = primary.replace(/\s+/g, " ").trim().slice(0, 5000), paragraphs = evidence.split(/[。！？\n]+/).map(value => value.trim()).filter(Boolean).slice(0, 10);
  const sections = analysis.outline.slice(0, 8).map((heading, index) => index === 0 ? `<h2>${heading}</h2><p>${paragraphs.slice(0, 2).join("。") || "一次情報を追加してください。"}。</p>` : index === analysis.outline.length - 2 ? `<h2>${heading}</h2><p>${paragraphs.slice(2, 6).join("。") || companyContext || "自社の経験・判断基準を追記してください。"}。</p>` : `<h2>${heading}</h2><p>競合ページの表現や事実は転用せず、${keyword}について自社の一次情報で説明するための編集セクションです。公開前に動画内の発言・事例を対応付けてください。</p>`);
  const title = `${keyword}を自社の一次情報からわかりやすく解説`;
  const body = `<p>${companyContext || "この記事"}では、複数の競合記事から共通する検索意図と不足テーマだけを分析し、本文の事実は自社の動画・経験を根拠に構成します。</p>${sections.join("")}<h2>まとめ</h2><p>${keyword}について、競合の文章をコピーせず、自社で確認できる一次情報を中心に整理しました。</p>`;
  const maxOverlap = Math.max(0, ...sources.map(source => overlap(body, source.excerpt)));
  return { title, body, maximumSourceOverlap: Number(maxOverlap.toFixed(3)), originalityScore: Math.max(0, Math.round((1 - maxOverlap) * 100)), plagiarismRisk: maxOverlap >= .28 ? "HIGH" : maxOverlap >= .14 ? "MEDIUM" : "LOW" };
}
