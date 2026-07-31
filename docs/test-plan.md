# Test Plan

本計画では Firebase Realtime Database（RTDB）を進行中ゲームの正系とする。GAS は終了・中断済みゲームのアーカイブだけを対象とし、進行、投票、フェーズ同期のテスト対象にはしない。

## 自動テスト

```sh
npm run test:unit
npm run test:load
npm run test:rules-emulator
npm run test:e2e
```

### Unit tests

- 同一階指定、強制下車、禁止階、E1〜E8、倍率計算、二重集計拒否を検証する。
- StageSkill と現在Skillを検証する。現在Skillは全StageSkillの上位5件の合計であり、最高値を除外しない。
- 累積戦歴の9指標（現在Skill、平均Skill、合計Skill、最高得点、参加ゲーム数、参加ステージ数、強制下車回数、予想イベント正解率、優勝回数）を検証する。
- 同日継続は、次ゲーム開始日と同じAsia/Tokyo日付にticketを提出したプレイヤーだけを残し、ゲーム内score/ticket/stage resultを初期化することを検証する。
- final自動確定、JSON Import、次ゲーム候補開始は、現在ステージだけでなく保存済み`results`親全件を読んでから完了ゲームとGAS payloadを作る。複数ステージの完了詳細と同日継続判定が欠けず、全件読取り失敗時はRTDB更新とGAS呼出しがともに0回であることを検証する。
- 5種類の履歴ノードがある参加者0人・results 0件の既存ロビーへJSON Importと次ゲーム候補開始を行い、旧gameIdと公開Skill profileIdが減らず、履歴親へのnull/全置換が生成されないことを検証する。
- 次ゲーム開始前の履歴集合検査で旧gameIdまたはprofileIdが欠ける場合は `history_preservation_failed` となり、RTDB updateとGAS archive呼出しがともに0回であることを検証する。
- 同一baseVersionの次ゲーム開始、再読込み後の再送、別Host競合では先着以外をversion conflictとして扱い、履歴件数が減らないことを検証する。
- 締切カウントダウンは既定10秒、1〜60秒のHost設定を時間計算へ使い、次ゲームへ引き継ぐことを検証する。
- RTDB小ノードのserializer/deserializer、公開履歴payload、本人詳細payload、GAS archive payloadを検証する。

### RTDB Rules emulator tests

- 未認証者は読み書きできない。
- Playerは自分のプロフィール、ticket、ticketPresenceだけを書け、他人のデータ、`public`、`results`、`scores` は書けない。
- Host allowlist uidだけが `public` を含む原子的commit、設定、次ゲーム候補、結果commit、archive状態を変更できる。
- `roomSettings/countdownSeconds` はHostだけが書け、1〜60の整数以外を拒否する。
- `lobby -> stage_intro -> voting -> countdown -> tallying/reveal -> ranking -> stage_intro/final` 以外の遷移を拒否する。
- phase/version CASは、古いphaseまたは `roomVersion` からのmulti-location updateを全体として拒否する。
- gameIdが変わる次ゲーム開始も `roomVersion + 1` を必須とし、同じ旧versionからの後発更新を全体拒否する。
- 同じ `results/{stageId}` の二重作成を拒否する。
- 公開履歴に他人のticket、予想回答、内訳、StageSkill履歴、uid/UUIDが含まれず、個人詳細は本人だけ、Host詳細はHostだけが読める。
- 5種類の履歴親へのnull/縮小置換、既存gameId/profileId子のnull、path keyとpayload内IDの不一致を拒否する。新規IDの作成と同一IDの非null修復は許可し、許可更新と削除を混ぜたmulti-location updateは副作用ごと原子的に拒否する。

### RTDB integration tests

- Host、Player A/B、Screenが小ノード購読だけで全フェーズを完走する。room rootの購読・transactionが発生しない。分散した枝の原子的確定にはDBルートへの疎なmulti-location updateだけを使う。
- Host操作後、Player/Screenは定期HTTP pollingや「次へ」操作を必要とせずフェーズへ自動追従する。
- `/.info/serverTimeOffset` を使い、異なるクライアント時計でも同じ締切・演出開始時刻を描画する。
- 結果commitが一つのmulti-location updateで `results`、`scores`、`playerStats`、本人履歴、`operations` を反映し、途中状態を公開しない。
- Host再読込、ネットワーク一時切断、別Hostの競合操作で、RTDBの確定phase/versionが戻らない。
- 空ロビーImportと `update-config` は既存履歴親を更新対象に含めず、中断・final・backfillは新規または修復対象のgameId/profileId子だけを原子的にupsertする。
- finalまたは次ゲーム境界では全`results`を取得し、設定ステージ数・保存済みresult数・完了詳細/GAS payloadのstage集合を一致させる。通常の中間ステージadvanceでは全`results`親を読まない。
- final確定からGAS archive送信、次ゲーム開始、fresh History取得までを通し、archive失敗の有無にかかわらずRTDB完了履歴と現在Skillが残る。
- Player/Screen/未認証Hostの初回アクセスではroomを作成しない。allowlist済みHostのセットアップだけが作成する。
- finalまたは中断後、GAS archive失敗でもゲームは完了し、`archive.status=failed` から同じarchiveIdを再送できる。
- 次ゲーム候補はRTDB `nextGameConfigs` から読み、Spreadsheet `game_configs` への読取りを行わない。

### Browser E2E

ローカルmockでは1つのBrowser Context内の独立pageを使い、`testSlot`ごとにHost、Player A、Player B、Screenの認証IDを分ける。実Firebaseの本番前smokeでは独立Browser Contextまたは物理端末を使う。

1. Host allowlist uidでログインし、締切カウントダウンの既定10秒を任意値へ変更してroom settingsへの保存を確認する。Player A/Bが匿名ログインして参加する。
2. Hostがステージ説明、投票開始、締切、結果発表、ランキング、次ステージ/最終結果を進める。
3. Playerはticketを送信し、結果発表後に本人のscore/StageSkill/現在Skillを確認する。
4. Playerがランキングに留まるボタンを押さなくても、Hostの次フェーズへ自動追従することを確認する。
5. Screenでカウントダウン、結果発表、音声トリガー、最終階後のスクロールを確認する。
6. タイトル/公開履歴には公開サマリだけが見え、Player AからPlayer Bの個人詳細が読めないことを確認する。
7. final後にHostがRTDBのACTIVEな次ゲーム候補を選び、同日ticket提出者だけが継続することを確認する。
8. 公開履歴を持つ空ロビーでJSON Importし、Host再読込み後と新規History画面の双方で旧ゲーム、ステージ得点、非ゼロSkillが残ることを確認する。同一タブの同期2clickは待機表示で1回に抑止する。

ローカルFirebase mockのBrowser E2Eは画面・Engine・mock serializerの回帰を対象とし、本番RTDBのmulti-location writer、Rules、別Host CAS、GAS実送信の代替とはしない。これらはadapter integration、Rules emulator、実Firebase smokeで別々に確認する。

## GAS archive確認

1. finalまたは中断後のarchive payloadが `archiveId` と `gameId` を含むことを確認する。
2. 同一archiveIdの再送がSpreadsheetの `save_data`、`stage_results`、`stage_settings`、`game_history` を二重作成しないことを確認する。
3. `archive_log` に成功・失敗・エラーが残り、失敗時にRTDBの `archive.status=failed` と再送導線が表示されることを確認する。
4. GAS停止中でも、RTDBだけで進行中ゲームを最後まで完走できることを確認する。

## 負荷・実機テスト

- 50 Player bot + Host + Screenで、同時接続、ticket submit、phase transition、Screen/Player反映遅延、RTDB download bytes、Rules拒否数を測定する。
- 100人同時接続の目標を満たせない場合は、購読粒度を見直し、SparkからBlazeへの移行を判定する。
- iOS Safari、Android Chrome、主要PCブラウザで匿名Auth、RTDB再接続、フォーム、音声の自動再生制限を確認する。
