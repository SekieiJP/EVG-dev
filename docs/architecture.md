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
- ブラウザ版は既定では未デプロイ環境の検証用に `localStorage` へ同じ形のルーム状態を保存する。`assets/js/config.js` でGAS通信を有効化した場合は、参加・投票・ホスト進行・状態ポーリングをGAS Web Appへ送る。未登録Playerと未認証Hostはポーリングせず、必要フェーズだけ10秒間隔で `/api/status` を取得する。
- ルール計算は `engine.js` の純粋関数に集約し、ブラウザUIから直接呼び出す。
- GAS版は Apps Script 単体で動くよう、主要ロジックを `Code.gs` に移植している。
- GAS接続前に必要な情報は `assets/js/config.js` のビルド時定数で管理する。`apiKey` はデプロイIDを既定値とし、`getClientConfigSnippet()` でクライアント設定を確認できる。GASへのPOSTはApps ScriptのCORSプリフライトを避けるため、JSON文字列を `text/plain` で送る。ホスト操作は `apiKey` と `/api/host/auth` で取得する期限付き `hostToken` を要求する。
- `roomVersion` はルーム更新ごとに増加し、変更なしの状態取得ではフルルームを返さない。Hostブラウザで計算した集計結果は `commit-result` としてGASへ保存し、GASは権限と競合だけを検証する。
- HostとScreenが同一端末の別ウィンドウの場合、Screenは `BroadcastChannel` と `localStorage` でHostからroomを受け取り、GASポーリングを止められる。
- GAS通信を伴う手動操作では読み込み表示を出し、通信中の追加操作を止める。定期ポーリングは画面をブロックしない。
- Player本人のGAS個人戦績は、同一ゲーム・同一ステージ・同一結果数の間は `localStorage` キャッシュを使う。
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
- `game_configs`

`current_game` のチャンクJSONが進行中ゲームの主データで、`players` はUUID/現在名/Skill履歴のマスタとして維持する。ゲーム終了時または中断時に `save_data`、`stage_results`、`stage_settings`、`game_history` へ集計済みステージの履歴を保存する。`game_configs` はHostが手動登録する次ゲーム候補で、実績保存用の `stage_settings` とは分離する。
