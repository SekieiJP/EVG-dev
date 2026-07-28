# GAS archive readiness

更新日: 2026-07-29

## 役割

- Firebase RTDBが進行中ゲーム、結果、Skill、公開履歴、次ゲーム設定の正系。
- GAS + Spreadsheetは終了・中断済みゲームのarchive専用。
- クライアントは進行のためにGASをポーリングしない。
- 公開GASルートは`POST /api/archive/export`と`POST /api/archive/recalculate`だけ。

## 実装済み

- Firebase完了ゲームをarchive payloadへ正規化する。
- `archiveId`とgame/player/stage識別子を使った冪等upsert。
- `save_data`、`stage_results`、`stage_settings`、`game_history`、`players`、`archive_log`への出力。
- 9指標、StageSkill履歴、現在Skill（上位5件合計）の再集計。
- Firebase ID token検証、roomId一致、RTDB Host allowlist確認。
- archive失敗をRTDB `archive.status=failed`として残す再送導線。
- final確定済み、または移行で既に`completedGameDetails`へ保存済みの現ゲームをHostから手動送信する導線。
- Firebase正系設定を維持したarchive用`getClientConfigSnippet()`。
- 旧進行APIを`route_()`から到達不能にするarchive-only routing test。

## デプロイ前チェック

- アーカイブ先Spreadsheetのバックアップを作成した。
- `gas/src/Code.gs`を対象Apps Scriptへ反映した。
- `setupElevatorGameSheets()`を実行し、必要な7シートを確認した。
- `config.firebaseApiKey`、`firebaseDatabaseUrl`、`firebaseRoomId`を対象環境と照合した。
- `config.apiKey`を設定した。
- Webアプリを`USER_DEPLOYING` / `ANYONE`で新バージョンdeployした。
- `/exec` URLを取得した。`/dev` URLを本番設定に使っていない。
- `game/assets/js/config.js`の`FIREBASE_ARCHIVE_GAS_URL`と`FIREBASE_ARCHIVE_API_KEY`を設定した。
- アセットquery versionを更新し、公開版を強制再読み込みした。

## 実環境smoke

- allowlist済みHostからarchive exportが成功する。
- 未allowlist uid、無効Firebase token、異なるroomId、誤ったapiKeyが拒否される。
- `archive_log`が`exported`を記録する。
- 5つのarchiveシートに対象ゲームの行があり、StageSkill 0も欠落しない。
- 同じarchiveIdを再送しても行が重複しない。
- 選択gameIdのrecalculateが成功し、別ゲームのサマリを変更しない。
- 一時的な送信失敗後、Hostの「未完了を再送」で`failed`から`exported`へ回復する。
- archive障害中もRTDBの進行、結果、Skill、完了履歴が維持される。
- 2026-06-12終了済みゲームはSkill backfill後、「現在ゲームを保存」で5ステージを送信できる。

本番の操作順、確認値、ロールバックは`docs/operator-action-required-p0-p1.html`を正とする。
