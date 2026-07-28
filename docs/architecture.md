# Architecture

本番構成の正本は [Firebase RTDB 目標アーキテクチャ](./firebase-rtdb-target-architecture.md) である。この文書は実装の配置と責務を要約する。GAS + Spreadsheet はアーカイブ専用であり、進行中ゲームのフォールバックではない。

## 構成

```text
game/
  index.html              # Player / Host / Screen 共通SPA
  assets/js/config.js     # Firebase Web設定
  assets/js/engine.js     # 得点・Skill・状態遷移の純粋関数
  assets/js/firebase/     # Auth、購読、command、result commit、archive client
firebase/
  database.rules.json     # uid/role/phase/node境界のRules
gas/
  src/Code.gs             # 確定payloadをSpreadsheetへ冪等出力するarchive endpoint
tests/
  ...                     # Unit、Rules emulator、RTDB integration、Browser E2E
```

## 状態管理

- 進行、投票、結果、現在Skill、次ゲーム候補、公開履歴の正系はFirebase RTDB。
- Firebase Anonymous Authの `auth.uid` が書込み主体。Host権限は `roles/hosts/{uid}` allowlistでRulesが検証する。
- `public` はphase、stage、時刻、roomVersionだけを持ち、Host commandは `expectedPhase` と `roomVersion` を検証するtransactionで確定する。
- 画面はroom rootを購読しない。Host、Player、Screenは必要な小ノードを購読してViewModelを作る。HTTP polling、GAS status API、BroadcastChannelによる正系同期は使わない。
- 結果commitはphase transaction後に、`results`、`scores`、`playerStats`、本人履歴、`operations` を一回のmulti-location updateで原子的に書く。順次書込みは禁止する。
- StageSkillは毎ステージ記録し、現在Skillは最高値を含む上位5件の合計として同じcommitで更新する。累積戦歴の指標は9項目。
- クライアントは `/.info/serverTimeOffset` により補正済みサーバ時刻を使う。進行中room全体はlocalStorageへ保存しない。

## データ境界

- `rooms/{roomId}/nextGameConfigs` が次ゲームテンプレートの正系。Spreadsheet `game_configs` はアーカイブ出力のみ。
- 同日継続は次ゲーム開始日（Asia/Tokyo）にticketを提出した直前ゲーム参加者だけを対象にする。プロフィール/Skillは継続し、ゲーム内score・ticket・結果は初期化する。
- 公開履歴はゲームサマリ、表示名、得点、順位、公開用現在Skillだけ。ticket、予想、内訳、uid/UUID、StageSkill履歴、個人統計は本人詳細またはHost詳細に隔離する。

## アーカイブ

finalまたは中断時、HostがRTDBの確定payloadをGASへ送る。GASは `archiveId` と `gameId` で `save_data`、`stage_results`、`stage_settings`、`game_history`、`archive_log` を冪等にupsertする。失敗はRTDB `archive.status` に記録し、再送できる。GAS停止中でも進行中ゲームはRTDBだけで完走する。
