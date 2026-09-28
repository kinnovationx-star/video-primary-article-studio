# Codex引き継ぎ — 動画一次情報記事制作アプリ

最終更新: 2026-09-28（Claude Codeから引き継ぎ）
この文書が現在の正本。`PROJECT_HANDOFF.md` の冒頭の追記も同じ内容。それより下の旧記述（API生成・GPT Image 2 API）は履歴。

---

## 0. 最初に読むこと（絶対ルール）

1. 変更してよいのは `/Users/hiranokouichi/Documents/ChatGPT/動画一次情報記事制作アプリ` だけ。元のSEO LOOP `/Users/hiranokouichi/Documents/ChatGPT/SE0　アプリ` は絶対に変更しない。
2. 未追跡の `app/api/[[...path]]/route 2.ts` と `app/seo-loop-app 2.tsx` はユーザー所有の重複ファイル。削除・変更・コミットしない。
3. **記事・画像の生成に Claude API / OpenAI API を使わない**（ユーザーの強い指定）。生成はChromeでログイン中の claude.ai / chatgpt.com の画面を専用拡張で操作して行う。
4. 検索データ（Search Console・GA4・Ubersuggest）はAPI取得でよい（ユーザー了承済み）。WordPressはREST APIで**下書き保存のみ**。公開しない。
5. 認証情報の実値をコード・MD・Gitに書かない。
6. 進捗100%は、指定本数の記事・画像・WordPress下書き・外部確認URLがすべて終わってから。
7. 人名の異体字（例: 青﨑）を保持。番組名は英語表記「A TRUTH STORY」。
8. **変更はまだ一度もコミットしていない**（最終コミットは `15fa5f3`）。ユーザーから指示があるまでコミット・プッシュしない。

## 1. 現在の状態（2026-09-28）

- 本番: https://video-primary-article-studio.k-innovationx.workers.dev/ （最新デプロイ Version `6ce3fc55-ac1e-4d02-bb85-cf616059fa08`）
- 本番で通し動作確認済み: 記事作成ボタン → Claude（資料整理→API実測データ分析→記事） → ChatGPT画像 → WordPress下書き → 外部確認URL（3本制作で成功、未ログインでHTTP 200を確認）。
- **未確認（最優先）**: Chrome拡張 v0.4.0（顔判定つき動画フレーム切り出し）。ユーザーのChromeはまだ0.3.0で動いていた。ユーザーに `chrome://extensions` で再読み込み（↻）してもらい、0.4.0で実機テストすること（手順は §7）。
- 記事ライブラリーは 2026-09-27 にユーザー指示で全削除済み（D1の articles / article_images / production_projects / keyword_candidates / uploaded_files）。削除前の全体バックアップ: `backups/d1-before-library-reset-2026-09-27.sql`（git管理外）。WordPress下書きは削除していない。
- その後ユーザーが新しく制作した記事（TKO木本武宏×3、小村直克×3）がライブラリーにある。小村さんの記事のH2画像は旧方式（固定帯の切り抜き）で、頭が切れている等の問題あり → v0.4.0で作り直す予定。

## 2. 全体構成

```
[制作画面 app/seo-loop-app.tsx]  ←postMessage→  [Chrome拡張 pc-browser-extension/]
        │ fetch /api/*                               ├ claude.ai / chatgpt.com の専用タブを操作
        ▼                                            ├ YouTubeタブで実フレームを切り出し
[Cloudflare Worker route.ts]                         └ offscreen文書で MediaPipe 顔判定（ローカル）
   ├ D1: 記事・画像メタ・連携情報（暗号化）
   ├ R2: 画像・参照写真
   ├ Search Console / GA4（Google OAuth）・Ubersuggest（MCP OAuth）… 実測データ取得
   └ WordPress REST … 下書き保存・Public Post Preview
```

### 制作パイプライン（`runPipeline` in `app/seo-loop-app.tsx`）
チェックポイントは localStorage `video-studio-pipeline-v2`。再読み込みで続きから再開（完了済み工程は再実行しない）。

1. Claude（新規会話, job `${id}-claude`）: 文字起こし全体を時系列の「話題一覧」に整理＋`シードキーワード:` 行（`buildMaterialStep`, `parseSeeds`）。
2. `POST /api/seo/research`（`lib/seo-research.ts`）: GSC直近90日クエリ・上位ページ、GA4自然検索LP、Ubersuggest関連語（検索数・SD・CPC）とSERP。
3. Claude（同じ会話を `startUrl` で開く, job `${id}-claude-2`）: 実測データ分析→キーワード選定→話題の割当表（漏れゼロ）→記事を1本ずつ（`buildAnalysisSteps`, `articleRequest`）。本文5000字以上（下限のみ・上限なし）。
4. 回答HTMLを解析（`parseClaudeArticle`。claude.aiは見出しを1段下げて描画するので `normalizeHeadings` で補正）→ `POST /api/browser/articles` でD1保存。
5. 画像（記事ごと5枚）
   - H2画像4枚: 実際の動画の場面（拡張 `FRAMES` コマンド）。時刻はClaudeの「画像指示: mm:ss …」、無ければ本文の引用時刻（`sectionFrameTimes`）。
   - アイキャッチ1枚: ChatGPT（job `${id}-feat-${n}`, `buildFeaturedImageStep`）。本人参照写真＋実場面を添付。文字は「A TRUTH STORY / PART n / 会社名 役職 氏名」。
   - `POST /api/articles/:id/images` でR2保存。
6. `POST /api/articles/:id/wordpress`（`syncWordPressDraft` in `lib/browser-production.ts`）: 画像をWPメディアへ、本文にH2画像とYouTubeリンクを合成、下書き作成/更新、Public Post PreviewのURL発行。

### 外部確認URL
`/api/preview/<articleId>` の恒久リンク。開くたびにPublic Post Previewの新URL（プラグイン仕様で約48時間有効）を発行してリダイレクト。カードにはこの恒久リンクを表示。

## 3. Chrome拡張（`pc-browser-extension/`, v0.4.0）

- **ユーザーのChromeが読み込んでいるフォルダーは `~/Downloads/video-studio-extension (1)/`**（リポジトリのフォルダーではない）。拡張を更新したら必ず:
  ```bash
  rsync -a --delete --exclude .DS_Store pc-browser-extension/ "$HOME/Downloads/video-studio-extension (1)/"
  ```
  → ユーザーに ↻ 再読み込みを依頼。`app/seo-loop-app.tsx` の `EXTENSION_VERSION`（最低版）と `LATEST_EXTENSION` と `manifest.json` の version を揃えて上げる。
- `background.js`: ジョブ（複数ステップ会話）。RUN（idempotent）/ STATUS / RESULT / IMAGE / RETRY / CANCEL / FRAMES / SOURCES / CAPTURE / PING。送信結果不明時は自動再送しない（`sending` → attention）。再試行時は送信済みか確認してから送る（二重送信防止）。
- `assistant-page.js`: claude.ai / chatgpt.com の画面操作。**長い会話は古いメッセージがDOMから外れる**ため、回答は「自分の最後のメッセージの直後」で特定（`replyAfter`、promptHead=依頼文の先頭40文字）。セレクター（2026-09-27確認）は README 参照。画面が変わったらここを更新。
- `face-quality.js` + `offscreen.js` + `mediapipe/`（MediaPipe Face Landmarker 1.0.1, Apache-2.0, 約16MB同梱）: H2画像の品質判定。ルール:
  - 不合格: 顔なし / 目を閉じ・半目（eyeBlink>0.42）/ 横顔すぎ / 口が大きく開いた瞬間 / 元映像で頭が切れている / 頭（髪まで）が16:9に収まらない
  - 切り抜き: 上16.5%（章タイトル・ロゴ）と下84.5%以下（字幕）を避ける。主役の頭全体を含む。他の人物は全部入るか全く入らない。元映像で高さ700px以上。
  - 選定: ±6秒を1秒刻み→合格コマから顔の鮮明さ・正面度で最良→切り抜き後に再判定→不合格なら±12/30/60/120秒→動画全体の別位置で取り直し→見つからなければその画像は空けて警告。
  - 小さい顔（引きの画）はタイル分割（全体＋拡大6枚）で検出。
  - 動画は非表示タブでは読み込まれないため、切り出し中は作業ウィンドウを前面に出す。

## 4. 主要ファイル

| ファイル | 役割 |
|---|---|
| `app/seo-loop-app.tsx` | 画面全体・パイプライン・記事編集（H2書き直し=Claude、H2画像=動画切り出し、アイキャッチ=ChatGPT、WP下書き保存） |
| `app/api/[[...path]]/route.ts` | API（保存・WordPress・YouTube公開情報・実測データ・OAuth再接続）。AI APIは呼ばない |
| `lib/browser-pipeline.ts` | Claude/ChatGPTへの依頼文、回答解析、時刻抽出 |
| `lib/browser-production.ts` | D1/R2保存、WordPress下書き・外部確認URL、YouTube情報 |
| `lib/seo-research.ts` | GSC・GA4・Ubersuggestの実測データ取得 |
| `lib/unified-production.ts` | 旧実装。WordPress/Public Previewの関数を一部 export して再利用中 |
| `app/api/[[...path]]/legacy-api.ts` | 旧APIルート（参照されない保管用） |
| `migrations/0012_browser_production.sql` | article_images.section_index, articles.conversation_url（本番適用済み） |
| `pc-browser-extension/` | Chrome拡張（上記） |
| `scripts/package-browser-extension.mjs` | build前に拡張ZIPを `public/downloads/` へ作成（ファイル一覧は明示リスト。拡張にファイルを足したらここにも追加） |

## 5. 検証とデプロイ

```bash
cd '/Users/hiranokouichi/Documents/ChatGPT/動画一次情報記事制作アプリ'
node --test tests/unified-production.test.mjs tests/browser-mode.test.mjs tests/browser-extension.test.mjs tests/production-response.test.mjs tests/face-quality.test.mjs   # 38件
npx tsc --noEmit -p .
npm run lint
npm run build            # prebuildで拡張ZIPも再生成
npx wrangler deploy --config cloud-runner/video-wrangler.jsonc
```
- `npm test` は旧SEO LOOPのレガシーテストを含み多数失敗するのが前提（ベースライン）。上の5ファイルが本アプリのテスト。
- D1の読み取り確認: `npx wrangler d1 execute video-primary-article-db --remote --config cloud-runner/video-wrangler.jsonc --command "SELECT ..."`（削除系は必ずバックアップ `wrangler d1 export` の後で、ユーザー確認の上で）。
- ローカル開発ではD1は空・暗号鍵なし（WordPress/Google連携は動かない）。本番で確認する。

## 6. 連携の状態（本番D1）

- WordPress: https://a-true-story.jp（REST, CONFIGURED）。Code Snippets と Public Post Preview プラグインを利用（ブリッジスニペットは自動インストール）。
- Search Console: https://a-true-story.jp/ 選択済み。GA4: A True Story_New（properties/548608831）選択済み。Google OAuthは refresh_token で自動更新。
- Ubersuggest: MCP OAuth（自動更新あり）。期限切れ時は連携設定の「再接続」。
- 連携設定画面から再接続・対象選択が可能（`/api/integrations/*`, `/api/oauth/*/callback`）。

## 7. 次にやること（優先順）

1. **拡張v0.4.0の実機確認**: ユーザーが↻で0.4.0にしたら、制作サイトのページ（例 `/api/health`）上で拡張ブリッジに `FRAMES` を送って（`{videoId:'OphicWL9IK0', times:[659], taken:[]}`、小村直克の動画）、返った画像を目視確認。ライブラリーは変更しない。確認ポイント: 頭が切れていない・目が開いている・字幕/ロゴなし・鮮明・処理時間。判定が厳しすぎて見つからない場合は `face-quality.js` の `LIMITS`/`BANDS`/頭の余白係数（head: 上0.5・左右0.28・下0.25×顔サイズ）を調整し、`tests/face-quality.test.mjs` を更新。
2. 問題なければユーザーに、小村さんの記事で「アイキャッチと全H2画像を作り直す」→「WordPress下書きを更新」をしてもらう。
3. ユーザーの指示があればコミット（未コミットの変更が大量。`.claude/` とユーザー所有の重複2ファイルは含めない）。
4. 改善候補
   - `BANDS` はA TRUTH STORYのテンプレート固定値。他の番組テンプレートでは字幕位置が違う可能性。
   - 本アプリは認証なし公開（URLを知っていれば下書き作成・再生成が可能）。外部公開するなら認証を追加。
   - 記事の文字数は下限5000字のみ。ユーザーから範囲指定の要望があれば `articleRequest` を変更。
   - ChatGPTの画像モデルは画面上で指定不可（「GPT Image 2.5」などの固定はできない）。

## 8. ユーザーについて

- 日本語で、専門用語を避けて短く説明する。「動いているか」には結論から答える。
- 操作手順は番号付きで、押すボタン名をそのまま書く。
- 外部への送信（Claude/ChatGPTへの実投入、WordPress下書き作成）を伴う実機テストは、事前に一言確認してから行う。
