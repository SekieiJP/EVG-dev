# GAS版 readiness

更新日: 2026-05-25

## 対応済み

- `apiKey` と期限付き `hostToken` によるホストmutation認証を実装した。
- `config` シートに `apiKey`, `hostPassword`, `hostSessionMinutes`, `pollCacheSeconds`, `webAppUrl` を作成する。
- `apiKey` はデプロイIDを既定値にする。秘匿値ではなく、最低限の誤接続防止に使う。
- `current_game` は1セルJSONではなく複数行チャンクで保存する。旧1セル形式も読み取り可能。
- `players` は既存UUIDを保持し、現在ゲーム参加者をマージする。
- `save_data` にゲーム単位の12指標、`stage_results` にStageSkill込みのステージ別結果を保存する。
- `stage_settings` と `game_history` をゲームID単位で同期する。
- `game_configs` にHostが事前登録した次ゲーム候補を保存し、`status=ACTIVE` の設定を再利用可能テンプレートとしてHost画面に表示する。
- 同名同日ゲームIDは `_2`, `_3` の連番で衝突回避する。
- 参加/復元時に、現在ルーム外のUUIDを `players` または履歴シートから復元できる。
- Player向け状態は他人のチケットと発表前結果を隠し、Screen向け状態は投影に必要な全体情報を返す。
- クライアントはGASの `serverTime` から時刻差分を保持し、カウントダウンと結果発表に使う。
- 通常APIリクエストでは `setupElevatorGameSheets()` を実行せず、未セットアップ時は `setup_required` を返す。
- `doGet`/`doPost` は、path、role、uuid、処理時間、成功/失敗をJSONで `console.log` に出力する。
- クライアントは未登録Player・未認証Hostではポーリングせず、必要フェーズだけ10秒間隔で状態取得する。
- `/api/status` は `roomVersion` が変わらない場合にフルルームを返さない。
- Hostブラウザ集計結果を `/api/host/commit-result` で保存し、GAS側は保存前検証に寄せる。
- 同一端末Screen同期モードでは、`BroadcastChannel` と `localStorage` でHostからroomを受け取りGASポーリングを止める。
- GAS通信を伴う手動操作では読み込み表示を出し、通信中の追加操作を受け付けない。
- Player本人の個人戦績は、同一ゲーム・同一ステージ・同一結果数ではローカルキャッシュを再利用する。
- Host/Screen起動時には、保存済みPlayer UUIDがあってもPlayer復元APIを送らない。
- 認証済みHost画面は、締切カウントダウンと移動中演出の終了後に自動で集計commitを開始する。
- Player入口URLではHost/Screenタブを無効化し、Player入力中は状態ポーリングによる再描画を抑制する。
- GASロジックテストで、認証、チャンク保存、gameId連番、公開範囲、12指標保存を確認する。
- `/api/host/game-configs` と `/api/host/start-game-config` で、Spreadsheet上の候補から次ゲームを開始できる。前ゲーム参加者は戦歴・セーブデータに保持し、次ゲームの画面にはアクセス後に復元されたプレイヤーだけを表示する。
- 進行途中でも集計済みステージがある場合は、中断ゲームとして履歴保存して次ゲームへ移行できる。

## デプロイ前チェック

- Apps Scriptプロジェクトへ `gas/src/Code.gs` の内容を `Code.gs` として配置する。`appsscript.json` はエディタへ直接貼り付けない。
- スプレッドシートに紐づいた状態で `setupElevatorGameSheets()` を一度実行する。
- 既存Spreadsheetへ再デプロイする場合も、`game_configs` 作成のため `setupElevatorGameSheets()` を再実行する。
- `config` シートの `hostPassword` を本番値へ変更する。
- `game_configs` シートへ次ゲーム候補を追加する。`configId`, `name`, `status=ACTIVE`, `sortOrder`, `configJson` を入力し、`configJson` は既存の設定JSON importと同じ形式にする。
- Apps Scriptで `getClientConfigSnippet()` を実行し、`game/assets/js/config.js` と同じデプロイURL/デプロイIDになっていることを確認する。
- Web Appは `executeAs: USER_DEPLOYING`, `access: ANYONE` でデプロイする。

## API URL受領後の手動検証

- 実GAS Web App URLで `text/plain` POST と `?path=` ルーティングが通ること。
- Host認証後、`hostToken` なしのホストmutationが拒否され、認証済み操作だけ成功すること。
- Host画面を開いたまま `hostToken` 期限が切れた場合、パスワード入力画面へ戻り再認証できること。
- `config` シートの `hostPassword` が数値セルでもHost認証できること。
- 参加登録前Player画面と未認証Host画面で定期ポーリングが発生しないこと。
- Playerが投票受付中だけ10秒間隔で状態取得し、ランキング後は「次へ」押下時のみ確認すること。
- Hostが参加受付中と投票受付中だけ自動取得し、それ以外は操作レスポンスで状態更新すること。
- 同一端末Screen同期モードでHost操作にScreenが追従し、GASへのScreenポーリングが止まること。
- 参加登録、Host認証、投票、戦績取得で読み込み表示が出ること。
- 同一ステージ内でHistoryを再表示しても、本人戦績APIが再取得されずキャッシュ表示になること。
- Host/Screen表示で `/api/player/restore` が発生しないこと。
- 認証済みHost画面で自動集計commitが一度だけ実行されること。
- Player入口URLからHost/Screenに遷移できないこと。
- Player入力中にポーリング再描画で入力フォーカスや値が失われないこと。
- Screen端末で `assets/audio/` のBGM/SE mp3が配置されている場合に、フェーズ変更と結果発表タイムラインに合わせて再生されること。
- Apps Script実行ログに各API呼び出しのJSONログが残ること。
- Host/Screen/Playerの3端末相当で、参加、受付、締切、移動中、集計、Skip、ランキング、最終結果まで通すこと。
- 終了後に `save_data`, `stage_results`, `players`, `game_history`, `stage_settings` が更新されること。
- Host最終結果画面で `game_configs` 候補を読み込み、ACTIVEな候補だけが表示されること。
- Hostが `configId` を選んで次ゲームを開始すると、前ゲーム参加者・UUID・現在SkillはSpreadsheetに保持されるが、次ゲームの画面上の参加者一覧は空で始まり、アクセス後に復元されたプレイヤーだけが表示されること。
- 進行途中で「中断して開始」を実行した場合、集計済みステージだけが `save_data`、`stage_results`、`game_history` に保存され、未集計ステージは保存されないこと。
- 同じ `game_configs` 行を再利用しても、gameId衝突時に `_2`, `_3` が付くこと。
- Player最終結果画面では自動遷移せず、「次へ」押下時だけ次ゲームへ追従すること。
- Screen最終結果画面は表示を維持し、新 `gameId` 検出後に次ゲームへ切り替わること。
- UUID復元で過去SkillとStageSkill履歴が復元されること。
- 端末時計をずらした状態で、カウントダウンと結果発表の同期が許容範囲に収まること。
- 100人規模のjoin/submit/pollで、Lock待ちとSpreadsheet書き込み時間が許容範囲に収まること。
