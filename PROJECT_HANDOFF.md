# 動画一次情報記事制作アプリ — 引き継ぎコンテキスト

更新日: 2026-09-25（Asia/Tokyo）

## 1. このアプリの目的

YouTubeの対談動画を一次情報として、動画タイトル・概要・目次・文字起こし・出演者情報を参照し、SEO記事、SEO情報、画像、WordPress下書きを一括生成する独立アプリ。

元のSEO LOOPとは別リポジトリ、別Cloudflare Worker、別D1、別R2で運用する。

## 2. 重要URLとリソース

- 本番アプリ: https://video-primary-article-studio.k-innovationx.workers.dev/
- GitHub: https://github.com/kinnovationx-star/video-primary-article-studio
- ローカルリポジトリ: `/Users/hiranokouichi/Documents/ChatGPT/動画一次情報記事制作アプリ`
- Worker: `video-primary-article-studio`
- D1: `video-primary-article-db`
- D1 ID: `91eb7e46-0db4-4304-b5d2-ee0a9fc236e0`
- R2: `video-primary-article-files`
- WordPress: `https://a-true-story.jp`
- 本番ブランチ: `main`
- 引き継ぎ時点の最新コミット: `2e4b62e feat: issue WordPress public preview links`
- 引き継ぎ時点のWorker Version ID: `f0d995f7-4513-4ffd-9d8f-d2d2e1615eac`

## 3. 最重要の作業ルール

1. 元のSEO LOOPのフォルダー `/Users/hiranokouichi/Documents/ChatGPT/SE0　アプリ` は絶対に変更しない。
2. 変更対象は独立アプリの `/Users/hiranokouichi/Documents/ChatGPT/動画一次情報記事制作アプリ` のみ。
3. 認証情報の実値はコード、MD、Gitに書かない。
4. 次の未追跡ファイルはユーザー所有の重複ファイルなので、削除・変更・コミットしない。
   - `app/api/[[...path]]/route 2.ts`
   - `app/seo-loop-app 2.tsx`
5. WordPressへは公開せず、常に「下書き」で保存する。
6. 完了進捗100%は、指定本数の記事、画像、WordPress下書き、外部確認URL、記事カードへの反映がすべて完了した後だけ表示する。

## 4. 現在の主要機能

### 記事生成

- 主操作は「記事を作成する」ボタン1つ。
- 1回で1〜5本の記事を生成できる。
- PART 1〜PART 5まで対応。
- YouTube URLからタイトル、概要、目次、サムネイルを取得。
- 文字起こし、動画概要、目次を照合してClaudeで記事を生成。
- 挑戦者の会社名、役職、出演者名を必須入力とし、文字起こしよりも入力値を正本とする。
- スペシャルゲストとMCは任意。
- 現在の正しい人名は「青﨑曹」。異体字の `﨑` を保持すること。
- `A TRUTH STORY` は英語表記に統一。
- タイトルタグ、メタディスクリプション、メインキーワード、関連キーワード、検索意図を生成。

### 画像生成

- OpenAI `gpt-image-2` を使用。
- 1記事あたり画像は5枚に固定。
- 1枚目: 16:9のファーストビュー。
- 2〜5枚目: 4つのH2に対応する各1枚の画像。
- 動画内の実際のフレームと、ユーザーが登録した挑戦者本人の参照画像をGPT Image 2へ入力する。
- 挑戦者本人の顔と人物を維持する。
- 同じ画像、同じフレーム、似た構図を再利用しない。
- ぼかし、ソフトフォーカス、不鮮明な顔、崩れた文字は禁止。
- 本番サイズは `2048x1152`。
- ファーストビューは `A TRUTH STORY` とPART番号、会社名・役職・氏名を使った経営者インタビュー調のデザイン。
- 記事最後にYouTubeサムネイルを配置し、クリックで元動画へ移動する。

### WordPress

- WordPress REST APIで投稿カテゴリーを取得し、生成時に選択できる。
- 生成記事は選択カテゴリーへ自動で下書き保存。
- アイキャッチはWordPressの特徴画像として設定。
- H2画像もWordPressメディアにアップロードし、本文に挿入。
- 記事ライブラリーの保存時は、連携済みWordPress下書きも同時更新。
- Public Post Previewの「外部確認を許可する」を記事生成時に自動有効化。
- `_ppp` 付きの外部確認URLを発行し、D1と記事カードへ保存。
- 外部確認URLはWordPressへ未ログインの状態でHTTP 200と正しい記事タイトルを確認済み。
- 引き継ぎ時点で既存のWordPress下書き7本に外部確認URLを発行済み。

### 記事ライブラリー

- 生成済み記事をカード形式で表示。
- カードにカテゴリー、タイトル、キーワード、検索意図、WordPress状態、外部確認URLを表示。
- カードから記事を開き、本文、H2、SEO設定、画像を編集できる。
- H2本文のAI再生成、各H2画像のAI再生成、全5枚の高画質再生成に対応。
- WordPress編集URLと外部確認URLの両方を利用できる。

### データ連携

- Ubersuggest MCP: 公式OAuth + PKCE。
- Google OAuth: Search Console、GA4、Drive、YouTube。
- Google連携後にSearch Consoleプロパティ、GA4プロパティ、Driveの利用対象をプルダウン選択。
- Claude API: 記事生成と分析。
- OpenAI API: GPT Image 2画像生成。
- WordPress: REST API、ユーザー名、アプリケーションパスワード。
- PageSpeed、Notion用の連携カードもある。

## 5. WordPress外部確認URLの実装

最新実装の重要部分。

- D1カラム: `articles.wordpress_public_preview_url`
- マイグレーション: `migrations/0011_wordpress_public_preview.sql`
- WordPress側はCode SnippetsプラグインのREST APIで連携ブリッジを自動インストール・有効化する。
- スニペット名: `Video Primary Article Public Preview Bridge`
- カスタムRESTルート: `POST /wp-json/video-primary-article/v1/public-preview/{postId}`
- このルートは、認証済みユーザーが対象記事を編集できる場合のみ実行できる。
- Public Post Previewの `public_post_preview` optionに投稿IDを登録し、`DS_Public_Post_Preview::get_preview_link()` で公式の共有URLを取得する。
- 既存記事の一括発行API: `POST /api/wordpress/public-previews/backfill`
- 記事新規生成と記事再編集の両方で外部確認URLを発行する。
- 外部確認URLの有効期限はPublic Post Previewプラグイン側の設定に従う。期限後は記事の再保存またはbackfill処理で再発行できる。

## 6. 主要ファイル

- `app/seo-loop-app.tsx`
  - 全画面、記事生成フォーム、進捗表示、記事カード、記事編集UI。
- `app/globals.css`
  - SEO LOOP風のレイアウト、カード、プレビュー、外部確認URL表示。
- `app/api/[[...path]]/route.ts`
  - フロント用API、記事生成、編集、画像再生成、連携、backfill。
- `lib/unified-production.ts`
  - YouTube取得、Claude記事生成、GPT Image 2、WordPress入稿、Public Post Preview、バッチ完了判定。
- `lib/studio-connections.ts`
  - 連携情報、OAuth、暗号化シークレット。
- `lib/integrations.ts`
  - WordPress等の外部APIヘルパー。
- `migrations/`
  - D1スキーマ。最新は `0011_wordpress_public_preview.sql`。
- `tests/unified-production.test.mjs`
  - この独立アプリの主要機能テスト。
- `cloud-runner/video-wrangler.jsonc`
  - 本番Worker、D1、R2、Browser、Images、Assetsの設定。

## 7. 認証・環境変数

実値は記載しない。現在利用する主な名称は以下。

- `DATA_ENCRYPTION_KEY`
- `ANTHROPIC_API_KEY`
- `OPENAI_API_KEY`
- `GOOGLE_OAUTH_CLIENT_ID`
- `GOOGLE_OAUTH_CLIENT_SECRET`
- `WORDPRESS_URL`
- `WORDPRESS_USERNAME`
- `WORDPRESS_APPLICATION_PASSWORD`
- `UBERSUGGEST_ACCESS_TOKEN`

連携設定画面から保存した値はD1にAES-GCM暗号化保存される。Workerの環境変数とD1保存を併用しているため、`/api/health` の単純なWorker環境変数判定が `not_configured` でも、連携設定と実API通信が成功するケースがある。

Google OAuthの許可済みリダイレクトURI:

```text
https://video-primary-article-studio.k-innovationx.workers.dev/api/oauth/google/callback
```

Google OAuthは身内利用の外部アプリとして本番環境へ変更済み。Google画面に「アプリの検証が必要」と出るが、不特定多数へ公開しない身内利用であれば、必要なユーザーだけで利用する。ただし、スコープやGoogleポリシーが変わる場合は再確認すること。

## 8. デプロイとDBマイグレーション

```bash
cd '/Users/hiranokouichi/Documents/ChatGPT/動画一次情報記事制作アプリ'
npm ci
npm run lint
npm run typecheck:workers
node --test tests/unified-production.test.mjs
npm run build
npx wrangler deploy --dry-run --config cloud-runner/video-wrangler.jsonc --outdir .wrangler/video-dry-run
npx wrangler d1 migrations apply video-primary-article-db --remote --config cloud-runner/video-wrangler.jsonc
npx wrangler deploy --config cloud-runner/video-wrangler.jsonc
```

既存WordPress下書きに外部確認URLを発行する場合:

```bash
curl --fail-with-body --silent --show-error --max-time 120 \
  -X POST \
  'https://video-primary-article-studio.k-innovationx.workers.dev/api/wordpress/public-previews/backfill' \
  -H 'Content-Type: application/json' \
  --data '{}'
```

## 9. 検証状況

引き継ぎ前に以下を確認済み。

- `node --test tests/unified-production.test.mjs`: 11/11合格。
- `npm run lint`: 合格。
- `npm run typecheck:workers`: 合格。
- `npm run build`: 合格。
- 本番用Wrangler dry-run: 合格。
- D1マイグレーション: 最新で追加対象なし。
- 本番デプロイ: 成功。
- 本番の記事ライブラリーで外部確認URLの文字列表示とリンク表示を確認。
- WordPress未ログイン相当のHTTPクライアントで外部確認URLが200で開くことを確認。

`npm test` は、この独立アプリに存在しない旧SEO LOOPの実装を要求する大量のレガシーテストも一緒に実行するため、ベースラインの不一致が多数ある。今回の独立アプリの主要テストは `tests/unified-production.test.mjs` で全件合格している。

## 10. 現時点の注意点・改善候補

1. Public Post PreviewのURLはプラグイン側の有効期限に従う。長期間固定で共有する場合は、WordPress側の期限設定または定期再発行を検討する。
2. `/api/wordpress/public-previews/backfill` は現状アプリ内の専用エンドポイントだが、不特定多数にアプリを公開する場合は管理者認証を追加する。
3. `/api/health` のWordPress表示はWorker環境変数のみを見ており、D1暗号化保存の接続状態と一致しないことがある。将来的には実接続確認の結果を返すよう改善する。
4. READMEの一部は古く、「Markdown下書き」や現在の画像・外部確認URL機能を完全に反映していない。この引き継ぎMDを現在の正本とする。
5. WordPress・YouTube・Claude・OpenAIは外部APIのため、「絶対にエラーゼロ」は技術的に保証できない。実装は有限リトライ、進捗保持、再接続、一括完了ゲートで中途状態の表示を防いでいる。

## 11. 次のコンテキストへの開始用プロンプト

以下を新しいコンテキスの最初に渡すと再開しやすい。

```text
/Users/hiranokouichi/Documents/ChatGPT/動画一次情報記事制作アプリ/PROJECT_HANDOFF.md を最初から最後まで読んで、その状態から続きを行ってください。
元のSEO LOOP `/Users/hiranokouichi/Documents/ChatGPT/SE0　アプリ` は絶対に変更せず、独立アプリのみ修正してください。
未追跡の `app/api/[[...path]]/route 2.ts` と `app/seo-loop-app 2.tsx` は削除・変更・コミットしないでください。
```
