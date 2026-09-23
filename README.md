# 動画一次情報記事制作アプリ

動画URLと確認済み文字起こしを一次情報として登録し、SEO記事のMarkdown下書きを制作する独立アプリです。SEO LOOP本体、既存データ、既存Worker、既存公開URLには依存しません。

## Cloudflare resources

- Worker: `video-primary-article-studio`
- D1: `video-primary-article-db`
- R2: `video-primary-article-files`

```bash
npm ci
npm run build
npx wrangler d1 migrations apply video-primary-article-db --remote --config cloud-runner/video-wrangler.jsonc
npx wrangler deploy --config cloud-runner/video-wrangler.jsonc
```

R2は動画の補助ファイル用に、D1は記事・分析・連携設定用に、それぞれ本アプリ専用として分離してあります。WordPressへの自動公開は行いません。

## 連携設定

連携設定画面で実際にAPI通信できた場合のみ「接続済み」と表示します。APIキー、WordPressアプリパスワード、OAuthトークンは専用D1にAES-GCMで暗号化して保存し、画面やAPI応答へ再表示しません。

- Ubersuggest MCP: 公式OAuth + PKCEで接続。個別トークンの手入力は不要です。
- Google: 画面にOAuth Client ID / Client Secretを入力し、Search Console・GA4・Drive・YouTubeを一度に認証します。
- WordPress: 画面にサイトURL・ユーザー名・アプリケーションパスワードを入力します。REST APIを優先し、必要時はXML-RPCで確認します。
- Claude・OpenAI・Notion・PageSpeed: 各カード内で設定し、保存前に実APIへ接続テストします。

Google OAuthの許可済みリダイレクトURIに次を登録します。

```text
https://video-primary-article-studio.k-innovationx.workers.dev/api/oauth/google/callback
```

暗号化キーはリポジトリへ保存せず、Cloudflare Worker Secretに設定します。

```bash
openssl rand -base64 48 | npx wrangler secret put DATA_ENCRYPTION_KEY --config cloud-runner/video-wrangler.jsonc
```

WordPress連携は下書き入稿までを対象とし、サイトへの自動公開は行いません。
