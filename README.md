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

R2は動画の補助ファイルを追加する将来の拡張用として、アプリ専用に分離してあります。動画の自動取得、外部SEOデータ取得、WordPressへの自動公開は行いません。
