# PCブラウザー連携（Chrome拡張） v0.4.0

制作画面の「記事を作成する」から、ログイン済みChromeのClaude（claude.ai）とChatGPT（chatgpt.com）の画面を操作して、記事と画像を作ります。Claude API・OpenAI APIは使いません。

## 導入・更新

1. 制作画面の「連携設定」→「最新版をダウンロード」でZIPを保存し、消さない場所に展開する。
2. Chromeで `chrome://extensions` を開き、デベロッパーモードをON。
3. 古い版があれば削除し、「パッケージ化されていない拡張機能を読み込む」で展開フォルダーを選ぶ。
4. 同じChromeでClaude・ChatGPTにログインし、制作画面を再読み込みして「PC連携を確認」。

## 動き

- Claude・ChatGPTは別ウィンドウの専用タブで動く。送信の瞬間だけそのウィンドウを前面にし、すぐ制作画面へ戻す。
- 1つの依頼は複数ステップの会話。前の回答が確定（生成中表示が消え、6〜8秒変化なし）してから次を送る。
- Claude: 1通目で動画資料と企画、2通目以降で記事を1本ずつ。
- ChatGPT: 記事ごとにアイキャッチ1枚だけ。本人参照画像と実際の動画の場面を添付し、生成画像を取り込む（H2画像4枚は下記のとおり動画から切り出す）。
- 回答が画像なし・アーティファクトのみの場合は1回だけ自動で催促し、それでも駄目なら停止して「再試行」を待つ。
- 送信の結果が不明なときは自動再送しない（二重送信防止）。

## H2画像（実際の動画の場面）

YouTubeの動画を専用ウィンドウで開き（切り出し中は前面に出る。動画は非表示だと読み込まれないため）、指定時刻の前後±6秒を1秒ごとに取得して判定する。

- 顔の判定は同梱の MediaPipe Face Landmarker（Google, Apache-2.0）で拡張内（offscreen文書）で実行。ネット送信なし。広い画角の小さな顔も拾うため、全体＋拡大タイル6枚で検出して統合。
- 不合格: 顔なし／目を閉じている・半目（eyeBlink>0.42）／横顔すぎる／口が大きく開いた瞬間／元映像で頭が切れている／頭（髪まで）が16:9に収まらない。
- 切り抜き: 上部の章タイトル・ロゴ（上16.5%）と下部の字幕（84.5%以下）を避け、主役の頭部全体を含み、他の人物は「全部入る」か「全く入らない」位置だけを候補にする。切り抜きの高さは元映像で700px以上（4Kなら最大1920×1080で保存）。
- 合格コマの中で顔が最も鮮明で正面寄りのものを選び、切り抜き後にもう一度判定。駄目なら次の候補、それでも駄目なら±12/30/60/120秒、さらに動画全体の別の位置で取り直す。見つからなければその画像は空けて警告を出す。
- ルールは `face-quality.js`（テスト: `tests/face-quality.test.mjs`）。アイキャッチだけChatGPTで作る。

## 権限

storage / unlimitedStorage（生成画像の一時保存）/ scripting / offscreen（顔判定）。対象サイトは Claude・ChatGPT・ChatGPTの画像配信・Ubersuggest・GA4・Search Console のみ。Cookie・パスワードは読まない。

## 画面変更への追従

Claude・ChatGPTの画面構造が変わった場合は `assistant-page.js` のセレクターを更新する（2026-09-27時点で確認済み）:

- Claude: 回答 `[data-testid="assistant-message"]`、生成中 `[data-is-streaming="true"]`、入力欄 `.ProseMirror[contenteditable]`、送信 `button[aria-label="メッセージを送信"]`
- ChatGPT: 1往復 `[data-turn-key]`、生成画像 `[data-testid="generated-image-preview"] img`（blob URL）、入力欄 `[data-composer-markdown][contenteditable]`、送信 `form[data-chatgpt-composer] button[type="submit"]`
