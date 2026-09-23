import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(
  new URL("../app/seo-loop-app.tsx", import.meta.url),
  "utf8",
);

test("every enabled button is covered by the shared percentage progress UI", () => {
  assert.match(source, /onClickCapture=\{trackButton\}/);
  assert.match(source, /target\.closest\("button"\)/);
  assert.match(source, /actionProgress\.pulse\(/);
  assert.match(source, /aria-valuenow=\{progress\.percent\}/);
  assert.match(source, />\{progress\.percent\}%<\/strong>/);
});

test("all asynchronous button workflows use the shared progress controller", () => {
  const expectedLabels = [
    "制作入力を保存",
    "キーワード候補を生成",
    "文章生成",
    "全データ自動分析",
    "の接続確認",
    "の認証準備",
    "の連携解除",
    "の利用対象を保存",
  ];

  for (const label of expectedLabels) {
    assert.ok(source.includes(label), `${label}の進捗処理がありません`);
  }
});
