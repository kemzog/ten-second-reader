# 10秒リーダー

開いて3秒で目に入り、10秒で読み終わるRSSリーダー。広告・おすすめ・動画なし。未読は溜まらない（24時間で自動的に消える）。

## 仕組み

- `feeds.json` にカテゴリ別（`management` / `engineering`）にフィードを書く
- GitHub Actions が30分ごとにRSSを取得して `public/<カテゴリ>/items.json` を作り、GitHub Pages に公開
- カテゴリごとに別URL（`/management/`、`/engineering/`）。それぞれホーム画面に追加すると別アプリになる
- アプリは静的PWA（`public/`）。既読は端末ごとに保存

## 使い方

- タップで原文を開く（既読になる）
- 左スワイプで1件消す
- 「読んだ」で表示中の10件をまとめて既読 → 次の10件 / 完了

## フィードの追加

`feeds.json` の `categories.<カテゴリ>` に `{ "name": "表示名", "url": "RSSのURL" }` を足すだけ。カテゴリを増やす場合は `public/<カテゴリ>/` に `index.html` と `manifest.webmanifest` も追加する。

- `maxAgeHours`: これより古い記事は出さない
- `perFeed`: 1フィードあたりの最大件数

## 開発

```sh
npm install
npm test
npm run fetch   # public/<カテゴリ>/items.json を生成
npx serve public
```

## 初回セットアップ

リポジトリの Settings → Pages → Source を「GitHub Actions」にする。

## 除外と閲覧履歴

- 各カードの「除外」でそのフィードを即時に非表示（ページごと）。⚙︎ の設定画面から戻せる
- 開いた記事と除外/復帰の操作は、非公開リポジトリ `kemzog/ten-second-reader-data` に保存される
  - `history/YYYY-MM.jsonl`: 1行1イベント（`type`: `open` / `exclude` / `include`）
  - `excluded.json`: カテゴリごとの除外中フィード名（端末間で同期）
- 書き込みには fine-grained PAT（対象: `ten-second-reader-data` のみ、権限: Contents の Read and write）を ⚙︎ から各端末に1回入力する
- トークン未設定のあいだは端末内にためておき、設定後にまとめて送信する
