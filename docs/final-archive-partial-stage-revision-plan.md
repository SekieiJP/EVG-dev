# final確定時の完了詳細・GASアーカイブ部分欠損：調査結果と修復手順

作成日: 2026-07-31

## 結論

これは `next-game-history-loss-revision-plan.md` が扱う「次ゲームImportで過去のRTDB履歴親が削除された不具合」とは別件である。

本番の現在ゲームは4ステージ分の `rooms/elevator-game-live/results` を保持しているが、final確定時に作られた `completedGameDetails/{gameId}` と同時にGASへ送ったarchive payloadには最終1ステージしか入っていない。final操作のHost mutationが現在ステージの `results/{stageId}` だけをmaterializeしたroomから完了ゲームを作ったことが原因である。

現時点では4ステージ分の正本がRTDB `results`に残っているため、推測による復旧は不要である。修正版公開後、次ゲーム開始前に既存の「現在ゲームを保存」を実行し、`results`親全件から同じgameId/archiveIdを再構築・冪等upsertする。

## 本番で確認した事実

- `meta.schemaVersion = firebase-rtdb-v3-skill-history`
- `public.phase = final`
- 現ゲームの設定・`results`は4ステージ
- `completedGameDetails/{gameId}`は同じgameIdだが最終1ステージだけ
- `archive.status = exported`、pending 0、errorなし
- 5種類の履歴ノードはr10 release直後の読取りから内容hash不変
- 公開GAS `/exec`は必要な7シートが存在する状態で応答し、公開apiKeyを受理した後もFirebase ID tokenなしのarchive POSTを拒否する

値を含む本番room全体は `/private/tmp/evg-p0p1-current-room-20260731.json` へ一時退避した。`/private/tmp`は長期保管先ではなく、ファイル内容を公開リポジトリへ追加しない。

## 原因

通常購読とHost mutationのroom読取りは転送量を抑えるため、現在ステージのticket/resultだけを取得する。これは通常進行には正しいが、次の境界でも同じ部分roomを使用していた。

1. 最終ステージのrankingからfinalへ進むとき
2. JSON ImportまたはRTDB次ゲーム候補で現在ゲームを終了・中断するとき

このため、完了ゲーム、公開詳細、本人詳細、GAS payload、同日参加者の継続判定が現在ステージだけを見て生成され得た。RTDBの `results`親自体はこのfinal操作で削除されないため、次ゲーム開始前なら完全修復できる。

## 修正方針

- JSON Importと次ゲーム候補開始では、既存roomをmaterializeする前に `results`親全件を読む。
- `advance`では、保存済みphaseがrankingかつ最終ステージの場合だけ `results`親全件を読む。
- 中間ステージの通常advanceは従来どおり現在ステージ子だけを読み、不要な全件転送を増やさない。
- 全件読取りが失敗した場合は、RTDB更新とGAS呼出しより前に操作を停止する。
- 複数ステージのfinal、Import、次ゲーム候補、同日継続、読取り失敗時の副作用0をUnit testへ固定する。
- Javaが利用できるGitHub ActionsでRules emulator testを実行し、ローカルMacのJRE不足を補う。

## 実装・公開状況

- 修正コミット: `21ad203`
- 公開アセットversion: `260731-p0p1r11`
- Pages workflow: 成功
- 公開adapter SHA-256: `61eb22acfa1a69ea31c307dc315d0364208fecbbb8ad1edde22e1873f5f38dc2`。ローカル本文と一致
- Verify workflow: Unit/static、50人×20ステージ負荷モデル、Realtime Database Rules emulator、Playwright E2Eの全ステップ成功
- Firebase Rules: r10から本文変更なし。今回のreleaseでは再deployしていない
- 残作業: allowlist済みHostによる現在ゲーム再保存、RTDB 4ステージ確認、Spreadsheetの同一gameId/archiveId 4ステージ・重複なし確認、recalculate。その完了までは次ゲーム操作を停止する

## 2026-08-01 読取り専用再監査

- 本番roomをFirebase CLIで再取得した。ファイル全体のSHA-256はr11公開前の退避と同じ `7f46ef0064a3f770aa5493adfcdaf83bf16c3e87d79c597e41517aac870b5bcf` である。
- `schemaVersion=v3`、`phase=final`、`roomVersion=21`、現在参加者6人、`results` 4ステージ・24人分は維持されている。
- 現gameの完了詳細は1ステージのままで、archiveのrequested/exported/completed時刻、履歴5系統、`results`の内容hashも前回監査から不変である。したがってr11公開後の「現在ゲームを保存」は未実行である。
- GAS endpointを副作用なしで再probeし、キーなしの拒否、設定済みapiKeyの受理、無効Firebase tokenの拒否を確認した。
- 運用者から指定された本番Spreadsheet `EVG2026` をGoogle Sheets APIで読取り専用監査した。archive用7シートとヘッダは `gas/src/Code.gs` の定義に一致し、互換用の空の `current_game` を含む8タブ構成だった。
- 現gameは同一gameId/archiveIdについて `archive_log=exported` 1件、`save_data` 6件、`players` 6件、`stage_settings` 4件、`game_history` 1件を保持する一方、`stage_results` は最終ステージ6件だけである。`game_history` と6人の `save_data` も `stageCount=1` であり、現行の複合キーに重複はない。RTDBとSpreadsheetの双方が同じ部分保存状態であることを確認した。
- 修復前RTDBは `/private/tmp/evg-p0p1-current-room-reaudit.json`、root playerは `/private/tmp/evg-p0p1-root-players-reaudit.json` に一時退避した。機微データを含むためGitへ追加せず、運用者がアクセス制御された長期保管先へ移す。

## 本番修復手順

詳細な画面操作は `docs/operator-action-required-p0-p1.html` を正とする。

1. 次ゲーム開始、JSON Import、同じJSONで再開始を停止する。
2. 現在のRTDB全体とSpreadsheetをバックアップする。
3. 修正版クライアントのPages公開完了を確認し、allowlist済みHostタブを強制再読み込みする。
4. Hostの「戦績アーカイブ → 現在ゲームを保存」を1回実行する。
5. RTDBの同じ `completedGameDetails/{gameId}` が4ステージになり、公開詳細・本人詳細も同じgameIdで修復されたことを確認する。
6. Spreadsheetの同じarchiveId/gameIdが4ステージへupsertされ、重複行がないことを確認する。
7. 「保存済み戦績を再集計」を実行し、対象gameIdだけが再集計されたことを確認する。
8. 上記確認後にのみ次ゲーム操作を再開する。

この修復は現在RTDBに残る4ステージ結果を正本にする。以前の次ゲームImportで既に消失した別ゲームの履歴復旧は、`next-game-history-loss-revision-plan.md` の別承認手順で行う。
