# 次ゲーム開始時のRTDB履歴消失：調査結果と改訂手順

作成日: 2026-07-31
状態: 予防修正r10と削除防止Rulesを本番反映済み。本番履歴復旧は未実施（別承認）。

## 結論

GASアーカイブの仕様ではなく、次ゲームJSON Importの実装不具合である。

既存roomの参加者と現在ステージ結果がともに空の場合、`/api/host/import-config` と
`/api/host/start-game-config` は既存roomを「新規room」と誤判定し、
`completedGames=[]` の初期roomを生成する。その後の全体更新が空の履歴を `null` に変換し、
次のRTDBノードを削除する。

- `completedGameSummaries`
- `completedGamePublicDetails`
- `completedGameDetails`
- `completedGamePlayerDetails`
- `historyPlayers`

ローカル再現では、履歴を持つ空ロビーへImportすると上記5ノードすべてが削除更新になった。
本番データや本番ログには接続していないため、実操作が空ロビーへ至った理由までは未確定だが、
報告されたノード消失と一致する削除経路は確認済みである。

## 原因

1. `game/assets/js/firebase-adapter.js:314-325` のImport判定が、roomの存在ではなく
   `players.length || stageResults.length` を使用している。
2. `game/assets/js/engine.js:110-140` の `createInitialRoom()` は、正しく新規ゲーム用として
   `completedGames=[]` を返す。
3. `game/assets/js/firebase-adapter.js:981-1014` の `writeRestRoomChildren()` が
   現在ゲームだけでなく履歴親ノードも全置換し、
   空オブジェクトを `null` として送る。
4. 既存テストは通常の次ゲーム引継ぎを確認しているが、
   「履歴あり・参加者0・results 0」のImportと履歴親ノードの非削除を検証していない。

これは要件の「設定JSON Importと完全Resetは別操作」「次ゲーム後もRTDB履歴を保持」に反する。

## 改訂手順

### 1. 事故の封じ込め

- 修正版公開まで、HostのJSON Import、同じJSONで再開始、次ゲーム候補からの開始を停止する。
- GAS archive、現RTDB、現在ゲームをそれぞれ読取り専用で退避する。
- 本番復旧はコード修正・テスト・バックアップ完了後に別承認で実施する。

### 2. コード修正

1. 新規初期化は「RTDB roomが存在しない」と確認できた場合だけ許可する。
   既存roomでは参加者・resultsが空でも必ず履歴保持型の次ゲーム生成を使う。
2. 次ゲーム更新では履歴親ノードを更新対象から外す。
   新たに確定するゲームだけを `{gameId}` 単位で追記し、既存gameIdを全置換しない。
3. 更新前に履歴gameId集合を比較し、既存gameIdが1件でも減る更新を
   `history_preservation_failed` として拒否する。
4. `createNextGameRoom()` でも `completedGames` と公開Skill indexを明示的に保持する。
5. 完全削除が必要なResetは別API・別確認画面とし、通常のImportから到達不能にする。

### 3. Rulesの防御

- 完了履歴と `historyPlayers` の書込み権限を子ノード単位へ絞る。
- 通常Host操作では既存履歴の削除を拒否し、作成・同一gameIdの安全な修復だけを許可する。
- 親ノードへの `null` と、複数履歴を縮小する更新がRules emulatorで拒否されることを確認する。
- 管理上の削除が必要な場合だけ、通常クライアントとは分離した管理手順を使う。

### 4. 回帰テスト

- 履歴あり・参加者0・results 0のroomへJSON Importしても全履歴が完全一致する。
- 前日参加者が全員退室する次ゲーム開始後、再度Importしても履歴が残る。
- 同日参加者のSkill履歴を保持し、ゲーム内得点だけを0へ戻す。
- Importの二重クリック、再読込み、別Hostタブ競合でも履歴が減らない。
- final → GAS archive → 次ゲーム → History表示までをE2Eで確認する。
- Rules emulatorで5種類の履歴親ノード削除が拒否される。

## 実装結果

- 既存roomは参加者・resultsが空でも常に履歴保持型の次ゲーム生成を使う。保存済みゲーム状態があり `public` だけ欠損するroomは、安全な新規roomとみなさず `room_state_incomplete` で停止する。
- 5種類の履歴親を共通writerの対象から除外し、final、中断、手動archive修復、Skill backfillでは対象gameId/profileId子だけを非nullでupsertする。
- 既存gameId/profileIdが減る更新は `history_preservation_failed` として、RTDB updateとGAS archiveより前に拒否する。
- 次ゲームでもroomVersionを旧値+1とし、画面のbaseVersion、待機overlay、Rules CASで同一タブと別Hostの競合を防ぐ。
- Rulesは5履歴親と子削除を拒否し、新規ID作成・同一ID修復だけを許可する。親縮小、ID不一致、削除混在updateの原子的拒否テストを追加した。
- UnitとFirebase mock Browser E2Eは成功した。ローカルMacにはJava Runtimeがないが、2026-07-31にNode 22・Java 21のGitHub Actions Verify workflowを追加し、Database Rules emulatorを含む全ステップの成功を確認した。
- 通常クライアントに完全Reset API/画面は追加していない。履歴削除が必要な管理Resetは別権限・別承認で設計する。
- 予防リリース前の本番RTDB全体は読取り専用で一時退避した。GAS/Spreadsheetの所有者バックアップは未実施のため、本番履歴復旧には着手していない。
- コミット `3f82740` をpushし、GitHub Pagesのアセット版 `260731-p0p1r10` と公開adapter本文の完全一致を確認してから本番Rulesをreleaseした。release後Rulesはリポジトリ版と正規化SHA-256 `7e56508a0772ec8b06ecfd3582409cd315a3e3cf4c021d1b2fd2192da1662685` で一致した。
- Rules release後に本番roomを読取り、5種類の履歴ノードが事前バックアップから件数・内容とも不変であることを確認した。実ゲームのImport/次ゲーム開始はデータ変更を伴うため、このリリース確認では実行していない。

## 本番データ復旧手順（修正版公開後・別承認）

1. 復旧直前のRTDB全体、GAS Spreadsheet、archive logを退避する。
2. GAS archiveの `gameId` / `archiveId`、5ステージ、参加者、ランキング、
   StageSkill、確定時プロフィールを照合し、オフラインで復旧payloadを作る。
3. 公開ノードにはUUIDや非公開内訳を含めず、Host詳細・本人詳細・公開詳細を分離する。
4. 現在roomの `meta`、`public`、`config`、`players`、`scores`、`archive` は上書きせず、
   消失した5種類の履歴ノードだけを1回の原子的更新で復元する。
5. gameId件数、5ステージ、参加者数、Skill値、同一archiveIdの非重複を読取りで検証する。
6. HostとHistory画面で過去ゲーム、ステージ得点、通算Skillを確認してから通常運用を再開する。

復旧値を推測で補完しない。GAS archive、保存済みRTDB export、root playerの値が競合する場合は
更新を止め、gameId・stageId単位で差分を解消する。
