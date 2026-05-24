# Architecture

## 構成

```text
game/
  index.html              # プレイヤー・ホスト・スクリーン共通SPA
  assets/css/styles.css   # レスポンシブUIとスクリーン演出
  assets/js/config.js     # GAS接続先などのビルド時定数
  assets/js/engine.js     # ルール計算・Skill計算・状態遷移
  assets/js/app.js        # ローカル検証用UI制御
  assets/vendor/          # QRコード生成などの同梱ライブラリ
gas/
  src/Code.gs             # GAS Web App API
tests/
  engine.test.js          # Nodeで実行するルールテスト
```

## 状態管理

- 確定状態はGASの `current_game` シートにJSONスナップショットとして保存する。Spreadsheetの1セル上限を避けるため、JSONは複数行チャンクに分割する。
- ブラウザ版は既定では未デプロイ環境の検証用に `localStorage` へ同じ形のルーム状態を保存する。`assets/js/config.js` でGAS通信を有効化した場合は、参加・投票・ホスト進行・状態ポーリングをGAS Web Appへ送る。
- ルール計算は `engine.js` の純粋関数に集約し、ブラウザUIから直接呼び出す。
- GAS版は Apps Script 単体で動くよう、主要ロジックを `Code.gs` に移植している。
- GAS接続前に必要な情報は `assets/js/config.js` のビルド時定数で管理する。`apiKey` はGASセットアップ時に自動生成し、`getClientConfigSnippet()` からクライアント設定を取得する。GASへのPOSTはApps ScriptのCORSプリフライトを避けるため、JSON文字列を `text/plain` で送る。ホスト操作は `apiKey` と `/api/host/auth` で取得する期限付き `hostToken` を要求する。
- Screenの参加URL QRコードは `assets/vendor/qrcode-generator` の同梱ライブラリで生成する。

## 主要データ

- `room.config`: スキーマバージョン、ゲームメタデータ、ステージ配列。
- `room.players`: UUID、表示名、Skill履歴、接続状態。
- `room.tickets[stageId][uuid]`: 乗車階、降車階、予想回答、棄権状態。
- `room.stageResults[stageId]`: ステージ別集計、タイムライン、ランキング。
- `room.scores[uuid]`: ゲーム内累積得点。

## 状態遷移

```text
lobby
  -> stage_intro
  -> voting
  -> countdown
  -> reveal
  -> ranking
  -> stage_intro または final
```

`countdown` は15秒で、ローカル版は期限到達時に自動集計する。GAS版ではホストの `reveal-result` APIで集計する。

## 永続化シート

`setupElevatorGameSheets()` が以下を作成する。

- `config`
- `save_data`
- `stage_results`
- `players`
- `current_game`
- `stage_settings`
- `game_history`

`current_game` のチャンクJSONが進行中ゲームの主データで、`players` はUUID/現在名/Skill履歴のマスタとして維持する。ゲーム終了時に `save_data`、`stage_results`、`stage_settings`、`game_history` へ履歴を保存する。
