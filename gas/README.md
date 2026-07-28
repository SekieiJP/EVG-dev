# GAS archive adapter

Firebase Realtime Database（RTDB）がゲーム進行・結果・現在Skill・次ゲーム設定の正系です。GAS + Spreadsheetは、終了または中断済みゲームの二次アーカイブだけを担当します。

`gas/src/Code.gs` の公開ルートは次の2つだけです。

- `POST /api/archive/export`
- `POST /api/archive/recalculate`

旧進行helperは移行参照用として残っていますが、`route_()`から到達できません。GASを状態取得、投票、Host進行、次ゲーム選択、Player復元の通信先には使用しません。

## セットアップ

1. アーカイブ先Spreadsheetをバックアップする。
2. Spreadsheetに紐づくApps Scriptの`Code.gs`へ`gas/src/Code.gs`を反映する。
3. `setupElevatorGameSheets()`を1回実行し、要求されたSpreadsheet・外部HTTPアクセス権限を承認する。
4. 次のシートを確認する。
   - `config`
   - `save_data`
   - `stage_results`
   - `players`
   - `stage_settings`
   - `game_history`
   - `archive_log`
5. `config`シートの`firebaseApiKey`、`firebaseDatabaseUrl`、`firebaseRoomId`が対象Firebase環境と一致することを確認する。
6. `apiKey`は誤接続防止用の識別値として設定する。認可はAPI key単独ではなく、Firebase ID tokenと`roles/hosts/{uid}`で行う。
7. Webアプリを「次のユーザーとして実行: デプロイしたユーザー」「アクセス: 全員」で新バージョンデプロイする。
8. `/exec` URLを`game/assets/js/config.js`の`FIREBASE_ARCHIVE_GAS_URL`、`apiKey`を`FIREBASE_ARCHIVE_API_KEY`へ反映して静的サイトを再公開する。

`getClientConfigSnippet()`はFirebaseを正系のまま保ち、現在のWebアプリURLとarchive API keyを設定した現行形式の`EVG_BUILD_CONFIG`を返します。出力内容と対象環境を確認してから使用してください。

## 認証

archiveリクエストは次をすべて満たす必要があります。

- `config.apiKey`とリクエストの`apiKey`が一致する。
- Firebase ID tokenをIdentity Toolkitで検証できる。
- リクエスト`roomId`が`config.firebaseRoomId`と一致する。
- RTDB `rooms/{roomId}/roles/hosts/{uid}`が`true`である。

Webアプリを公開アクセスにしても、allowlist済みHost以外はSpreadsheetへ書き込めません。

## 保存と再送

- `archiveId + gameId + uuid`等の複合キーでupsertし、同一archiveの再送を冪等にする。
- `save_data`へプレイヤー×ゲームの9指標を保存する。
- `stage_results`へプレイヤー×ステージの得点とStageSkillを保存する。
- `stage_settings`へ使用済みステージ設定を保存する。
- `game_history`へゲームサマリとランキングを保存する。
- `players`はUUID単位のarchive mirrorとして更新する。正系プロフィールはRTDB root `players/{uid}`である。
- `archive_log`へ受付・完了・失敗状態を残す。

GAS障害や設定不足はRTDBの進行・Skill・完了履歴を巻き戻しません。Host画面に`failed`を残し、設定修正後に「未完了を再送」を実行します。

詳細な本番手順と復旧方法は`docs/operator-action-required-p0-p1.html`を参照してください。
