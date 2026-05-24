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
8. `?view=settings` でUUIDコピー、名前変更、通信ログを確認する。
9. `?view=history` で累積ランキングと個人統計を確認する。

## GAS確認

Apps Script上で以下を確認する。

1. `setupElevatorGameSheets()` が必要なシートとヘッダーを作成する。
2. `doPost` に `/api/player/join` 相当のpayloadを渡して参加登録できる。
3. `doPost` に `/api/ticket/submit` 相当のpayloadを渡して投票できる。
4. ホスト進行APIで集計後、`current_game` のJSONと `players` シートが更新される。

## 残テスト

- 実GAS Web App URLでのCORS/認証/パスルーティング確認。
- 100人規模のポーリング負荷試験。
- iOS SafariとAndroid Chromeでのタップターゲット、フォーム、localStorage挙動確認。
- スクリーン音声素材追加後の自動再生制限とSkipフェード確認。
