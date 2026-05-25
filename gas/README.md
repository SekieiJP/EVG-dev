# gas

Google Apps Script のコード・設定を格納します。

## ファイル

- `src/Code.gs`: Web App API、Spreadsheet初期化、ゲーム進行、集計処理。
- `appsscript.json`: clasp等で使う任意のmanifestです。Apps Scriptエディタへ直接貼り付ける場合は配置不要です。

## セットアップ

1. Google Spreadsheetを作成します。
2. Apps Scriptプロジェクトへ `src/Code.gs` の内容を `Code.gs` として配置します。
3. スプレッドシートに紐づいた状態で `setupElevatorGameSheets()` を一度実行します。
4. `config` シートの `hostPassword` を運用値へ変更します。`apiKey` はデプロイIDが既定値です。
5. `game_configs` シートに次ゲーム候補を登録します。`status` は `ACTIVE`、`configJson` はHost設定JSON importと同じ形式です。
6. Web Appとしてデプロイします。
   - Execute as: `USER_DEPLOYING`
   - Access: `ANYONE`
7. Apps Scriptで `getClientConfigSnippet()` を実行すると、デプロイURLとデプロイID入りの `game/assets/js/config.js` 内容を確認できます。

通常APIリクエストでは `setupElevatorGameSheets()` を自動実行しません。未セットアップ時は `setup_required` を返します。初期化処理をポーリングごとに走らせないため、セットアップは必ず手動で一度実行してください。

## config シート

| key | 用途 |
| --- | --- |
| `apiKey` | 静的クライアントとGASで共有する識別子。既定値はデプロイIDです。秘匿値ではなく、最低限の誤接続防止に使います。 |
| `hostPassword` | Host画面の認証パスワード。 |
| `hostSessionMinutes` | `/api/host/auth` が返す `hostToken` の有効時間。 |
| `pollCacheSeconds` | ポーリングキャッシュ用の設定値。現状は設定作成までで、細かいキャッシュ制御は今後の負荷試験で調整します。 |
| `webAppUrl` | デプロイ済みWeb App URL。既定値は `https://script.google.com/macros/s/AKfycbyDZPVfLF2c3fswxmq3pVVmmTanMB-m7p3kwA3vuWJdX8gm7BtnunKqj-Z6g7HsAygO/exec`。 |

`hostPassword` はSpreadsheet上で数値として保存されても認証できるよう、GAS側で文字列化して比較します。

## 保存方式

- `current_game`: 進行中ゲームのJSONスナップショットを複数行チャンクで保存します。
- `players`: UUID、現在名、現在Skill、StageSkill履歴を保存します。現在ゲームにいないUUIDも保持します。
- `save_data`: UUID×gameIdのゲーム単位12指標を保存します。
- `stage_results`: UUID×gameId×stageIdのステージ単位結果とStageSkillを保存します。
- `stage_settings`: gameId×stageIdのステージ設定を保存します。
- `game_history`: ゲーム単位サマリとランキングを保存します。
- `game_configs`: Hostが事前登録する次ゲーム候補を保存します。`status=ACTIVE` の行だけHost画面に表示し、使用後も再利用可能です。

## game_configs シート

| 列 | 用途 |
| --- | --- |
| `configId` | Hostが次ゲーム開始時に指定する一意ID。 |
| `name` | Host画面に表示する候補名。 |
| `status` | `ACTIVE` の行だけ候補に表示します。不要な行は `ARCHIVED` にします。 |
| `sortOrder` | Host画面の表示順。 |
| `configJson` | ゲーム設定JSON全文。既存のHost JSON importと同じ形式です。 |
| `notes` | 運用メモ。 |
| `createdAt` / `updatedAt` | 手動更新用の日時メモ。 |

## API

`docs/elevator-game-requirements.md` の暫定API名に合わせ、以下を実装しています。

- `GET /api/time`
- `GET /api/status`
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
- `POST /api/host/commit-result`
- `POST /api/host/show-ranking`
- `POST /api/host/skip-animation`
- `POST /api/host/advance`
- `POST /api/host/recalculate`
- `GET /api/host/game-configs`
- `POST /api/host/start-game-config`
- `POST /api/host/import-config`
- `POST /api/host/update-config`
- `GET /api/history/games`
- `GET /api/history/player/{uuid}`

GASのWeb App環境で `pathInfo` が取れない場合は、`?path=/api/room/state` のように `path` パラメータでもルーティングできます。

`/api/host/auth` 以外の `/api/host/*` は、`apiKey` と `hostToken` が必要です。`hostToken` は `/api/host/auth` のレスポンスで取得します。

## ログとポーリング

- `doGet`/`doPost` は、path、role、uuid、処理時間、成功/失敗をJSONで `console.log` に出力します。
- 静的クライアントの通常ポーリング間隔は10秒です。
- 状態取得は `/api/status` を使い、`roomVersion` が変わっていなければフルルームを返しません。
- 未登録Playerと未認証Hostは状態ポーリングを行いません。Playerは投票受付中だけ、Hostは参加受付中と投票受付中だけ自動取得します。
- Hostブラウザで集計した結果は `/api/host/commit-result` で保存します。GAS側は `hostToken`、フェーズ、ステージ、`roomVersion`、二重集計だけを検証します。
- ScreenとHostが同一端末の別ウィンドウなら、Screenの同一端末同期モードでGASポーリングを止められます。
