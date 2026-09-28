# AGENTS.md

作業を始める前に `CODEX_HANDOFF.md` を最初から最後まで読むこと（現在の正本）。

要点:
- 変更対象はこのリポジトリだけ。元のSEO LOOP（`/Users/hiranokouichi/Documents/ChatGPT/SE0　アプリ`）は変更しない。
- `app/api/[[...path]]/route 2.ts` と `app/seo-loop-app 2.tsx` はユーザー所有。触らない・コミットしない。
- 記事・画像の生成に Claude API / OpenAI API を使わない（Chrome拡張でログイン中の画面を操作する方式）。
- WordPressは下書き保存のみ。認証情報の実値を書かない。
- テスト: `node --test tests/unified-production.test.mjs tests/browser-mode.test.mjs tests/browser-extension.test.mjs tests/production-response.test.mjs tests/face-quality.test.mjs`
- 拡張を更新したら `~/Downloads/video-studio-extension (1)/` へ同期し、ユーザーに再読み込みを依頼する。
- ユーザーの指示なしにコミット・プッシュしない。
