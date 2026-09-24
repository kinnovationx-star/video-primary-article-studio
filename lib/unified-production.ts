import {
  articleDraft,
  id,
  now,
  runtime,
  text,
  wordTokens,
} from "./studio-server";
import {
  getAnthropicApiKey,
  getGoogleAccessToken,
  getOpenAiApiKey,
  getUbersuggestAccessToken,
  getWordPressConnection,
} from "./studio-connections";
import {
  wordpressAuth,
  wordpressBase,
  wordpressCategories,
  type WordPressCategory,
} from "./integrations";
import { rawMcpStructuredValue } from "./serp-provider";
import { UbersuggestMcpClient } from "../cloud-runner/src/ubersuggest-mcp";

type Json = Record<string, unknown>;
type Section = {
  heading: string;
  html: string;
  imagePrompt: string;
  altText: string;
};
type GeneratedArticle = {
  title: string;
  titleTag: string;
  metaDescription: string;
  slug: string;
  mainKeyword: string;
  relatedKeywords: string[];
  searchIntent: string;
  reader: string;
  angle: string;
  catchCopy: string;
  introductionHtml: string;
  sections: Section[];
  conclusionHtml: string;
};
type ImageAsset = {
  bytes: Uint8Array;
  contentType: "image/png" | "image/jpeg";
  extension: "png" | "jpg";
};
type VideoFrameAsset = ImageAsset & {
  timestampSeconds: number;
  sourceDescription: string;
};
type VideoCard = {
  url: string;
  thumbnailUrl: string;
  title: string;
};
type ProductionInput = {
  youtube_url?: unknown;
  youtube_title?: unknown;
  transcript?: unknown;
  direction?: unknown;
  article_limit?: unknown;
  image_count?: unknown;
  wordpress_category_id?: unknown;
  wordpress_category_name?: unknown;
  youtube_description?: unknown;
  youtube_chapters?: unknown;
  challenger_name?: unknown;
  challenger_company?: unknown;
  challenger_role?: unknown;
  special_guest?: unknown;
  mc_name?: unknown;
};

export type YouTubeMetadata = {
  videoId: string;
  title: string;
  description: string;
  chapters: string;
  thumbnailUrl: string;
};

const IMAGE_MODEL = "gpt-image-2.5-sunburst";
const IMAGE_SIZE = "2048x1152";
const brandEnglish = (value: unknown) =>
  String(value ?? "")
    .replace(/A\s+TRUE\s+STORY/gi, "A TRUTH STORY")
    .replace(/ア[・\s]?トゥルー(?:ス)?[・\s]?ストーリー/gi, "A TRUTH STORY")
    .replace(/トゥルース[・\s]?ストーリー/gi, "A TRUTH STORY");
const canonicalChallengerName = (source: {
  challengerRole: string;
  challengerName: string;
}) => {
  const role = source.challengerRole.trim(),
    name = source.challengerName.trim();
  return role && name.startsWith(role) ? name.slice(role.length).trim() : name;
};
const exactIdentity = (source: {
  challengerCompany: string;
  challengerRole: string;
  challengerName: string;
}) =>
  [
    source.challengerCompany,
    source.challengerRole,
    canonicalChallengerName(source),
  ]
    .filter(Boolean)
    .join(" ");

const asRecord = (value: unknown): Json =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : {};
export const sanitizeArticleHtml = (value: unknown) =>
  String(value || "")
    .replace(/<\/?(?:script|style|iframe|object|embed|form)[^>]*>/gi, "")
    .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/javascript:/gi, "")
    .trim();
const escapeHtml = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ] || character,
  );
const slugify = (value: string) =>
  value
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^a-z0-9\u3040-\u30ff\u3400-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 160) || `video-article-${Date.now()}`;
const clamp = (value: unknown, fallback: number) =>
  Math.min(5, Math.max(1, Number(value) || fallback));

async function retry<T>(operation: () => Promise<T>, attempts = 2) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++)
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < attempts)
        await new Promise((resolve) => setTimeout(resolve, attempt * 800));
    }
  throw lastError;
}

function jsonFromText(value: string) {
  const cleaned = value
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const start = cleaned.indexOf("{"),
    end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start)
    throw new Error("AIの記事データを解析できませんでした。");
  return JSON.parse(cleaned.slice(start, end + 1)) as Json;
}

function normalizeArticle(
  value: Json,
  keyword: string,
  index: number,
): GeneratedArticle {
  const sections = (Array.isArray(value.sections) ? value.sections : [])
    .map((item) => {
      const row = asRecord(item),
        heading = text(brandEnglish(row.heading), 120);
      return {
        heading,
        html: sanitizeArticleHtml(brandEnglish(row.html)),
        imagePrompt: text(brandEnglish(row.imagePrompt), 1000),
        altText:
          text(brandEnglish(row.altText), 180) || `${heading}の解説画像`,
      };
    })
    .filter((item) => item.heading && item.html)
    .slice(0, 8);
  if (sections.length < 2)
    throw new Error("AIが十分なH2セクションを生成できませんでした。");
  const title =
    text(brandEnglish(value.title), 160) ||
    `${brandEnglish(keyword)}を動画の一次情報から解説`;
  return {
    title,
    titleTag: (text(brandEnglish(value.titleTag), 80) || title).slice(0, 62),
    metaDescription: text(brandEnglish(value.metaDescription), 180).slice(0, 160),
    slug: slugify(text(value.slug, 180) || `${keyword}-${index + 1}`),
    mainKeyword: text(brandEnglish(value.mainKeyword), 120) || brandEnglish(keyword),
    relatedKeywords: (Array.isArray(value.relatedKeywords)
      ? value.relatedKeywords
      : []
    )
      .map((item) => text(brandEnglish(item), 100))
      .filter(Boolean)
      .slice(0, 10),
    searchIntent: text(brandEnglish(value.searchIntent), 120) || "情報収集",
    reader:
      text(brandEnglish(value.reader), 240) || "動画テーマを詳しく知りたい読者",
    angle:
      text(brandEnglish(value.angle), 300) || "動画内の一次情報を整理して解説",
    catchCopy: text(brandEnglish(value.catchCopy), 200),
    introductionHtml: sanitizeArticleHtml(brandEnglish(value.introductionHtml)),
    sections,
    conclusionHtml: sanitizeArticleHtml(brandEnglish(value.conclusionHtml)),
  };
}

export function youtubeVideoId(value: string) {
  try {
    const url = new URL(value),
      host = url.hostname.replace(/^www\./, "");
    if (host === "youtu.be") return text(url.pathname.split("/")[1], 20);
    if (host.endsWith("youtube.com")) {
      if (url.pathname === "/watch") return text(url.searchParams.get("v"), 20);
      const match = url.pathname.match(/^\/(?:shorts|embed|live)\/([^/?]+)/);
      return text(match?.[1], 20);
    }
  } catch {
    return "";
  }
  return "";
}

function descriptionChapters(description: string) {
  return description
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^(?:\d{1,2}:)?\d{1,2}:\d{2}\s+\S/.test(line))
    .join("\n");
}

export async function getYouTubeMetadata(
  request: Request,
  url: string,
  supplied: Partial<YouTubeMetadata> = {},
): Promise<YouTubeMetadata> {
  const videoId = youtubeVideoId(url);
  if (!videoId) throw new Error("有効なYouTube動画URLを入力してください。");
  let title = text(brandEnglish(supplied.title), 300),
    description = text(brandEnglish(supplied.description), 30000),
    chapters = text(brandEnglish(supplied.chapters), 12000);
  try {
    const token = await getGoogleAccessToken(request),
      response = await fetch(
        `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${encodeURIComponent(videoId)}`,
        {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(20_000),
        },
      ),
      payload = (await response.json().catch(() => ({}))) as Json,
      items = Array.isArray(payload.items) ? payload.items.map(asRecord) : [],
      snippet = asRecord(items[0]?.snippet);
    if (response.ok && snippet.title) {
      title = text(brandEnglish(snippet.title), 300) || title;
      description = text(brandEnglish(snippet.description), 30000) || description;
      chapters = descriptionChapters(description) || chapters;
    }
  } catch {
    /* oEmbed and supplied fields remain available when OAuth is not connected. */
  }
  if (!title)
    try {
      const response = await fetch(
        `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`,
        { signal: AbortSignal.timeout(10_000) },
      );
      if (response.ok)
        title = text(
          brandEnglish(((await response.json()) as Json).title),
          300,
        );
    } catch {
      /* Supplied title remains the safe fallback. */
    }
  return {
    videoId,
    title,
    description,
    chapters,
    thumbnailUrl: `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/maxresdefault.jpg`,
  };
}

function collectKeywords(value: unknown, output: string[] = []): string[] {
  if (output.length >= 20) return output;
  if (Array.isArray(value))
    for (const item of value) collectKeywords(item, output);
  else if (value && typeof value === "object")
    for (const [key, nested] of Object.entries(value as Json)) {
      if (
        /^(?:keyword|query|term|name)$/i.test(key) &&
        typeof nested === "string"
      )
        output.push(text(nested, 120));
      else collectKeywords(nested, output);
    }
  return [...new Set(output.filter((item) => item.length >= 2))].slice(0, 20);
}

async function keywordIdeas(
  title: string,
  direction: string,
  transcript: string,
  count: number,
) {
  const local = wordTokens(
    `${title} ${direction} ${transcript.slice(0, 6000)}`,
  ).slice(0, Math.max(count, 8));
  const seed = text(direction || title || local[0] || "動画内容", 120);
  try {
    const token = await getUbersuggestAccessToken();
    const result = await new UbersuggestMcpClient(token).callKeywordSuggestions(
      seed,
    );
    const live = collectKeywords(rawMcpStructuredValue(result.rawToolResult));
    return {
      keywords: [...new Set([...live, ...local])].slice(0, Math.max(count, 10)),
      provider: "Ubersuggest MCP + 動画一次情報",
    };
  } catch {
    return {
      keywords: local.length ? local : [seed],
      provider: "動画一次情報",
    };
  }
}

async function anthropicModel(apiKey: string) {
  try {
    const response = await fetch(
      "https://api.anthropic.com/v1/models?limit=100",
      {
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (response.ok) {
      const data = (await response.json()) as Json,
        models = Array.isArray(data.data) ? data.data.map(asRecord) : [];
      return text(
        models.find((model) => /sonnet/i.test(String(model.id)))?.id ||
          models[0]?.id,
        120,
      );
    }
  } catch {
    /* Fall through to a stable model identifier. */
  }
  return "claude-sonnet-4-20250514";
}

async function generateArticle(
  apiKey: string,
  model: string,
  source: {
    title: string;
    url: string;
    description: string;
    chapters: string;
    transcript: string;
    direction: string;
    keywords: string[];
    provider: string;
    challengerCompany: string;
    challengerRole: string;
    challengerName: string;
    specialGuest: string;
    mcName: string;
  },
  index: number,
) {
  source.challengerName = canonicalChallengerName(source);
  const focus = source.keywords[index % source.keywords.length] || source.title;
  const identity = exactIdentity(source);
  const prompt = `あなたは校正能力の高い日本語SEO編集者です。次の動画一次情報だけを根拠に、重複しない記事${index + 1}本目（PART ${index + 1}）を作成してください。動画にない数値・人物属性・効果・断定を補ってはいけません。主軸キーワードは「${focus}」。関連候補は ${source.keywords.slice(0, 10).join("、")}（取得元: ${source.provider}）。方向性: ${source.direction || "動画内容を忠実に整理"}\n\n【最優先・固有名詞の正本】\n以下はユーザーが入力欄で登録した確定情報です。文字起こしより常に優先し、表記揺れを推測・補正・別漢字化してはいけません。記事内、SEO情報、画像指示のすべてで一字一句同じ表記を使ってください。\n会社名: ${source.challengerCompany}\n役職: ${source.challengerRole}\n出演者名: ${source.challengerName}\n正式な一組表記: ${identity}\nスペシャルゲスト（入力がある場合だけ使用）: ${source.specialGuest || "なし"}\nMC（入力がある場合だけ使用）: ${source.mcName || "なし"}\n番組名は必ず英語の「A TRUTH STORY」とし、カタカナ表記や「A TRUE STORY」は使いません。\n\n動画タイトル: ${source.title}\n動画URL: ${source.url}\n動画概要（動画投稿者の記載）:\n${source.description.slice(0, 30000) || "取得なし"}\n動画目次・チャプター:\n${source.chapters.slice(0, 12000) || "取得なし"}\n文字起こし（固有名詞は誤変換を含む可能性があるため正本に必ず合わせる）:\n${source.transcript.slice(0, 90000)}\n\n動画概要・目次・文字起こしを相互に照合し、概要と各チャプターの流れを記事構成へ反映してください。出演者を本文で紹介するときは必ず正式な一組表記「${identity}」を使い、文字起こし由来の別表記は使用しません。任意出演者は入力値がある場合だけ記載します。\n\nJSONオブジェクトだけを返してください。キーは title,titleTag,metaDescription,slug,mainKeyword,relatedKeywords,searchIntent,reader,angle,catchCopy,introductionHtml,sections,conclusionHtml。sectionsは3〜6件で、各要素は heading,html,imagePrompt,altText。headingはH2本文のみ（HTMLタグなし）、htmlはp/ul/ol/blockquote/strong/aだけを使う本文。本文には自然な要約・具体例・引用可能な発言・結論を含め、一次情報で確認できないことは書きません。metaDescriptionは90〜140字、titleTagは62字以内。imagePromptには、そのH2に対応する動画内の実際の対談場面として望ましい人物・構図・話題を簡潔に記述します。出力前に、誤字脱字、助詞、英語スペル、会社名、役職、出演者名、A TRUTH STORY表記を必ず再点検し、確定情報と異なる固有名詞をすべて修正してください。`;
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 8000,
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(110_000),
  });
  const payload = (await response.json().catch(() => ({}))) as Json;
  if (!response.ok)
    throw new Error(
      text(
        asRecord(payload.error).message ||
          `Claude APIエラー (${response.status})`,
        240,
      ),
    );
  const content = Array.isArray(payload.content)
    ? payload.content
        .map(asRecord)
        .filter((item) => item.type === "text")
        .map((item) => String(item.text || ""))
        .join("\n")
    : "";
  const article = normalizeArticle(jsonFromText(content), focus, index);
  const profile = `<p class="video-speaker-profile"><strong>出演者：</strong>${escapeHtml(identity)}</p>`;
  if (identity && !article.introductionHtml.includes(escapeHtml(identity)))
    article.introductionHtml = `${profile}${article.introductionHtml}`;
  return article;
}

function bodyHtml(
  article: GeneratedArticle,
  imageUrls: string[],
  video?: VideoCard,
) {
  const sections = article.sections
    .map(
      (section, index) =>
        `<h2>${escapeHtml(section.heading)}</h2>${imageUrls[index + 1] ? `<figure class="video-scene"><img src="${escapeHtml(imageUrls[index + 1])}" alt="${escapeHtml(section.altText)}" width="1280" height="720" loading="lazy" decoding="async" style="display:block;width:100%;max-width:720px;height:auto;aspect-ratio:16/9;object-fit:cover;margin:0 auto" /><figcaption>${escapeHtml(section.altText)}</figcaption></figure>` : ""}${section.html}`,
    )
    .join("");
  const youtubeLink =
    video?.url && video.thumbnailUrl
      ? `<figure class="youtube-video-link" style="margin:40px auto 0;max-width:720px"><a href="${escapeHtml(video.url)}" target="_blank" rel="noopener noreferrer" aria-label="${escapeHtml(video.title)}をYouTubeで見る"><img src="${escapeHtml(video.thumbnailUrl)}" alt="${escapeHtml(video.title)}のYouTubeサムネイル" width="1280" height="720" loading="lazy" decoding="async" style="display:block;width:100%;height:auto;aspect-ratio:16/9;object-fit:cover" /></a><figcaption style="text-align:center"><a href="${escapeHtml(video.url)}" target="_blank" rel="noopener noreferrer">この動画をYouTubeで見る</a></figcaption></figure>`
      : "";
  return `${article.introductionHtml}${sections}${article.conclusionHtml}${youtubeLink}`;
}

function base64Bytes(value: string) {
  const binary = atob(value),
    bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++)
    bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function bytesBase64(bytes: Uint8Array) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

const escapeXml = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[
        character
      ] || character,
  );

function headlineLines(value: string) {
  const cleaned = value.replace(/\s+/g, "").slice(0, 52),
    lines: string[] = [];
  for (let start = 0; start < cleaned.length && lines.length < 4; start += 13)
    lines.push(cleaned.slice(start, start + 13));
  return lines.length ? lines : ["動画で語られた挑戦の物語"];
}

async function applyExactFeaturedTypography(
  image: ImageAsset,
  source: {
    challengerCompany: string;
    challengerRole: string;
    challengerName: string;
    articleIndex: number;
  },
  headline: string,
): Promise<ImageAsset> {
  const images = runtime().IMAGES;
  if (!images) return image;
  const lines = headlineLines(headline),
    title = lines
      .map(
        (line, index) =>
          `<text x="72" y="${350 + index * 92}" class="headline">${escapeXml(line)}</text>`,
      )
      .join(""),
    svg = `<svg xmlns="http://www.w3.org/2000/svg" width="2048" height="1152" viewBox="0 0 2048 1152">
      <image href="data:${image.contentType};base64,${bytesBase64(image.bytes)}" x="0" y="0" width="2048" height="1152" preserveAspectRatio="xMidYMid slice"/>
      <style>
        .serif{font-family:'Noto Serif JP','Yu Mincho','Hiragino Mincho ProN',serif}.sans{font-family:'Noto Sans JP','Yu Gothic','Hiragino Kaku Gothic ProN',sans-serif}.headline{font-family:'Noto Serif JP','Yu Mincho','Hiragino Mincho ProN',serif;font-size:70px;font-weight:700;fill:#102b47}.meta{font-family:'Noto Sans JP','Yu Gothic','Hiragino Kaku Gothic ProN',sans-serif;fill:#102b47;font-weight:700}
      </style>
      <path d="M0 0H1035L920 1152H0Z" fill="#fffdfa" fill-opacity=".94"/>
      <path d="M0 58H850L790 235H0Z" fill="#102b47"/>
      <text x="72" y="155" class="serif" font-size="76" font-weight="700" fill="#fff7df">経営者インタビュー</text>
      <text x="74" y="210" class="serif" font-size="32" letter-spacing="14" fill="#d7b55b">interview</text>
      ${title}
      <line x1="72" y1="${390 + lines.length * 92}" x2="790" y2="${390 + lines.length * 92}" stroke="#c5a34e" stroke-width="3"/>
      <text x="72" y="${470 + lines.length * 92}" class="meta" font-size="34">${escapeXml(source.challengerCompany)}</text>
      <text x="72" y="${525 + lines.length * 92}" class="meta" font-size="34">${escapeXml(source.challengerRole)}</text>
      <text x="72" y="${620 + lines.length * 92}" class="serif" font-size="76" font-weight="700" fill="#102b47">${escapeXml(canonicalChallengerName(source))}</text>
      <path d="M0 1030H945L865 1152H0Z" fill="#102b47"/>
      <text x="72" y="1110" class="serif" font-size="44" font-weight="700" letter-spacing="7" fill="#fff7df">A TRUTH STORY</text>
      <path d="M760 1030H1110L1030 1152H680Z" fill="#d7b55b"/>
      <text x="790" y="1110" class="serif" font-size="42" font-weight="700" fill="#102b47">PART ${source.articleIndex + 1}</text>
    </svg>`,
    imageBuffer = image.bytes.buffer.slice(
      image.bytes.byteOffset,
      image.bytes.byteOffset + image.bytes.byteLength,
    ) as ArrayBuffer;
  try {
    const transformed = await images
        .input(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }).stream())
        .output({ format: "image/png" }),
      response = transformed.response();
    if (!response.ok)
      throw new Error(`画像文字組みエラー (${response.status})`);
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      contentType: "image/png",
      extension: "png",
    };
  } catch (combinedError) {
    try {
      const transformed = await images
          .input(new Blob([imageBuffer], { type: image.contentType }).stream())
          .draw(
            new Blob([svg], { type: "image/svg+xml;charset=utf-8" }).stream(),
          )
          .output({ format: "image/png" }),
        response = transformed.response();
      if (!response.ok)
        throw new Error(`画像文字組みエラー (${response.status})`);
      return {
        bytes: new Uint8Array(await response.arrayBuffer()),
        contentType: "image/png",
        extension: "png",
      };
    } catch (drawError) {
      console.error("featured typography overlay failed", {
        combinedError: String(combinedError),
        drawError: String(drawError),
      });
      return image;
    }
  }
}

async function generateImages(
  apiKey: string,
  articleId: string,
  article: GeneratedArticle,
  count: number,
  source: {
    thumbnailUrl: string;
    videoId: string;
    articleIndex: number;
    articleCount: number;
    challengerCompany: string;
    challengerRole: string;
    challengerName: string;
  },
) {
  if (!apiKey)
    return {
      images: [] as Array<{
        id: string;
        kind: string;
        heading: string;
        alt: string;
        key: string;
        url: string;
        contentType: "image/png" | "image/jpeg";
        extension: "png" | "jpg";
      }>,
      warning: "OpenAI未接続のため画像生成はスキップしました。",
    };
  const prompts = [
    {
      kind: "featured",
      heading: article.title,
      alt: `${article.title}｜${exactIdentity(source)}｜A TRUTH STORY PART ${source.articleIndex + 1}`,
      prompt: `動画内の実写フレームを元に、${exactIdentity(source)}を正確に表記した経営者インタビューのファーストビュー画像（A TRUTH STORY / PART ${source.articleIndex + 1}）`,
    },
    ...article.sections.map((section) => ({
      kind: "section",
      heading: section.heading,
      alt: section.altText,
      prompt: `動画内の実際の対談場面。記事セクション「${section.heading}」に対応する実写フレーム（各セクション最大1枚）。`,
    })),
  ].slice(0, count);
  const images: Array<{
    id: string;
    kind: string;
    heading: string;
    alt: string;
    key: string;
    url: string;
    contentType: "image/png" | "image/jpeg";
    extension: "png" | "jpg";
  }> = [];
  for (let index = 0; index < prompts.length; index++) {
    const item = prompts[index],
      asset =
        item.kind === "featured"
          ? await createFeaturedImageAsset(apiKey, source, article)
          : await youtubeVideoFrame(
              source.videoId,
              Math.min(
                0.95,
                Math.max(
                  0.05,
                  (source.articleIndex + index / Math.max(2, prompts.length)) /
                    Math.max(1, source.articleCount),
                ),
              ),
            );
    const imageId = id(),
      key = `articles/${articleId}/${item.kind}-${index}.${asset.extension}`;
    await runtime().FILES.put(key, asset.bytes, {
      httpMetadata: {
        contentType: asset.contentType,
        cacheControl: "public, max-age=31536000, immutable",
      },
    });
    await runtime()
      .DB.prepare(
        "INSERT INTO article_images (id,article_id,kind,section_heading,alt_text,prompt,object_key,created_at) VALUES (?,?,?,?,?,?,?,?)",
      )
      .bind(
        imageId,
        articleId,
        item.kind,
        item.heading,
        item.alt,
        item.prompt,
        key,
        now(),
      )
      .run();
    images.push({
      id: imageId,
      kind: item.kind,
      heading: item.heading,
      alt: item.alt,
      key,
      url: `/api/media/${imageId}`,
      contentType: asset.contentType,
      extension: asset.extension,
    });
  }
  return { images, warning: "" };
}

async function wordpressRequest(url: string, init: RequestInit) {
  const response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(60_000),
    }),
    payload = (await response.json().catch(() => ({}))) as Json;
  if (!response.ok)
    throw new Error(
      text(payload.message || `WordPress APIエラー (${response.status})`, 240),
    );
  return payload;
}

async function publishDraft(
  connection: NonNullable<Awaited<ReturnType<typeof getWordPressConnection>>>,
  article: GeneratedArticle,
  html: string,
  categoryId: string,
  images: Awaited<ReturnType<typeof generateImages>>["images"],
  video: VideoCard,
) {
  if (connection.authMode !== "rest")
    throw new Error(
      "画像・カテゴリー付き自動下書きにはWordPress REST API接続が必要です。",
    );
  const base = wordpressBase(connection.siteUrl),
    authorization = wordpressAuth(
      connection.username,
      connection.applicationPassword,
    ),
    mediaIds: number[] = [],
    uploadedUrls: string[] = [];
  for (let index = 0; index < images.length; index++) {
    const image = images[index],
      object = await runtime().FILES.get(image.key);
    if (!object) continue;
    const uploaded = await wordpressRequest(`${base}/wp-json/wp/v2/media`, {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": image.contentType,
        "Content-Disposition": `attachment; filename="${article.slug}-${index + 1}.${image.extension}"`,
      },
      body: await object.arrayBuffer(),
    });
    const mediaId = Number(uploaded.id || 0),
      sourceUrl = text(uploaded.source_url, 1000);
    if (mediaId) {
      mediaIds.push(mediaId);
      uploadedUrls.push(sourceUrl);
      await wordpressRequest(`${base}/wp-json/wp/v2/media/${mediaId}`, {
        method: "POST",
        headers: {
          Authorization: authorization,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          alt_text: image.alt,
          caption: image.kind === "featured" ? article.title : image.heading,
        }),
      });
      await runtime()
        .DB.prepare(
          "UPDATE article_images SET wordpress_media_id=?,wordpress_url=? WHERE id=?",
        )
        .bind(String(mediaId), sourceUrl, image.id)
        .run();
    }
  }
  const wpHtml = bodyHtml(article, uploadedUrls, video),
    created = await wordpressRequest(`${base}/wp-json/wp/v2/posts`, {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title: article.title,
        content: wpHtml || html,
        status: "draft",
        slug: article.slug,
        excerpt: article.metaDescription,
        categories: categoryId ? [Number(categoryId)] : [],
        featured_media: mediaIds[0] || 0,
      }),
    });
  const postId = text(created.id, 80);
  return {
    postId,
    editUrl: postId
      ? `${base}/wp-admin/post.php?post=${postId}&action=edit`
      : "",
    previewUrl: postId ? `${base}/?p=${postId}&preview=true` : "",
    html: wpHtml || html,
    featuredUrl: uploadedUrls[0] || "",
    uploadedUrls,
  };
}

export async function updateWordPressDraft(article: Record<string, unknown>) {
  const connection = await getWordPressConnection(),
    postId = text(article.wordpress_post_id, 80);
  if (!connection || !postId)
    return {
      updated: false,
      reason: "WordPress下書き未連携",
      editUrl: "",
      previewUrl: "",
    };
  if (connection.authMode !== "rest")
    throw new Error("WordPress下書きの更新にはREST API接続が必要です。");
  const base = wordpressBase(connection.siteUrl),
    authorization = wordpressAuth(
      connection.username,
      connection.applicationPassword,
    ),
    categoryId = Number(article.category_id || 0);
  await wordpressRequest(`${base}/wp-json/wp/v2/posts/${postId}`, {
    method: "POST",
    headers: {
      Authorization: authorization,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      title: text(article.title, 500),
      content: sanitizeArticleHtml(article.body_html),
      status: "draft",
      slug: text(article.slug, 180),
      excerpt: text(article.meta_description, 1000),
      categories: categoryId ? [categoryId] : [],
    }),
  });
  return {
    updated: true,
    editUrl: `${base}/wp-admin/post.php?post=${postId}&action=edit`,
    previewUrl: `${base}/?p=${postId}&preview=true`,
  };
}

export async function getLiveWordPressCategories() {
  const connection = await getWordPressConnection();
  if (!connection)
    return { connected: false, categories: [] as WordPressCategory[] };
  if (connection.authMode !== "rest")
    return {
      connected: true,
      categories: [] as WordPressCategory[],
      warning: "カテゴリー同期にはWordPress REST API接続が必要です。",
    };
  return {
    connected: true,
    categories: await wordpressCategories(
      connection.siteUrl,
      connection.username,
      connection.applicationPassword,
    ),
  };
}

export async function getArticleImage(imageId: string) {
  const row = await runtime()
    .DB.prepare("SELECT object_key FROM article_images WHERE id=?")
    .bind(imageId)
    .first<{ object_key: string }>();
  return row?.object_key ? runtime().FILES.get(row.object_key) : null;
}

export async function getArticleImages(articleId: string) {
  const result = await runtime()
    .DB.prepare(
      "SELECT id,kind,section_heading,alt_text,prompt,wordpress_url,created_at FROM article_images WHERE article_id=? ORDER BY created_at DESC",
    )
    .bind(articleId)
    .all();
  const seen = new Set<string>();
  return (result.results as Array<Record<string, unknown>>)
    .filter((image) => {
      const key = `${image.kind}:${image.section_heading}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((image) => ({
      ...image,
      url: text(image.wordpress_url, 1000) || `/api/media/${image.id}`,
    }));
}

async function claudeJson(apiKey: string, prompt: string) {
  const model = await anthropicModel(apiKey),
    response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 5000,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(110_000),
    }),
    payload = (await response.json().catch(() => ({}))) as Json;
  if (!response.ok)
    throw new Error(
      text(
        asRecord(payload.error).message ||
          `Claude APIエラー (${response.status})`,
        240,
      ),
    );
  const content = Array.isArray(payload.content)
    ? payload.content
        .map(asRecord)
        .filter((item) => item.type === "text")
        .map((item) => String(item.text || ""))
        .join("\n")
    : "";
  return { model, value: jsonFromText(content) };
}

export async function regenerateArticleSection(
  articleId: string,
  heading: string,
  currentHtml: string,
  instruction: string,
) {
  const row = await runtime()
    .DB.prepare(
      "SELECT a.title,a.main_keyword,p.youtube_title,p.youtube_url,p.transcript,p.challenger_company,p.challenger_role,p.challenger_name FROM articles a JOIN production_projects p ON p.id=a.project_id WHERE a.id=?",
    )
    .bind(articleId)
    .first<Record<string, unknown>>();
  if (!row) throw new Error("記事が見つかりません。");
  const apiKey = await getAnthropicApiKey();
  if (!apiKey) throw new Error("Claude APIを連携設定で接続してください。");
  const identity = [
      text(row.challenger_company, 240),
      text(row.challenger_role, 160),
      text(row.challenger_name, 160),
    ]
      .filter(Boolean)
      .join(" "),
    prompt = `日本語SEO記事のH2セクションを再生成してください。動画の文字起こしだけを根拠にし、存在しない事実・数値・効果を追加しないでください。\n記事タイトル: ${text(row.title, 300)}\n主軸キーワード: ${text(row.main_keyword, 160)}\n対象H2: ${text(heading, 200)}\n現在の本文: ${text(currentHtml, 12000)}\n追加指示: ${text(instruction, 1000) || "読みやすく具体的に改善"}\n動画タイトル: ${text(row.youtube_title, 300)}\n動画URL: ${text(row.youtube_url, 1000)}\n【固有名詞の正本】${identity}\n文字起こしに異なる漢字・表記があっても無視し、会社名・役職・氏名は必ず正本と一字一句同じにしてください。番組名は必ず「A TRUTH STORY」です。\n文字起こし: ${text(row.transcript, 90000)}\nJSONだけを返してください。キーは heading,html,imagePrompt,altText。htmlはp,h3,ul,ol,blockquote,strong,aのみを使ってください。imagePromptには対象H2に対応する動画内の実際の対談場面として望ましい話題と人物を簡潔に書いてください。出力前に誤字脱字、英語スペル、固有名詞を校正してください。`;
  const generated = await claudeJson(apiKey, prompt),
    value = generated.value;
  return {
    heading: text(value.heading, 160) || heading,
    html: sanitizeArticleHtml(value.html),
    imagePrompt: text(value.imagePrompt, 1000),
    altText: text(value.altText, 180),
    provider: generated.model,
  };
}

async function youtubeThumbnailBytes(thumbnailUrl: string, videoId: string) {
  const urls = [
    thumbnailUrl,
    `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/sddefault.jpg`,
    `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/hqdefault.jpg`,
  ];
  for (const url of urls) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(20_000),
      });
      if (
        response.ok &&
        /image\/(?:jpeg|png|webp)/i.test(response.headers.get("content-type") || "")
      )
        return {
          bytes: new Uint8Array(await response.arrayBuffer()),
          contentType: response.headers.get("content-type") || "image/jpeg",
        };
    } catch {
      /* Try the next official thumbnail resolution. */
    }
  }
  throw new Error("YouTubeサムネイル画像を取得できませんでした。");
}

function decodeStoryboardSpec(value: string) {
  try {
    return JSON.parse(`"${value}"`) as string;
  } catch {
    return value.replace(/\\u0026/g, "&").replace(/\\\//g, "/");
  }
}

async function youtubeVideoFrame(
  videoId: string,
  ratio: number,
): Promise<VideoFrameAsset> {
  try {
    const watch = await fetch(
      `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&hl=ja`,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/128 Safari/537.36",
          "Accept-Language": "ja,en;q=0.8",
        },
        signal: AbortSignal.timeout(25_000),
      },
    );
    const html = await watch.text(),
      match = html.match(
        /"storyboards":\{"playerStoryboardSpecRenderer":\{"spec":"((?:\\.|[^"\\])*)"/,
      );
    if (!watch.ok || !match?.[1]) throw new Error("storyboard unavailable");
    const parts = decodeStoryboardSpec(match[1]).split("|"),
      base = parts[0],
      levels = parts.slice(1);
    if (!base || !levels.length) throw new Error("storyboard spec invalid");
    const levelIndex = levels.length - 1,
      fields = levels[levelIndex].split("#"),
      width = Number(fields[0]),
      height = Number(fields[1]),
      count = Number(fields[2]),
      columns = Number(fields[3]),
      rows = Number(fields[4]),
      intervalMs = Number(fields[5]),
      nameTemplate = fields[6],
      signature = fields.slice(7).join("#");
    if (
      !width ||
      !height ||
      !count ||
      !columns ||
      !rows ||
      !nameTemplate ||
      !signature
    )
      throw new Error("storyboard level invalid");
    const safeRatio = Math.min(0.95, Math.max(0.05, ratio)),
      frameIndex = Math.min(count - 1, Math.floor(count * safeRatio)),
      perSheet = columns * rows,
      sheetIndex = Math.floor(frameIndex / perSheet),
      tileIndex = frameIndex % perSheet,
      column = tileIndex % columns,
      row = Math.floor(tileIndex / columns),
      sheetName = nameTemplate.replace(/\$M/g, String(sheetIndex)),
      sheetUrl = `${base.replace(/\$L/g, String(levelIndex)).replace(/\$N/g, sheetName)}&sigh=${signature}`,
      top = row * height,
      left = column * width,
      right = columns * width - left - width,
      bottom = rows * height - top - height,
      response = await fetch(
        sheetUrl,
        {
          cf: {
            image: {
              trim: { top, right, bottom, left },
              width: 1280,
              height: 720,
              fit: "cover",
              format: "jpeg",
              quality: 90,
              upscale: "generate",
            },
          },
          signal: AbortSignal.timeout(45_000),
        } as unknown as RequestInit,
      );
    const contentType = response.headers.get("content-type") || "";
    if (!response.ok || !/image\/jpeg/i.test(contentType))
      throw new Error("storyboard crop unavailable");
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      contentType: "image/jpeg",
      extension: "jpg",
      timestampSeconds: Math.round((frameIndex * intervalMs) / 1000),
      sourceDescription: `動画内 ${Math.round((frameIndex * intervalMs) / 1000)} 秒の実写フレーム`,
    };
  } catch {
    const thumbnail = await youtubeThumbnailBytes(
      `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/maxresdefault.jpg`,
      videoId,
    );
    return {
      bytes: thumbnail.bytes,
      contentType: "image/jpeg",
      extension: "jpg",
      timestampSeconds: 0,
      sourceDescription: "動画フレーム取得不可のため公式YouTube画像を使用",
    };
  }
}

async function createFeaturedImageAsset(
  apiKey: string,
  source: {
    videoId: string;
    articleIndex: number;
    articleCount: number;
    challengerCompany: string;
    challengerRole: string;
    challengerName: string;
  },
  article: Pick<GeneratedArticle, "title" | "catchCopy">,
): Promise<ImageAsset> {
  source.challengerName = canonicalChallengerName(source);
  const frame = await youtubeVideoFrame(
      source.videoId,
      (source.articleIndex + 0.5) / Math.max(1, source.articleCount),
    ),
    headline = article.catchCopy || article.title,
    form = new FormData();
  form.append("model", IMAGE_MODEL);
  form.append(
    "prompt",
    `アップロード画像はYouTube動画内から取得した実際の対談フレームです。この実写フレームを写真素材として使い、経営者インタビュー記事の洗練された16:9横長背景を作ってください。出演者本人の顔立ち、年齢、髪型、表情、服装、肌の色、本人性を変えず、架空の人物を追加しないでください。写真は自然で高品質に補正し、話している経営者または出演者が右側に明瞭に見えるトリミングにします。左側は暖かい白・ベージュの十分な余白、右側は実写人物、紺とゴールドを控えめなアクセントにした信頼感のある編集背景にします。文字、ロゴ、記号、透かしは一切描かないでください。確定した日本語文字は後工程で正確に合成します。`,
  );
  form.append(
    "image[]",
    new Blob(
      [
        frame.bytes.buffer.slice(
          frame.bytes.byteOffset,
          frame.bytes.byteOffset + frame.bytes.byteLength,
        ) as ArrayBuffer,
      ],
      { type: frame.contentType },
    ),
    `video-frame.${frame.extension}`,
  );
  form.append("n", "1");
  form.append("size", IMAGE_SIZE);
  form.append("quality", "max");
  form.append("output_format", "png");
  const response = await fetch("https://api.openai.com/v1/images/edits", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(110_000),
    }),
    payload = (await response.json().catch(() => ({}))) as Json,
    data = Array.isArray(payload.data) ? payload.data.map(asRecord) : [],
    encoded = text(data[0]?.b64_json, 20_000_000);
  if (!response.ok || !encoded)
    throw new Error(
      text(
        asRecord(payload.error).message ||
          `ファーストビュー画像編集APIエラー (${response.status})`,
        240,
      ),
    );
  return applyExactFeaturedTypography({
    bytes: base64Bytes(encoded),
    contentType: "image/png",
    extension: "png",
  }, source, headline);
}

function replaceSectionImage(
  html: string,
  heading: string,
  url: string,
  alt: string,
) {
  const headingText = escapeHtml(heading),
    marker = `<h2>${headingText}</h2>`,
    image = `<figure class="video-scene"><img src="${escapeHtml(url)}" alt="${escapeHtml(alt)}" width="1280" height="720" loading="lazy" decoding="async" style="display:block;width:100%;max-width:720px;height:auto;aspect-ratio:16/9;object-fit:cover;margin:0 auto" /><figcaption>${escapeHtml(alt)}</figcaption></figure>`;
  const start = html.indexOf(marker);
  if (start < 0) return html;
  const contentStart = start + marker.length,
    nextHeading = html.indexOf("<h2", contentStart),
    end = nextHeading < 0 ? html.length : nextHeading,
    section = html.slice(contentStart, end),
    replaced = /<figure\b[\s\S]*?<\/figure>/i.test(section)
      ? section.replace(/<figure\b[\s\S]*?<\/figure>/i, image)
      : `${image}${section}`;
  return `${html.slice(0, contentStart)}${replaced}${html.slice(end)}`;
}

export async function regenerateArticleImage(
  articleId: string,
  options: {
    kind?: unknown;
    heading?: unknown;
    prompt?: unknown;
    altText?: unknown;
    sectionIndex?: unknown;
  },
) {
  const article = await runtime()
    .DB.prepare(
      "SELECT a.*,p.youtube_url,p.challenger_company,p.challenger_role,p.challenger_name FROM articles a JOIN production_projects p ON p.id=a.project_id WHERE a.id=?",
    )
    .bind(articleId)
    .first<Record<string, unknown>>();
  if (!article) throw new Error("記事が見つかりません。");
  const kind = options.kind === "featured" ? "featured" : "section",
    heading = text(options.heading, 200),
    altText =
      text(options.altText, 180) ||
      (kind === "featured"
        ? `${article.title}のアイキャッチ画像`
        : `${heading}の解説画像`),
    prompt =
      text(options.prompt, 1200) ||
      (kind === "featured"
        ? `動画内の実写フレームを使った経営者インタビューのファーストビュー画像`
        : `H2「${heading}」に対応する動画内の実際の対談場面`),
    imageId = id(),
    stamp = now(),
    videoId = youtubeVideoId(text(article.youtube_url, 1000));
  if (!videoId)
    throw new Error("元動画のYouTube URLから動画フレームを特定できません。");
  const related = await runtime()
      .DB.prepare("SELECT id FROM articles WHERE project_id=? ORDER BY rowid")
      .bind(text(article.project_id, 80))
      .all<{ id: string }>(),
    articleIds = related.results.map((row) => row.id),
    articleIndex = Math.max(0, articleIds.indexOf(articleId)),
    articleCount = Math.max(1, articleIds.length);
  let asset: ImageAsset;
  if (kind === "featured") {
    const apiKey = await getOpenAiApiKey();
    if (!apiKey)
      throw new Error("OpenAI GPT Imageを連携設定で接続してください。");
    asset = await createFeaturedImageAsset(
      apiKey,
      {
        videoId,
        articleIndex,
        articleCount,
        challengerCompany: text(article.challenger_company, 240),
        challengerRole: text(article.challenger_role, 160),
        challengerName: text(article.challenger_name, 160),
      },
      {
        title: text(article.title, 300),
        catchCopy: text(article.catch_copy, 300),
      },
    );
  } else {
    const sectionIndex = Math.max(0, Number(options.sectionIndex) || 0);
    asset = await youtubeVideoFrame(
      videoId,
      Math.min(
        0.95,
        Math.max(
          0.05,
          (articleIndex + (sectionIndex + 1) / 7) / articleCount,
        ),
      ),
    );
  }
  const key = `articles/${articleId}/${kind}-${Date.now()}.${asset.extension}`;
  await runtime().FILES.put(
    key,
    asset.bytes,
    {
      httpMetadata: {
        contentType: asset.contentType,
        cacheControl: "public, max-age=31536000, immutable",
      },
    },
  );
  await runtime()
    .DB.prepare(
      "INSERT INTO article_images (id,article_id,kind,section_heading,alt_text,prompt,object_key,created_at) VALUES (?,?,?,?,?,?,?,?)",
    )
    .bind(imageId, articleId, kind, heading, altText, prompt, key, stamp)
    .run();
  let displayUrl = `/api/media/${imageId}`,
    wordpressMediaId = "";
  const connection = await getWordPressConnection(),
    postId = text(article.wordpress_post_id, 80);
  if (connection && postId && connection.authMode === "rest") {
    const base = wordpressBase(connection.siteUrl),
      authorization = wordpressAuth(
        connection.username,
        connection.applicationPassword,
      ),
      object = await runtime().FILES.get(key);
    if (object) {
      const uploaded = await wordpressRequest(`${base}/wp-json/wp/v2/media`, {
        method: "POST",
        headers: {
          Authorization: authorization,
          "Content-Type": asset.contentType,
          "Content-Disposition": `attachment; filename="${text(article.slug, 120) || "article"}-${kind}-${Date.now()}.${asset.extension}"`,
        },
        body: await object.arrayBuffer(),
      });
      wordpressMediaId = text(uploaded.id, 80);
      displayUrl = text(uploaded.source_url, 1000) || displayUrl;
      if (wordpressMediaId)
        await wordpressRequest(
          `${base}/wp-json/wp/v2/media/${wordpressMediaId}`,
          {
            method: "POST",
            headers: {
              Authorization: authorization,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              alt_text: altText,
              caption: heading || article.title,
            }),
          },
        );
    }
  }
  if (kind === "featured") {
    await runtime()
      .DB.prepare(
        "UPDATE articles SET featured_image_url=?,updated_at=? WHERE id=?",
      )
      .bind(displayUrl, stamp, articleId)
      .run();
    if (connection && postId && wordpressMediaId)
      await wordpressRequest(
        `${wordpressBase(connection.siteUrl)}/wp-json/wp/v2/posts/${postId}`,
        {
          method: "POST",
          headers: {
            Authorization: wordpressAuth(
              connection.username,
              connection.applicationPassword,
            ),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            featured_media: Number(wordpressMediaId),
            status: "draft",
          }),
        },
      );
  } else {
    const index = Math.max(0, Number(options.sectionIndex) || 0),
      sectionImages = (() => {
        try {
          const value = JSON.parse(text(article.section_images_json, 20000));
          return Array.isArray(value) ? value : [];
        } catch {
          return [];
        }
      })();
    sectionImages[index] = displayUrl;
    const html = replaceSectionImage(
      text(article.body_html, 180000),
      heading,
      displayUrl,
      altText,
    );
    await runtime()
      .DB.prepare(
        "UPDATE articles SET body_html=?,section_images_json=?,updated_at=? WHERE id=?",
      )
      .bind(html, JSON.stringify(sectionImages), stamp, articleId)
      .run();
    if (connection && postId)
      await wordpressRequest(
        `${wordpressBase(connection.siteUrl)}/wp-json/wp/v2/posts/${postId}`,
        {
          method: "POST",
          headers: {
            Authorization: wordpressAuth(
              connection.username,
              connection.applicationPassword,
            ),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ content: html, status: "draft" }),
        },
      );
  }
  await runtime()
    .DB.prepare(
      "UPDATE article_images SET wordpress_media_id=?,wordpress_url=? WHERE id=?",
    )
    .bind(
      wordpressMediaId || null,
      displayUrl.startsWith("http") ? displayUrl : "",
      imageId,
    )
    .run();
  return {
    id: imageId,
    kind,
    section_heading: heading,
    alt_text: altText,
    prompt,
    url: displayUrl,
    wordpress_media_id: wordpressMediaId,
  };
}

export async function createUnifiedProduction(
  input: ProductionInput,
  request: Request,
) {
  const transcript = text(input.transcript, 120000),
    url = text(input.youtube_url, 1000),
    direction = text(brandEnglish(input.direction), 1000),
    challengerCompany = text(brandEnglish(input.challenger_company), 300),
    challengerRole = text(brandEnglish(input.challenger_role), 300),
    challengerName = text(brandEnglish(input.challenger_name), 300),
    specialGuest = text(brandEnglish(input.special_guest), 500),
    mcName = text(brandEnglish(input.mc_name), 500);
  if (transcript.length < 80)
    throw new Error("80文字以上の文字起こしを入力してください。");
  if (!url) throw new Error("YouTube動画URLを入力してください。");
  if (!challengerCompany || !challengerRole || !challengerName)
    throw new Error(
      "挑戦者の会社名・役職・出演者名をすべて入力してください。",
    );
  const articleCount = clamp(input.article_limit, 1),
    imageCount = clamp(input.image_count, 1),
    metadata = await getYouTubeMetadata(request, url, {
      title: text(input.youtube_title, 300),
      description: text(input.youtube_description, 30000),
      chapters: text(input.youtube_chapters, 12000),
    }),
    title = metadata.title;
  if (!title)
    throw new Error(
      "動画タイトルを取得できませんでした。動画タイトルを入力してください。",
    );
  const categoryId = text(input.wordpress_category_id, 80),
    categoryName = text(input.wordpress_category_name, 200),
    stamp = now();
  const keywords = await keywordIdeas(
      title,
      direction,
      transcript,
      articleCount,
    ),
    anthropicKey = await getAnthropicApiKey();
  if (!anthropicKey)
    throw new Error("記事生成に必要なClaude APIを連携設定で接続してください。");
  const model = await anthropicModel(anthropicKey),
    openAiKey = await getOpenAiApiKey(),
    wordpress = await getWordPressConnection();
  if (!openAiKey)
    throw new Error(
      "アイキャッチ画像・H2図解の生成に必要なOpenAI GPT Imageを連携設定で接続してください。",
    );
  if (wordpress && !categoryId)
    throw new Error("WordPressの投稿カテゴリーを選択してください。");
  type ResumeRow = {
    id: string;
    title: string;
    wordpress_status: string;
    wordpress_preview_url: string;
    wordpress_edit_url: string;
    image_count: number;
  };
  const resumableProject = await runtime()
      .DB.prepare(
        "SELECT id FROM production_projects WHERE youtube_url=? AND article_limit=? AND status='GENERATING' ORDER BY created_at DESC LIMIT 1",
      )
      .bind(url, articleCount)
      .first<{ id: string }>(),
    previous = resumableProject
      ? await runtime()
          .DB.prepare(
            "SELECT a.id,a.title,a.wordpress_status,a.wordpress_preview_url,a.wordpress_edit_url,(SELECT COUNT(*) FROM article_images i WHERE i.article_id=a.id) AS image_count FROM articles a WHERE a.project_id=? ORDER BY a.rowid",
          )
          .bind(resumableProject.id)
          .all<ResumeRow>()
      : { results: [] as ResumeRow[] },
    canResume =
      previous.results.length > 0 &&
      previous.results.length < articleCount &&
      previous.results.every(
        (article) =>
          Number(article.image_count) >= imageCount &&
          (!wordpress ||
            (article.wordpress_status === "DRAFT" &&
              Boolean(
                article.wordpress_preview_url || article.wordpress_edit_url,
              ))),
      ),
    projectId = canResume ? resumableProject!.id : id(),
    resumeRows = canResume ? previous.results : [];
  if (canResume)
    await runtime().DB.batch([
      runtime()
        .DB.prepare(
          "UPDATE production_projects SET youtube_title=?,youtube_description=?,youtube_chapters=?,transcript=?,transcript_chars=?,direction=?,challenger_name=?,challenger_company=?,challenger_role=?,special_guest=?,mc_name=?,image_count=?,wordpress_category_id=?,wordpress_category_name=?,updated_at=? WHERE id=?",
        )
        .bind(
          title,
          metadata.description,
          metadata.chapters,
          transcript,
          transcript.length,
          direction,
          challengerName,
          challengerCompany,
          challengerRole,
          specialGuest,
          mcName,
          imageCount,
          categoryId,
          categoryName,
          stamp,
          projectId,
        ),
      runtime()
        .DB.prepare("UPDATE articles SET batch_ready=0 WHERE project_id=?")
        .bind(projectId),
    ]);
  else
    await runtime()
      .DB.prepare(
        "INSERT INTO production_projects (id,youtube_url,youtube_title,youtube_description,youtube_chapters,transcript,transcript_chars,direction,challenger_name,challenger_company,challenger_role,special_guest,mc_name,strict_evidence,image_suggestions,article_limit,image_count,wordpress_category_id,wordpress_category_name,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .bind(
        projectId,
        url,
        title,
        metadata.description,
        metadata.chapters,
        transcript,
        transcript.length,
        direction,
        challengerName,
        challengerCompany,
        challengerRole,
        specialGuest,
        mcName,
        1,
        1,
        articleCount,
        imageCount,
        categoryId,
        categoryName,
        "GENERATING",
        stamp,
        stamp,
      )
      .run();
  const results: Array<{
      id: string;
      title: string;
      wordpressStatus: string;
      imageCount: number;
      wordpressPreviewUrl: string;
      wordpressEditUrl: string;
    }> = [],
    warnings: string[] = [];
  results.push(
    ...resumeRows.map((article) => ({
      id: article.id,
      title: article.title,
      wordpressStatus: article.wordpress_status,
      imageCount: Number(article.image_count),
      wordpressPreviewUrl: article.wordpress_preview_url,
      wordpressEditUrl: article.wordpress_edit_url,
    })),
  );
  try {
    const completed = await Promise.all(
      Array.from(
        { length: articleCount - resumeRows.length },
        async (_, offset) => {
        const index = resumeRows.length + offset;
        const generated = await retry(
            () =>
              generateArticle(
                anthropicKey,
                model,
                {
                  title,
                  url,
                  description: metadata.description,
                  chapters: metadata.chapters,
                  transcript,
                  direction,
                  keywords: keywords.keywords,
                  provider: keywords.provider,
                  challengerCompany,
                  challengerRole,
                  challengerName,
                  specialGuest,
                  mcName,
                },
                index,
              ),
            2,
          ),
          articleId = id(),
          candidateId = id();
        await runtime()
          .DB.prepare(
            "INSERT INTO keyword_candidates (id,project_id,keyword,related_keywords,search_intent,reader,angle,relevance,duplication_risk,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
          )
          .bind(
            candidateId,
            projectId,
            generated.mainKeyword,
            JSON.stringify(generated.relatedKeywords),
            generated.searchIntent,
            generated.reader,
            generated.angle,
            keywords.provider,
            "low",
            "CREATED",
            stamp,
          )
          .run();
        const videoCard: VideoCard = {
            url,
            thumbnailUrl: metadata.thumbnailUrl,
            title,
          },
          initialHtml = bodyHtml(generated, [], videoCard),
          evidence = JSON.stringify([
            {
              source: url,
              title,
              videoId: metadata.videoId,
              descriptionCharacters: metadata.description.length,
              chapters: metadata.chapters.split(/\r?\n/).filter(Boolean)
                .length,
              transcriptCharacters: transcript.length,
              challenger: {
                company: challengerCompany,
                role: challengerRole,
                name: challengerName,
              },
              specialGuest,
              mc: mcName,
            },
          ]);
        await runtime()
          .DB.prepare(
            "INSERT INTO articles (id,project_id,candidate_id,title,title_tag,meta_description,slug,catch_copy,main_keyword,related_keywords,search_intent,reader,angle,category_id,category_name,body_html,evidence_json,image_suggestions_json,quality_json,status,wordpress_status,featured_image_url,section_images_json,generation_provider,batch_ready,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
          )
          .bind(
            articleId,
            projectId,
            candidateId,
            generated.title,
            generated.titleTag,
            generated.metaDescription,
            generated.slug,
            generated.catchCopy,
            generated.mainKeyword,
            JSON.stringify(generated.relatedKeywords),
            generated.searchIntent,
            generated.reader,
            generated.angle,
            categoryId,
            categoryName,
            initialHtml,
            evidence,
            JSON.stringify(
              generated.sections.map((section) => ({
                heading: section.heading,
                prompt: section.imagePrompt,
                alt: section.altText,
              })),
            ),
            JSON.stringify({
              evidence: "PASS",
              fabricationRisk: "LOW",
              source: "video_transcript",
            }),
            "REVIEW_READY",
            "NOT_SENT",
            "",
            "[]",
            `${model} / ${keywords.provider}`,
            0,
            stamp,
            stamp,
          )
          .run();
        const imageResult = await retry(
          () =>
            generateImages(openAiKey, articleId, generated, imageCount, {
              thumbnailUrl: metadata.thumbnailUrl,
              videoId: metadata.videoId,
              articleIndex: index,
              articleCount,
              challengerCompany,
              challengerRole,
              challengerName,
            }),
          2,
        );
        if (imageResult.warning) throw new Error(imageResult.warning);
        if (imageResult.images.length !== imageCount)
          throw new Error(
            `画像が${imageResult.images.length}/${imageCount}枚しか生成されませんでした。`,
          );
        let wordpressStatus = "NOT_SENT",
          wordpressPreviewUrl = "",
          wordpressEditUrl = "",
          finalHtml = bodyHtml(
            generated,
            imageResult.images.map((image) => image.url),
            videoCard,
          );
        if (wordpress) {
          const posted = await retry(
            () =>
              publishDraft(
                wordpress,
                generated,
                finalHtml,
                categoryId,
                imageResult.images,
                videoCard,
              ),
            2,
          );
          if (!posted.previewUrl)
            throw new Error(
              `「${generated.title}」のWordPress下書きURLを取得できませんでした。`,
            );
          wordpressStatus = "DRAFT";
          wordpressPreviewUrl = posted.previewUrl;
          wordpressEditUrl = posted.editUrl;
          finalHtml = posted.html;
          await runtime()
            .DB.prepare(
              "UPDATE articles SET body_html=?,featured_image_url=?,section_images_json=?,wordpress_post_id=?,wordpress_edit_url=?,wordpress_preview_url=?,wordpress_status=?,updated_at=? WHERE id=?",
            )
            .bind(
              finalHtml,
              posted.featuredUrl,
              JSON.stringify(posted.uploadedUrls.slice(1)),
              posted.postId,
              posted.editUrl,
              posted.previewUrl,
              wordpressStatus,
              now(),
              articleId,
            )
            .run();
        } else
          await runtime()
            .DB.prepare(
              "UPDATE articles SET body_html=?,featured_image_url=?,section_images_json=?,updated_at=? WHERE id=?",
            )
            .bind(
              finalHtml,
              imageResult.images[0]?.url || "",
              JSON.stringify(
                imageResult.images.slice(1).map((image) => image.url),
              ),
              now(),
              articleId,
            )
            .run();
        return {
          id: articleId,
          title: generated.title,
          wordpressStatus,
          imageCount: imageResult.images.length,
          wordpressPreviewUrl,
          wordpressEditUrl,
        };
        },
      ),
    );
    results.push(...completed);
    if (results.length !== articleCount)
      throw new Error(
        `${articleCount}本中${results.length}本しか完成しませんでした。`,
      );
    await runtime().DB.batch([
      runtime()
        .DB.prepare("UPDATE articles SET batch_ready=1 WHERE project_id=?")
        .bind(projectId),
      runtime()
        .DB.prepare(
          "UPDATE production_projects SET status='COMPLETED',updated_at=? WHERE id=?",
        )
        .bind(now(), projectId),
    ]);
  } catch (error) {
    await runtime()
      .DB.prepare(
        "UPDATE production_projects SET status='FAILED',updated_at=? WHERE id=?",
      )
      .bind(now(), projectId)
      .run();
    throw error;
  }
  return {
    projectId,
    articles: results,
    warnings: [...new Set(warnings)],
    title,
    provider: `${model} / ${keywords.provider}`,
    metadata: {
      title,
      descriptionCharacters: metadata.description.length,
      chapterCount: metadata.chapters.split(/\r?\n/).filter(Boolean).length,
    },
  };
}

// Retained only for imports in older test fixtures; new production uses Claude.
export const deterministicFallback = articleDraft;
