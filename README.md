# 10秒リーダー

開いて3秒で目に入り、10秒で読み終わるRSSリーダー。広告・おすすめ・動画なし。未読は溜まらない（24時間で自動的に消える）。

## 仕組み

- `feeds.json` にフィードを書く
- GitHub Actions が30分ごとにRSSを取得して `items.json` を作り、GitHub Pages に公開
- アプリは静的PWA（`public/`）。既読は端末ごとに保存

## 使い方

- タップで原文を開く（既読になる）
- 左スワイプで1件消す
- 「読んだ」で表示中の10件をまとめて既読 → 次の10件 / 完了

## フィードの追加

`feeds.json` の `feeds` に `{ "name": "表示名", "url": "RSSのURL" }` を足すだけ。

- `maxAgeHours`: これより古い記事は出さない
- `perFeed`: 1フィードあたりの最大件数

## 開発

```sh
npm install
npm test
npm run fetch   # public/items.json を生成
npx serve public
```

## 初回セットアップ

リポジトリの Settings → Pages → Source を「GitHub Actions」にする。
