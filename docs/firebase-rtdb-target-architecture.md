# Firebase RTDB 目標アーキテクチャ

更新日: 2026-06-02

## 目的

エレベーターゲームの本番進行中状態を Firebase Realtime Database に一本化し、Host、Player、Screen が同じフェーズと同じステージ状態を即時に参照できる構成へリファクタリングする。

この文書は、現行UIや `engine.js` の互換維持よりも望ましい目標構成を優先する。既存のGASモード、localStorage進行モード、GAS互換adapter、root room transaction は廃止対象とする。今後の抜本的リファクタリングでは、この文書を現行実装より優先する設計基準として扱う。

## 採用構成

```text
GitHub Pages
  static SPA
  Firebase Web SDK
  role-specific UI

Firebase Authentication
  Anonymous Auth for players and devices
  host uid allowlist for Host authority

Firebase Realtime Database
  active game state
  role-scoped subscriptions
  rules-enforced write boundaries

Realtime Database Rules
  role validation
  phase transition validation
  player self-write validation
  payload shape validation

GAS + Spreadsheet
  archive only
  save_data / stage_results / players / game_history export
  no active game phase control
```

## 非採用

- GASを進行中ゲームの状態管理、フェーズ遷移、投票受付、結果配信に使わない。
- localStorageを進行中ゲームのSingle Source of Truthにしない。
- RTDBの `rooms/{roomId}` rootを丸ごと購読しない。
- RTDBの `rooms/{roomId}` root transactionでHost操作を処理しない。
- Player、Screen、未認証Hostの初回アクセスでroomを自動作成しない。
- クライアントに埋め込んだパスワードだけでHost権限を保護しない。Rulesはクライアント秘密値を安全に検証できないため。

## IDと権限

### ID

- `roomId`: イベントまたは開催回ごとに発行する。固定値 `elevator-game-live` は開発・単一イベント運用の暫定値に限定する。
- `gameId`: room内で開始されるゲーム単位のID。同名同日衝突時は連番を付ける。
- `uid`: Firebase Anonymous Auth の uid。端末/ブラウザプロファイル単位の認証主体。
- `playerId`: 原則として `uid` と一致させる。将来、復旧コードや外部IDを導入する場合も、RTDB書き込み権限は `auth.uid` を基準にする。

### Host権限

目標構成ではHost権限を次のどちらかで付与する。

1. 運営者が事前にHost端末で匿名ログインし、その `uid` を `rooms/{roomId}/roles/hosts/{uid}: true` に登録する。
2. 開催前セットアップCLIまたはFirebase ConsoleでHost uid allowlistを登録する。

Spark + RTDB Rulesのみでは、運営パスワードや招待コードの秘匿検証を安全に実装できない。パスワード入力UIを残す場合でも、それは誤操作防止のローカルUIロックであり、サーバ権限は `roles/hosts/{uid}` で判定する。

Blazeへ移行する場合は、Cloud FunctionsでHost招待コードを検証し、Custom ClaimsまたはRTDB role nodeを発行する構成へ拡張する。

## RTDBデータモデル

```text
rooms/{roomId}
  meta
    schemaVersion
    roomId
    title
    createdAt
    updatedAt
    activeGameId
    status                 # setup | active | finished | archived

  roles
    hosts/{uid}: true

  public
    gameId
    phase                  # lobby | stage_intro | voting | countdown | moving | reveal | ranking | final
    roomVersion
    currentStageIndex
    currentStageId
    phaseStartedAt
    countdownEndsAt
    movingEndsAt
    animationStartedAt
    playerCount
    submittedCount
    abstainedCount
    resultCommittedAt

  config
    gameMeta
    settings
      hostUiMode
      countdownSeconds
      movingSeconds
      revealSecondsPerFloor
    stages/{stageId}
      name
      params
      events

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
    clientVersion

  ticketPresence/{stageId}/{uid}
    status                 # none | submitted | abstained | error
    updatedAt

  results/{stageId}
    summary
      startedAt
      completedAt
      totalBoarded
      forcedOffCount
    timeline
    rankings
    players/{uid}
      score
      status
      stageSkill
      breakdown
      predictionBreakdown

  scores/{uid}
    total
    updatedAt

  operations/{operationId}
    at
    actorUid
    actorName
    action
    expectedPhase
    nextPhase
    baseVersion
    result
    error

  archive
    requestedAt
    requestedBy
    status                 # none | queued | exported | failed
    archiveId
    error

players/{uid}
  profile
    currentName
    currentSkill
    updatedAt
  history/{gameId}
    summary
  stageResults/{gameId}_{stageId}
    score
    status
    stageSkill
    updatedAt

archives/{archiveId}
  roomId
  gameId
  createdAt
  status
  payloadVersion
  summary
```

## 画面別購読

全画面で `rooms/{roomId}` root購読は禁止する。画面は必要な小ノードだけを購読し、クライアント内でViewModelを組み立てる。

### Host

常時購読:

- `meta`
- `roles/hosts/{uid}`
- `public`
- `config`
- `players`
- `playerStats`
- `ticketPresence/{currentStageId}`
- `operations`
- `scores`

必要時購読:

- `tickets/{currentStageId}`: 集計時、投票状況確認時。
- `results/{currentStageId}`: 結果確認、順位表示時。
- `archive`: アーカイブ状態表示時。

### Player

常時購読:

- `public`
- `config/stages/{currentStageId}`
- `players` の表示名だけ、または予想選択に必要な投影用player list。
- `players/{uid}`
- `playerStats/{uid}`
- `ticketPresence/{currentStageId}/{uid}`
- `tickets/{currentStageId}/{uid}`
- `scores/{uid}`

フェーズ別購読:

- `results/{currentStageId}/players/{uid}`: 結果表示可能時。
- `results/{currentStageId}/rankings`: ranking/final表示時。必要ならTop Nだけに分割する。

Playerに他人のticket詳細と他人の個人内訳を配信しない。

### Screen

常時購読:

- `public`
- `config/stages/{currentStageId}`
- `players` の表示名/接続状態。
- `ticketPresence/{currentStageId}`

フェーズ別購読:

- `results/{currentStageId}/summary`
- `results/{currentStageId}/timeline`
- `results/{currentStageId}/rankings`
- `scores`

Screenは演出に必要な集約済み結果を購読する。投票中に全ticketを購読しない。

### History/Archive

通常ゲーム中のUIからはRTDBの `players/{uid}/history` と `archives` の要約を読む。Spreadsheet由来の詳細履歴が必要な場合だけ、GAS archive read APIを使う。

## 書き込みモデル

### Player writes

Playerは次だけを書ける。

- `players/{uid}` の自分の表示名、接続状態、lastSeen。
- `tickets/{stageId}/{uid}` の自分のticket。
- `ticketPresence/{stageId}/{uid}` の自分の提出状態。

Rulesで `auth.uid == uid` を必須にする。ticketは `public.phase == "voting"` の間だけ作成・更新できる。締切後の猶予を認める場合は `countdown` 中の再送だけ許すなど、仕様として明示する。

### Host writes

Hostは `roles/hosts/{auth.uid} == true` の場合だけ、以下を書ける。

- `public` のphase、roomVersion、時刻。
- `config`
- `results`
- `scores`
- `operations`
- `archive`

Host操作はroot transactionではなく、対象ノード単位に分解する。

禁止:

- `rooms/{roomId}` rootをtransaction/update/setする。
- `roomFromFirebaseNodes(undefined)` から初期roomを作ってHost操作する。
- root transactionのローカルキャッシュを信頼してフェーズ判定する。

### Phase transition

フェーズ遷移は `public` ノードのtransactionで行う。

```text
transaction rooms/{roomId}/public
  require current phase == expectedPhase
  require roomVersion == baseVersion
  set next phase
  set phaseStartedAt / countdownEndsAt / movingEndsAt
  increment roomVersion

after success
  write operations/{operationId}
```

Rulesでは `data.child('phase')` と `newData.child('phase')` の組み合わせを検証し、不正な飛び越しを拒否する。

### Result commit

結果発表開始時はHostブラウザがticketを読み、決定的な集計関数で結果を計算する。

書き込みは以下の順序にする。

1. `public` transactionで `countdown` または `moving` から `reveal` へ進め、`roomVersion` を増やす。
2. 同じ `stageId` に対して `results/{stageId}` を作成する。
3. `scores/{uid}` と `playerStats/{uid}` を更新する。
4. `operations/{operationId}` にcommit結果を書く。

二重集計を防ぐため、Rulesまたはtransaction前チェックで `results/{stageId}` が既存なら拒否する。Sparkでは完全なサーバ再計算ができないため、Blaze移行時にCloud Functionsで再計算検証を追加する。

## GAS Archive

GASは進行中状態を扱わない。役割はアーカイブ保存に限定する。

### Archive payload

Hostがfinal後、または中断保存時に、RTDBから以下をまとめてGASへ送る。

- game summary
- final rankings
- player save data
- stage results
- stage settings
- game history
- interrupted flag

GASはSpreadsheetへ追記またはupsertする。`archiveId` と `gameId` で冪等にし、同じarchiveを再送しても二重保存しない。

### Archive status

GAS保存の成否はRTDBにも戻す。

```text
rooms/{roomId}/archive
  requestedAt
  status: queued | exported | failed
  archiveId
  error
```

GAS障害時もゲーム進行は止めない。Host画面に「アーカイブ未完了」と再送ボタンを出す。

## クライアント構成

### モジュール境界

```text
firebase/
  auth-session
  room-subscriptions
  phase-commands
  player-commands
  result-commit
  archive-client

domain/
  config-normalizer
  ticket-validator
  scoring
  phase-model
  archive-schema

ui/
  host
  player
  screen
  history
  debug
```

`engine.js` の巨大room前提APIは、段階的に小ノード入力の純粋関数へ分割する。集計関数は `config/stage + players + tickets/stage + scores + playerStats` を入力にし、RTDBのroot roomを要求しない。

### Client state

クライアントはRTDB購読からViewModelを作る。進行中room全体をlocalStorageへ保存しない。

localStorageに残してよいもの:

- Firebase Authとは別のUI設定。
- Player表示名の入力下書き。
- 音量、ミュート、デバッグ表示設定。
- ranking画面の閲覧状態。ただしroomスナップショットではなく、`gameId/stageId/seenAt` 程度の小さいview stateにする。

localStorageに保存しないもの:

- phase
- currentStageIndex
- tickets
- results
- scores
- roomVersion

## Debug UI

Host画面には常に `internal-status` を表示する。

最低限表示する項目:

- `roomId`, `gameId`
- `phase`, `phaseLabel`, `roomVersion`
- `currentStageId`, `currentStageIndex`
- `auth.uid`
- `isHostAllowed`
- `subscriptionRole`
- `baseSubscriptions`, `stageSubscriptions`
- `lastRemoteRoomAt`, `lastRemoteSource`
- `lastCommand`
- `lastApi`
- `lastRulesError`
- `players`, `currentStageTickets`, `stageResults`
- `archive.status`

Host操作エラー時は必ず以下をログ化する。

- action
- expectedPhase
- UI上のphase/version/stageId
- command送信直前に読んだ `public`
- transactionが見た `public`
- response error
- forced refresh後のphase/version/stageId

Player/Screenにも通信ログを持つ。Screenは通常投影を邪魔しないよう `?debug=1` のときだけ表示する。

## Rules方針

Rulesは「誰が、どのノードを、どのフェーズで書けるか」を絞る。

主な検証:

- `auth != null`
- Host write: `rooms/{roomId}/roles/hosts/{auth.uid} == true`
- Player self write: path uid equals `auth.uid`
- ticket write: current phase is `voting`
- phase transition: allowed transition and `roomVersion + 1`
- result create: target `results/{stageId}` does not exist
- score write: Host only
- archive status update: Host only

Rulesだけで難しい検証:

- 運営パスワードの秘匿検証。
- 複雑な集計結果の正当性。
- 全ticketと結果の完全整合性。
- 厳密なサーバ時刻ベースの締切。

これらはSparkではHost信頼で運用し、必要になったらBlaze + Cloud Functionsへ移す。

## テスト戦略

前回の不具合は、mock/local寄りのテストでは見逃された。理由は、実RTDB SDKのtransactionローカルキャッシュ、画面別購読、role切替、Rulesの組み合わせを再現していなかったため。

今後は以下を必須にする。

### Unit tests

- scoring
- phase transition table
- config normalization
- archive payload schema
- RTDB node serializer/deserializer

Unit testではroot room互換だけでなく、小ノード入力からViewModelを作るテストを書く。

### Rules emulator tests

Firebase Emulator SuiteでRulesを検証する。

必須ケース:

- Playerは自分のticketだけ書ける。
- Playerは他人ticket、phase、resultsを書けない。
- Host allowlist uidだけがphaseを書ける。
- 非Hostはphaseを書けない。
- `lobby -> stage_intro -> voting -> countdown -> moving -> reveal -> ranking -> next` の順だけ通る。
- `stage_intro` のDBに対し、Hostの `open-voting` が成功する。
- `lobby` のDBに対し、Hostの `open-voting` が拒否される。
- `results/{stageId}` 二重作成が拒否される。

### RTDB integration tests

Emulatorまたはstaging RTDBに実Firebase SDKで接続し、Host/Player/Screen相当の複数クライアントを動かす。

必須ケース:

- Hostが `start-stage` 後、別ClientのHostが `open-voting` できる。
- Host画面をreloadしても `public.phase` が戻らない。
- Playerタブへ切り替えてからHostへ戻っても、Host購読がHost用に張り直される。
- Player ranking holdがHost/ScreenのViewModelへ混入しない。
- root購読なし、root transactionなしで全フェーズを完走する。
- 初回アクセス順が Player -> Screen -> Host でも、Host認証までroomが作成されない。
- DB削除直後、Host認証で初期roomが作成される。

### Browser E2E

Playwrightで3つの独立Browser Contextを使う。

- Host context
- Player A/B context
- Screen context

同一ブラウザタブ切替だけでは不十分。role切替のテストは別途行うが、本番相当のE2Eは独立contextで行う。

検証観点:

- Hostの `internal-status` と画面表示が一致する。
- Host操作後、Player/Screenのphaseが購読で変わる。
- Host操作エラー時、`lastCommand`, `lastApi`, `lastRulesError` が表示される。
- `backend=gas` や `backend=local` を付けてもFirebaseとして動き、GAS/localへ落ちない。

### Load tests

50 Player bot + Host + Screenを使って、以下を測る。

- 同時接続数
- ticket submit時間
- Host phase transition時間
- Screen反映遅延
- Player反映遅延
- RTDB downloaded bytes
- rejected write件数

Spark運用では、同時接続80を超える想定になった時点でBlaze移行を再検討する。

## リファクタリング順序

1. 現行コードからGAS/local進行分岐を削除する。
2. Firebase adapterをGAS互換APIではなく、RTDB node別command/query APIへ作り直す。
3. root room materializationをUI境界から消し、ViewModelを画面別購読から生成する。
4. Host phase commandを `public` transactionへ移す。
5. Player ticket commandを本人ノードwriteへ移す。
6. Result commitを小ノード出力へ分割する。
7. Host role allowlistを導入する。
8. GAS archive APIを進行中APIから分離する。
9. Rules emulator testsとRTDB integration testsをCI相当にする。
10. 50人相当の負荷試験を実施する。

## 移行時の互換方針

既存DBデータは、必要なら一度だけ読み取って新スキーマへ変換する。変換後は旧root room形式を通常実行で読まない。

既存Spreadsheetはアーカイブ先として残す。進行中roomの復元元にはしない。

既存UIの「Host単一次へ」方針は維持してよい。ただし、そのボタンは現在のViewModelではなく、必ずRTDB `public` の最新値に対するcommandとして実行する。

## 完了条件

- Host/Player/Screen/Historyの通常操作がFirebase RTDBだけで動く。
- GASを停止しても進行中ゲームが完走する。
- localStorageのroomデータを削除しても進行に影響しない。
- Hostの `internal-status` だけで、フェーズ不一致の原因を調査できる。
- Emulator testsでRulesの許可/拒否が検証されている。
- Browser E2Eで3端末相当の20ステージ短縮シナリオが通る。
- 50人相当の負荷試験で、反映遅延とRTDBダウンロード量が許容範囲に収まる。
