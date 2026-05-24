# GAS版 readiness

更新日: 2026-05-24

## 対応済み

- `apiKey` と期限付き `hostToken` によるホストmutation認証を実装した。
- `config` シートに `apiKey`, `hostPassword`, `hostSessionMinutes`, `pollCacheSeconds`, `webAppUrl` を作成する。
- `apiKey` はデプロイIDを既定値にする。秘匿値ではなく、最低限の誤接続防止に使う。
- `current_game` は1セルJSONではなく複数行チャンクで保存する。旧1セル形式も読み取り可能。
- `players` は既存UUIDを保持し、現在ゲーム参加者をマージする。
- `save_data` にゲーム単位の12指標、`stage_results` にStageSkill込みのステージ別結果を保存する。
- `stage_settings` と `game_history` をゲームID単位で同期する。
- 同名同日ゲームIDは `_2`, `_3` の連番で衝突回避する。
- 参加/復元時に、現在ルーム外のUUIDを `players` または履歴シートから復元できる。
- Player向け状態は他人のチケットと発表前結果を隠し、Screen向け状態は投影に必要な全体情報を返す。
- クライアントはGASの `serverTime` から時刻差分を保持し、カウントダウンと結果発表に使う。
- GASロジックテストで、認証、チャンク保存、gameId連番、公開範囲、12指標保存を確認する。

## デプロイ前チェック

- Apps Scriptプロジェクトへ `gas/src/Code.gs` の内容を `Code.gs` として配置する。`appsscript.json` はエディタへ直接貼り付けない。
- スプレッドシートに紐づいた状態で `setupElevatorGameSheets()` を一度実行する。
- `config` シートの `hostPassword` を本番値へ変更する。
- Apps Scriptで `getClientConfigSnippet()` を実行し、`game/assets/js/config.js` と同じデプロイURL/デプロイIDになっていることを確認する。
- Web Appは `executeAs: USER_DEPLOYING`, `access: ANYONE` でデプロイする。

## API URL受領後の手動検証

- 実GAS Web App URLで `text/plain` POST と `?path=` ルーティングが通ること。
- Host認証後、`hostToken` なしのホストmutationが拒否され、認証済み操作だけ成功すること。
- Host/Screen/Playerの3端末相当で、参加、受付、締切、移動中、集計、Skip、ランキング、最終結果まで通すこと。
- 終了後に `save_data`, `stage_results`, `players`, `game_history`, `stage_settings` が更新されること。
- UUID復元で過去SkillとStageSkill履歴が復元されること。
- 端末時計をずらした状態で、カウントダウンと結果発表の同期が許容範囲に収まること。
- 100人規模のjoin/submit/pollで、Lock待ちとSpreadsheet書き込み時間が許容範囲に収まること。
