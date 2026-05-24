# gas

Google Apps Script のコード・設定を格納します。

## ファイル

- `src/Code.gs`: Web App API、Spreadsheet初期化、ゲーム進行、集計処理。
- `appsscript.json`: clasp等で使う任意のmanifestです。Apps Scriptエディタへ直接貼り付ける場合は配置不要です。

## セットアップ

1. Google Spreadsheetを作成します。
2. Apps Scriptプロジェクトへ `src/Code.gs` の内容を `Code.gs` として配置します。
3. スプレッドシートに紐づいた状態で `setupElevatorGameSheets()` を一度実行します。
4. `config` シートの `hostPassword` を運用値へ変更します。`apiKey` は自動生成されます。
5. Web Appとしてデプロイします。
   - Execute as: `USER_DEPLOYING`
   - Access: `ANYONE`
6. Apps Scriptで `getClientConfigSnippet()` を実行し、返された内容を静的クライアントの `game/assets/js/config.js` に反映します。

## config シート

| key | 用途 |
| --- | --- |
| `apiKey` | 静的クライアントとGASで共有するAPIキー。`setupElevatorGameSheets()` 実行時に自動生成します。 |
| `hostPassword` | Host画面の認証パスワード。 |
| `hostSessionMinutes` | `/api/host/auth` が返す `hostToken` の有効時間。 |
| `pollCacheSeconds` | ポーリングキャッシュ用の設定値。現状は設定作成までで、細かいキャッシュ制御は今後の負荷試験で調整します。 |
| `webAppUrl` | デプロイ済みWeb App URL。既定値は `https://script.google.com/macros/s/AKfycbyDZPVfLF2c3fswxmq3pVVmmTanMB-m7p3kwA3vuWJdX8gm7BtnunKqj-Z6g7HsAygO/exec`。 |

## 保存方式

- `current_game`: 進行中ゲームのJSONスナップショットを複数行チャンクで保存します。
- `players`: UUID、現在名、現在Skill、StageSkill履歴を保存します。現在ゲームにいないUUIDも保持します。
- `save_data`: UUID×gameIdのゲーム単位12指標を保存します。
- `stage_results`: UUID×gameId×stageIdのステージ単位結果とStageSkillを保存します。
- `stage_settings`: gameId×stageIdのステージ設定を保存します。
- `game_history`: ゲーム単位サマリとランキングを保存します。

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
- `POST /api/host/open-voting`
- `POST /api/host/close-voting`
- `POST /api/host/reveal-result`
- `POST /api/host/show-ranking`
- `POST /api/host/skip-animation`
- `POST /api/host/advance`
- `POST /api/host/recalculate`
- `POST /api/host/import-config`
- `POST /api/host/update-config`
- `GET /api/history/games`
- `GET /api/history/player/{uuid}`

GASのWeb App環境で `pathInfo` が取れない場合は、`?path=/api/room/state` のように `path` パラメータでもルーティングできます。

`/api/host/auth` 以外の `/api/host/*` は、`apiKey` と `hostToken` が必要です。`hostToken` は `/api/host/auth` のレスポンスで取得します。
