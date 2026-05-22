# gas

Google Apps Script のコード・設定を格納します。

## ファイル

- `src/Code.gs`: Web App API、Spreadsheet初期化、ゲーム進行、集計処理。
- `appsscript.json`: Apps Script V8ランタイム設定。

## セットアップ

1. Google Spreadsheetを作成します。
2. Apps Scriptプロジェクトへ `src/Code.gs` と `appsscript.json` を配置します。
3. スプレッドシートに紐づいた状態で `setupElevatorGameSheets()` を一度実行します。
4. `config` シートの `hostPassword` を運用値へ変更します。
5. Web Appとしてデプロイします。

## API

`docs/elevator-game-requirements.md` の暫定API名に合わせ、以下を実装しています。

- `GET /api/time`
- `GET /api/room/state`
- `GET /api/screen/state`
- `POST /api/player/join`
- `POST /api/player/restore`
- `POST /api/player/rename`
- `POST /api/player/proceed-next`
- `POST /api/ticket/submit`
- `POST /api/ticket/abstain`
- `POST /api/host/auth`
- `POST /api/host/start-stage`
- `POST /api/host/close-voting`
- `POST /api/host/reveal-result`
- `POST /api/host/skip-animation`
- `POST /api/host/advance`
- `POST /api/host/recalculate`
- `GET /api/history/games`
- `GET /api/history/player/{uuid}`

GASのWeb App環境で `pathInfo` が取れない場合は、`?path=/api/room/state` のように `path` パラメータでもルーティングできます。
