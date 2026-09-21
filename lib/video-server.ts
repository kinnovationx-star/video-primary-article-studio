import { env } from "cloudflare:workers";

export type Video = { id: string; title: string; url: string; transcript: string; keyword: string; status: string; article_markdown: string; created_at: string; updated_at: string };
export const runtime = () => env as unknown as { DB: D1Database; FILES: R2Bucket; ANTHROPIC_API_KEY?: string };
export const id = () => crypto.randomUUID();
export const now = () => new Date().toISOString();
export const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
let initialized = false;
export async function ensureSchema() { if (initialized) return; await runtime().DB.batch([
  runtime().DB.prepare("CREATE TABLE IF NOT EXISTS videos (id TEXT PRIMARY KEY, title TEXT NOT NULL, url TEXT NOT NULL DEFAULT '', transcript TEXT NOT NULL, keyword TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'READY', article_markdown TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)"),
  runtime().DB.prepare("CREATE INDEX IF NOT EXISTS idx_videos_updated ON videos(updated_at DESC)"),
]); initialized = true; }
const compact = (text: string, length = 420) => text.replace(/\s+/g, " ").trim().slice(0, length).replace(/([^。！？.!?])$/, "$1。");
export async function createArticle(video: Video) {
  const keyword = video.keyword || video.title;
  const evidence = compact(video.transcript);
  return `# ${video.title}\n\n> この記事は動画「${video.title}」の確認済み文字起こしを一次情報として作成した下書きです。\n\n## ${keyword}について、動画で語られたこと\n\n${evidence}\n\n## 動画の内容を実務に活かすポイント\n\n動画では、上記のように具体的な背景・手順・経験が説明されています。実行時は自社の状況に合わせ、動画内で確認できない条件や効果を補わないようにしてください。\n\n## よくある確認事項\n\n### どこまでが一次情報ですか？\n\nこの下書きでは、登録済みの文字起こしに含まれる発言のみを根拠にします。追加する数値、事例、比較情報は必ず別の根拠を確認してください。\n\n### 公開前に確認すること\n\n- 発言の文脈が変わっていないか\n- 固有名詞・数値・日付が動画と一致しているか\n- 読者への約束が動画の内容を超えていないか\n\n## まとめ\n\n${video.title}で共有された一次情報を出発点に、読者が理解しやすい形へ整理しました。公開前に動画へ戻り、重要な記述を人が最終確認してください。`;
}
