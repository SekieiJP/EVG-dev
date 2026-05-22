# Architecture

## 構成

```text
game/
  index.html              # プレイヤー・ホスト・スクリーン共通SPA
  assets/css/styles.css   # レスポンシブUIとスクリーン演出
  assets/js/engine.js     # ルール計算・Skill計算・状態遷移
  assets/js/app.js        # ローカル検証用UI制御
gas/
  src/Code.gs             # GAS Web App API
tests/
  engine.test.js          # Nodeで実行するルールテスト
```

## 状態管理

- 確定状態はGASの `current_game` シートにJSONスナップショットとして保存する。
- ブラウザ版は未デプロイ環境の検証用に `localStorage` へ同じ形のルーム状態を保存する。
- ルール計算は `engine.js` の純粋関数に集約し、ブラウザUIから直接呼び出す。
- GAS版は Apps Script 単体で動くよう、主要ロジックを `Code.gs` に移植している。

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

初版では `current_game` のJSONが進行中ゲームの主データで、`players` と履歴系シートは同期・終了時保存に使う。
