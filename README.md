# 10秒リーダー

開いて3秒で目に入り、10秒で読み終わるRSSリーダー。広告・おすすめ・動画なし。未読は溜まらない（24時間で自動的に消える）。

## 仕組み

- このリポジトリと GitHub Pages に置くのはアプリ本体（`public/` の静的PWA）だけ。記事・フィード設定・閲覧履歴は非公開リポジトリ `kemzog/ten-second-reader-data` にあり、⚙︎ にトークンを入れた端末でしか見えない
- `ten-second-reader-data` の `feeds.json` にカテゴリ別（`management` / `engineering` / `design`）にフィードを書く
- `ten-second-reader-data` の GitHub Actions が30分ごとにこのリポジトリの `scripts/fetch.mjs` でRSSを取得し、`<カテゴリ>/items.json` を同リポジトリの `items` ブランチに置く。アプリはトークンを使って GitHub API から読む
- カテゴリごとに別URL（`/management/`、`/engineering/`、`/design/`）。それぞれホーム画面に追加すると別アプリになる
- 既読は端末ごとに保存。最後に読み込んだ記事も端末に残し、開いた瞬間に表示する

## 使い方

- タップで原文を開く（一覧には薄く残る。スワイプか「読んだ」で消える）
- 左スワイプで1件消す
- 右スワイプ（PCは「Claude」ボタン）で、その記事についてClaudeとの会話を始める
- 画面の一番上で下に引っ張ると再読み込み（新しいバージョンも反映）
- 「読んだ」で表示中の10件をまとめて既読 → 次の10件 / 完了

## フィードの追加

`ten-second-reader-data` の `feeds.json` の `categories.<カテゴリ>` に `{ "name": "表示名", "url": "RSSのURL" }` を足すだけ。カテゴリを増やす場合は `public/<カテゴリ>/` に `index.html` と `manifest.webmanifest` も追加する。

- `maxAgeHours`: これより古い記事は出さない
- `perFeed`: 1フィードあたりの最大件数

## 開発

```sh
npm install
npm test
npm run fetch -- ../ten-second-reader-data/feeds.json out   # out/<カテゴリ>/items.json を生成
npx serve public   # 記事は GitHub から読むので、⚙︎ にトークンが必要
```

## 初回セットアップ

リポジトリの Settings → Pages → Source を「GitHub Actions」にする。

## 除外と閲覧履歴

- 各カードの「除外」、または ⚙︎ の設定画面のチェックボックスで、フィードを即時に表示/除外（ページごと）
- 開いた記事と除外/復帰の操作は、非公開リポジトリ `kemzog/ten-second-reader-data` に保存される
  - `history/YYYY-MM.jsonl`: 1行1イベント（`type`: `open` / `exclude` / `include`）
  - `excluded.json`: カテゴリごとの除外中フィード名（端末間で同期）
- fine-grained PAT（対象: `ten-second-reader-data` のみ、権限: Contents の Read and write）を ⚙︎ から各端末に1回入力する。記事の表示にも必要
- トークン未設定のあいだは端末内にためておき、設定後にまとめて送信する

## フィード探し（`/curate/`）

閲覧履歴から読書の傾向（カテゴリ・サイト・よく出る言葉・言語比率）を出し、`candidates.json` の候補サイトを履歴との近さで並べて提案する。「追加」で `ten-second-reader-data` の `feeds.json` を main に直接コミットし、数分後にリーダーへ反映される。「興味なし」は履歴に記録して以後出さない。

- 候補は `candidates.json`（`name` / `url` / `lang` / `tags` / `note`）。データ側の GitHub Actions が30分ごとに候補も取得し、最近の記事タイトルを `items` ブランチの `curate/candidates.json` に書く。取得できない候補と登録済みのフィードは出ない
- トークンはリーダーと共通（`ten-second-reader-data` の Contents: Read and write だけでよい）
- 追加・興味なしは履歴に `add` / `dismiss-candidate` イベントとして残る
