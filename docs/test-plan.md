# Test Plan

## 自動テスト

```sh
node tests/engine.test.js
node tests/multiplayer-flow.test.js
node tests/gas-logic.test.js
```

対象:

- 同一階指定は乗車成功時に成功階数1階・運賃1階分になる。
- 1階から10階の指定は、成功階数10階・運賃10階分になる。
- 定員超過時は当該階の既存乗客と乗車希望者が強制下車になり、既存乗客は強制下車前に人数判定を通過した階数分だけ得点する。
- 禁止階を指定した投票は受理されるが、乗車失敗としてQペナルティのみ発生する。
- E3a区間倍率は成功階単位のP側にのみ適用され、Qペナルティには掛からない。
- E4特別階は人数判定通過後に当該階にいたプレイヤーへ加点される。
- E1予想イベントの正解・無回答点が適用される。
- E1予想イベントで `metric` と `correctAnswer` が両方ある場合は、ゲーム結果メトリクスを優先する。
- E1範囲選択は、数値メトリクスが選択範囲内に入った場合に正解になる。
- E1プレイヤー指名は、予想イベント得点を加える前の最高得点者UUIDで正誤判定する。
- 現在Skill値は最高StageSkillを除外し、2〜5番目を合算する。
- 複数プレイヤーの参加、重複名拒否、投票、棄権、締切、集計、次ステージへの名前反映が破綻しない。
- チケット送信・棄権は受付/カウントダウン中だけ許可し、カウントダウン終了後は拒否する。
- 同一ステージの二重集計を拒否し、累積得点とSkillの二重加算を防ぐ。
- GAS版ロジックでも、不正フェーズ操作、未参加者の棄権、締切後送信、二重集計を拒否する。
- 次ゲーム設定のimportでは、参加者とSkill履歴を保持し、前ゲーム結果を戦歴用に退避する。
- Playerの中間ランキング画面の「次へ」は、ゲーム全体のフェーズを進めない。
- GAS版では、APIキー不一致、hostTokenなし、hostToken期限切れのホスト操作を拒否する。
- GAS版では、`current_game` を複数行チャンクで保存でき、同名ゲームIDに連番を付ける。
- GAS版では、Player向け状態から他人のチケットと発表前の現在ステージ結果を隠す。
- GAS版では、`save_data` に12指標、`stage_results` にStageSkill込みのステージ結果を保存する。

## 複数プレイヤーブラウザハーネス

```sh
python3 -m http.server 8000
```

`http://127.0.0.1:8000/tests/multiplayer-browser-harness.html` を開く。

- Host、Screen、Player A/B/C を同一ページのiframeで並べて操作できる。
- Player A/B/C は `testSlot` クエリでUUID保存先を分けるため、同一ブラウザ・同一localStorage内でも複数プレイヤーとして参加できる。
- Reset Local Roomで `evg.room.v1` とテスト用UUIDを消して、複数人フローを最初から確認できる。

## 手動テスト

1. `python3 -m http.server 8000 -d game` で起動する。
2. `?view=player&testSlot=player-a` と `?view=player&testSlot=player-b` で2名以上参加する。
3. `?view=host` でパスワード `host` を入力する。
4. ホストで「説明」→「受付」を押す。
5. プレイヤーでチケットを購入する。
6. ホストで「締切」を押し、15秒後または「集計」で結果を出す。
7. `?view=screen` でカウントダウン、結果発表、ランキングを確認する。
8. 結果発表中、未到達の強制下車階が赤背景にならず、階数・かご・プレイヤー状態が列分離されて重ならないことを確認する。
9. 結果発表の最終階到達後、Screen端末で画面を自由にスクロールできることを確認する。
10. Player画面では、Screenの最終階演出が終わるまでステージ結果が表示されず、結果発表中の案内だけが出ることを確認する。
11. 中間ランキングでPlayerの「次へ」を押さずにHostが次ステージへ進んでも、Player画面はランキングのまま残ることを確認する。「次へ」を押すとホストの現在状態へ追従することを確認する。
12. Host受付中の参加者一覧に、各プレイヤーの現在Skillが表示されることを確認する。
13. `?view=settings` でUUIDコピー、名前変更、通信ログを確認する。
14. `?view=history` で累積ランキングと個人統計を確認する。
15. 最終結果後にHostで次ゲーム設定JSONをImportし、参加者が残り、得点がリセットされ、Historyに前ゲームの戦歴が残ることを確認する。

## GAS確認

Apps Script上で以下を確認する。

1. `setupElevatorGameSheets()` が必要なシートとヘッダーを作成し、`apiKey` にデプロイIDを設定する。
2. `config` シートの `hostPassword` を本番値へ変更する。
3. `getClientConfigSnippet()` が、デプロイURLとデプロイIDを含む `config.js` 内容を返す。
4. `/api/host/auth` で `hostToken` を取得でき、`hostToken` なしの `/api/host/*` が拒否される。
5. `hostPassword` がSpreadsheet上で数値セルになっていても、同じ数字の入力でHost認証できる。
6. `doPost` に `/api/player/join` 相当のpayloadを渡して参加登録できる。
7. `doPost` に `/api/ticket/submit` 相当のpayloadを渡して投票できる。
8. ホスト進行APIで集計後、`current_game` のチャンクJSONと `players` シートが更新される。
9. 最終結果後、`save_data`、`stage_results`、`stage_settings`、`game_history` が更新される。
10. UUID復元で、現在ゲーム外の過去UUIDから名前とSkill履歴を復元できる。
11. 参加登録前Player画面と未認証Host画面で定期ポーリングが発生しない。
12. Apps Script実行ログにpath、role、uuid、処理時間、エラー種別がJSONで残る。
13. `/api/status` に現在の `roomVersion` を渡すと `unchanged` が返り、フルルームが返らない。
14. `/api/host/commit-result` がHostブラウザで計算した結果roomを保存し、バージョン不一致と二重集計を拒否する。
15. 同一端末Screen同期モードで、Host操作後にGASポーリングなしでScreenが更新される。
16. 参加登録、Host認証、投票、戦績取得中に読み込み表示が出て、通信中は追加操作できない。
17. 同一ゲーム・同一ステージ・同一結果数では、Player本人の個人戦績がローカルキャッシュから表示される。
18. Host/Screen画面の起動時に、Player UUIDが保存済みでも `/api/player/restore` が送られない。
19. `v=player`、`view=player`、URLパラメータなしのPlayer入口でHost/Screenタブに遷移できない。
20. 認証済みHost画面で、締切カウントダウンと移動中演出終了後に自動集計される。
21. 結果発表演出の最終階到達後、Hostがランキングへ進める前にPlayerで個人結果を表示できる。
22. Player入力欄フォーカス中に状態ポーリング再描画で入力が消えない。
23. History画面で全員ランキングは見えるが、個人詳細は本人UUIDの端末だけ表示される。
24. GAS通信失敗時に最大3回まで短いリトライが行われ、通信ログに `api.retry` が残る。

## 残テスト

- 実GAS Web App URLでのCORS/認証/パスルーティング確認。
- 100人規模のポーリング負荷試験。
- iOS SafariとAndroid Chromeでのタップターゲット、フォーム、localStorage挙動確認。
- スクリーン音声素材追加後の自動再生制限とSkipフェード確認。
