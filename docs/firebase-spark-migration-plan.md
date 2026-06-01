# Firebase Spark移行計画

更新日: 2026-06-01

## 目的

現行のGitHub Pages + GAS + Spreadsheet構成を保全したまま、Firebase Sparkで動作するリアルタイム構成へ段階移行する。目標は50人が2時間で20ステージ遊んでも、Host/Screen/Playerの状態反映が遅れにくく、GASの単一ロックやSpreadsheet全体書き戻しに依存しない構成にすること。

現行構成へ戻すため、移行開始前のHEADを `preserve-gas-github-pages-20260601` ブランチとして保全した。Firebase移行作業は `firebase-spark-migration` ブランチで進める。

## Spark前提の制約

Firebase公式料金ページとRealtime Database制限ページを前提にする。

- SparkのRealtime Databaseは同時接続100、保存1GB、ダウンロード10GB/月を上限に見る。
- SparkではCloud Functionsを本番実行基盤として使わない。Host操作検証や集計は、初期移行ではクライアント + Realtime Database Rulesで成立する範囲に寄せる。
- Sparkの無料枠を本番利用する場合、50人 + Host + Screen + 予備端末で接続数が100に近づかないよう、見学用画面や複数タブを抑制する。
- Blazeへ移行できる設計余地は残す。特にCloud Functionsによるサーバ集計、管理API、履歴集計の自動化はBlaze移行後の拡張点にする。

参照:

- https://firebase.google.com/pricing
- https://firebase.google.com/docs/database/usage/limits
- https://firebase.google.com/docs/database/security

## 採用方針

初期Firebase版は、静的SPA配信は維持し、Realtime Databaseをゲーム中のSingle Source of Truthにする。Spreadsheetは進行中状態の保存先から外し、必要であればゲーム終了後のエクスポート先や運営バックアップに限定する。

GAS版で負荷削減のために入れた10秒ポーリング、結果発表中の限定フェッチ、Playerの「次へ」押下取得は、Firebase版では原則リアルタイム購読へ戻す。ただし、巨大room購読はしない。画面ごとに必要な小さいノードだけを購読する。

## 50人本番の負荷モデル

前提:

- Player 50人、Host 1台、Screen 1台、予備操作端末2台まで。
- 2時間で20ステージ。
- 1ステージあたりPlayer ticket writeは最大50件、Host操作は5〜8件。
- Playerは `public`、現在ステージ設定、本人ticket、本人resultを購読する。
- HostはPlayer一覧、投票数、Host操作ログ、全ticket、結果を購読する。
- Screenは表示に必要な集約済みノードと結果タイムラインを購読する。

概算:

- ticket write: 50 * 20 = 1,000回。
- Host command/state write: 20 * 8 = 160回程度。
- join/restore/rename等を含めても1イベントあたり2,000 write未満を目標にする。
- ダウンロードは差分購読前提で1イベント数百MB以内を目標にする。全room再配信型にすると10GB/月無料枠を消費しやすいため禁止する。

## データ構造

ルートはイベント単位の `rooms/{roomId}` と、UUID単位の `players/{uid}` に分ける。`roomId` は単一ルーム運用でも固定値ではなく、イベントごとに発行する。

```text
rooms/{roomId}
  meta
    title
    schemaVersion
    createdAt
    activeGameId
    hostUid
    status
  public
    phase
    currentStageIndex
    currentStageId
    roomVersion
    serverOffsetBase
    countdownEndsAt
    tallyingEndsAt
    animationStartedAt
    animationSkippedAt
    playerCount
    submittedCount
    abstainedCount
  config
    gameMeta
    settings
    stages/{stageId}
  players/{uid}
    name
    connected
    joinedAt
    lastSeenAt
    pendingName
  playerStats/{uid}
    currentSkill
    stageSkillHistory
    updatedAt
  tickets/{stageId}/{uid}
    boardFloor
    exitFloor
    predictions
    abstained
    submittedAt
  ticketPresence/{stageId}/{uid}
    status
    updatedAt
  results/{stageId}
    summary
    timeline
    rankings
    players/{uid}
  scores/{uid}
    total
    updatedAt
  operations/{operationId}
    at
    actorUid
    actorName
    action
    baseVersion
  hostSession
    activeHostUid
    tokenHash
    expiresAt

players/{uid}
  profile
    currentName
    currentSkill
    stageSkillHistory
    updatedAt
  history/{gameId}
    summary
  stageResults/{gameId_stageId}
    stageSkill
    score
    status
```

### 購読単位

- Player: `rooms/{roomId}/public`, `rooms/{roomId}/config/stages/{currentStageId}`, `rooms/{roomId}/players`, `rooms/{roomId}/playerStats/{uid}`, `rooms/{roomId}/tickets/{stageId}/{uid}`, `rooms/{roomId}/results/{stageId}/players/{uid}`, `rooms/{roomId}/scores/{uid}`。
- Host: `public`, `players`, `playerStats`, `ticketPresence/{stageId}`, `tickets/{stageId}`, `operations`。集計時だけ全ticketを読む。
- Screen: `public`, `players`, `ticketPresence/{stageId}`, `results/{stageId}/summary`, `results/{stageId}/timeline`, `results/{stageId}/rankings`。

Playerへ他人のticketと他人のSkill履歴を配信しない。Screenも通常はticket詳細を購読せず、投票人数や結果演出に必要な集計済みデータだけを見る。

## 書き込みルール

- Playerは自分の `players/{uid}` の一部、本人ticket、本人presenceだけを書ける。
- Hostだけがphase、config、results、scores、operationsを書ける。
- Host操作は `roomVersion` を使って二重操作を防ぐ。SparkではCloud Functionsが使えない前提なので、初期版はtransactionを使って `public/roomVersion` とphaseを同時更新する。
- ticketは投票受付中だけ書けるよう、Rulesで `phase == "voting"` または `phase == "countdown"` と締切時刻を確認する。ただしRTDB Rulesだけで厳密なサーバ時刻比較を完全に表現しにくい箇所は、クライアント側検証とHost集計時の再検証を併用する。
- 集計結果は初期版ではHostブラウザが計算して `results` と `scores` に書く。Blaze移行後はCloud Functionsで再計算・検証する。

## 仕様緩和と快適性

Firebase版ではGAS負荷対策のための待ちを減らす。

- Playerのフェーズ追従は10秒ポーリングではなく即時購読にする。
- 投票中は自分の送信状態と全体の提出人数を即時表示する。
- 中間ランキング後の「次へ」は、サーバ再取得ボタンではなく本人画面の閲覧状態解除ボタンにする。Hostが次ステージへ進めた場合は購読により自動で次フェーズへ入れる。
- Screen別端末でもHost操作に即時追従する。同一端末BroadcastChannelは補助最適化として残せるが必須ではない。
- Host画面の結果発表Skipは廃止し、演出完了後に単一の「次へ」ボタンで順位表示へ進める。

## 段階移行

1. Firebase設定とRTDB Rules雛形を追加する。
2. 既存 `engine.js` を維持し、通信層をGAS adapterとFirebase adapterに分ける。
3. Firebase Auth匿名ログインを追加し、既存UUIDをAuth uidとは別の表示用/復旧用IDとして扱う移行方針を決める。
4. `room` 全体保存をやめ、上記ノードへ分割してjoin/submit/host advanceを実装する。
5. Host/Screen/Player/Historyの購読単位を画面別に分ける。
6. GAS版とFirebase版をビルド時定数で切り替え、同じUIで比較できるようにする。
7. 50人相当のブラウザ負荷試験を追加し、ダウンロード量と操作遅延を測る。
8. 必要に応じてBlaze + Cloud Functions版のサーバ検証へ進む。

## Sparkで残るリスク

- 100同時接続上限に余裕が大きくない。50人本番では、複数タブや見学者を含めると接続数が増える。
- サーバ集計や強いHost権限検証をCloud Functionsへ逃がせない。Hostブラウザを信頼する部分が残る。
- ルールだけで複雑なフェーズ遷移や締切時刻を完全検証するのは難しい。
- 10GB/月ダウンロード枠は、全room購読や大きいtimeline再送で超過し得る。

## Blaze移行判断

以下のいずれかに当てはまる場合はBlazeへ移行する。

- 参加者が70人を超える、または見学/運営端末込みで80接続を超えそうなイベント。
- 複数ルームや複数イベントを同月に運用する。
- Hostブラウザ集計を信用せず、サーバ側で集計・検証したい。
- 履歴集計、Spreadsheet/CSVエクスポート、管理者操作ログを自動化したい。

50人・2時間・20ステージを快適に運用するだけなら、初期構成はSparkで成立させる。ただし本番安定性の観点では、Blaze有効化 + 予算アラートの方が接続数と将来拡張に余裕がある。
