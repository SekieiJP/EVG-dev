# Firebase RTDB 目標アーキテクチャ

更新日: 2026-07-31

## 目的

エレベーターゲームの本番進行中状態を Firebase Realtime Database に一本化し、Host、Player、Screen が同じフェーズと同じステージ状態を即時に参照できる構成へリファクタリングする。

この文書は、現行UIや `engine.js` の互換維持よりも望ましい目標構成を優先する。既存のGASモード、localStorage進行モード、root room transaction は廃止対象とする。GAS互換のcommand名を残すadapterも、実処理はFirebase小ノード読取りと単一multi-location updateへ限定する。今後の抜本的リファクタリングでは、この文書を現行実装より優先する設計基準として扱う。

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
    phase                  # lobby | stage_intro | voting | countdown | tallying | reveal | ranking | final
    roomVersion
    currentStageIndex
    currentStageId
    phaseStartedAt
    countdownEndsAt
    tallyingEndsAt
    animationStartedAt
    playerCount
    submittedCount
    abstainedCount
    resultCommittedAt

  config
    gameMeta
    settings
      hostUiMode
      movingSeconds
      revealSecondsPerFloor
    stages/{stageId}
      name
      params
      events

  roomSettings
    countdownSeconds       # 1〜60の整数。既定10。Host変更後は次ゲームにも引き継ぐ
    bgmVolume
    seVolume
    bgmMuted
    seMuted

  nextGameConfigs/{configId}
    status                 # ACTIVE | INACTIVE
    config                 # 次ゲーム用テンプレート。Spreadsheetは読取り元にしない
    updatedAt

  players/{uid}
    name
    connected
    joinedAt
    lastSeenAt
    pendingName

  playerStats/{uid}
    currentSkill
    stageSkillHistoryJson       # canonical JSON。Rulesで本人更新時の完全一致を検証
    appliedSkillStageIdsJson    # JSON.stringify([gameId, stageId])の配列。ゲームを跨ぐ二重追記/誤抑止を防ぐ
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
    status                 # none | queued | exported | failed
    archiveId
    gameId
    pendingGameIdsJson
    error

  completedGameSummaries/{gameId}
    gameId
    title
    finishedAt
    interrupted
    rankings               # profileId、表示名、得点、順位だけ

  completedGamePublicDetails/{gameId}
    gameId
    rankings               # profileId、表示名、得点、順位だけ
    stageResults            # ステージごとの公開rankings

  completedGameDetails/{gameId}
    gameId
    ...                     # Host allowlistだけが読む確定ゲーム全体

  completedGamePlayerDetails/{uid}/{gameId}
    gameId
    ...                     # 本人またはHostだけが読む個人内訳

  historyPlayers/{profileId}
    profileId
    name
    currentSkill
    updatedAt

players/{uid}
  name
  currentSkill
  stageSkillHistoryJson
  appliedSkillStageIdsJson
  joinedAt
  lastSeenAt
  updatedAt
  roomId

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

通常ゲーム中のUIからはRTDBの公開サマリ、本人詳細、Host詳細を読む。Spreadsheet由来の詳細を通常UIへ返すGAS read APIは持たない。Spreadsheetは監査・外部保存用のarchive destinationである。

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
- `nextGameConfigs`
- `players`、`playerStats`
- `results`
- `scores`
- `historyPlayers/{profileId}`
- `completedGameSummaries/{gameId}`、`completedGamePublicDetails/{gameId}`、`completedGameDetails/{gameId}`、`completedGamePlayerDetails/{uid}/{gameId}`
- `operations`
- `archive`

Host操作はroot room transactionではなく、対象ノード単位の疎なパスへ分解する。複数の枝を同時に確定する操作では、DBルートに対する1回のmulti-location `update()`を使い、Rulesで `public` の既存phase/versionをCAS条件として検証する。

完了履歴と公開Skill indexは親ノードを全置換しない。通常クライアントは上記gameId/profileId子パスへ非null値を作成または修復するだけとし、Rulesは5種類の履歴親への書込み、既存子の削除、path keyとpayload内IDの不一致を拒否する。

禁止:

- `rooms/{roomId}` 全体を単一オブジェクトとしてtransaction/update/setする。
- 完了履歴または `historyPlayers` の親をset/updateし、空オブジェクトをnullへ変換する。
- フェーズだけを先に確定し、結果・Skill・操作ログを別リクエストで後書きする。
- `roomFromFirebaseNodes(undefined)` から初期roomを作ってHost操作する。
- root transactionのローカルキャッシュを信頼してフェーズ判定する。

### Phase transition

フェーズ遷移は `public` を含む単一multi-location updateで行う。副作用のない操作でも同じCAS方式を用いる。

```text
update /
  rooms/{roomId}/public = nextPublic
  rooms/{roomId}/operations/{operationId} = operation

Rules validation
  require stored phase -> next phase is allowed
  require next roomVersion == stored roomVersion + 1
  require Host allowlist
```

同じgameId内では、Rulesが `data.child('phase')` と `newData.child('phase')` の組み合わせを検証し、不正な飛び越しと古いversionからの更新を拒否する。gameId変更は次ゲーム境界として遷移表の例外だが、`roomVersion + 1`は必須であり、通常クライアントは必ず`lobby`を作る。検証に失敗するとmulti-location update全体が反映されないため、操作ログだけが残ることもない。

### Result commit

結果発表開始時はHostブラウザがcommand送信前にpreviewを計算できるが、そのpreview resultは権威値として採用しない。adapterはcommand受信後にmutation用のprivate player/ticketをRTDBから再読込みし、補正済みサーバ時刻と決定的な集計関数でcanonical resultを再計算する。

同じcanonical resultからscore、StageSkill、現在Skill、公開投影、空階圧縮を含むreveal schedule、`animationStartedAt` / `revealEndsAt` を生成する。書き込みは、DBルートに対する**1回のmulti-location `update()`**で `public`、`results/{stageId}`、全 `scores/{uid}`、全 `playerStats/{uid}`、root `players/{uid}`、公開履歴のprofileId子、`operations` を同時に確定する。順次 `set()`、複数回の `update()`、phase先行確定、履歴親の全置換は使わない。これによりHost preview作成後かつ締切内に到着したticketを取りこぼさず、結果と演出終了時刻が異なるsnapshotに由来する状態も作らない。

このcommitでは、StageSkill履歴の追記と現在Skill（全履歴の上位5件、最高値を含む）の更新も同じpayloadに含める。二重集計を防ぐため、Rulesのphase/version CASと `results/{stageId}` の新規作成検証で、古いHost操作または既存結果への再commitをupdate全体として拒否する。Sparkでは信頼済みHostブラウザ内の再計算であり、Rulesが計算式そのものを独立検証するわけではない。Blaze移行時はCloud Functionsへ同じ再計算と検証を移せる。

StageSkillの適用済みキーはstageId単独ではなく `JSON.stringify([gameId, stageId])` とする。同じconfig/stageIdを別ゲームで再利用しても、新ゲームのSkillを誤って既適用扱いしない。旧plain stageId markerは由来ゲームを一意に証明できないため値を保持するが、新規判定には使わず、推測で特定ゲームへスコープしない。

既存データ移行ではroot `players/{uid}` の非空履歴をcanonicalとして保持する。root履歴が空の場合だけ、`results` 全件と `completedGameDetails` を読み、有限なStageSkill（0を含む）をゲーム単位ステージキーで重複排除して復元する。rootが空でもroom側に由来不明の非空履歴と旧plain markerがある場合、StageSkillの数値一致から由来を推測せず、監査エラーとして移行を中止する。復元は `public.roomVersion + 1` を含む単一multi-location updateで、root player、room `playerStats`、公開Skill index、完了履歴を同時に揃える。現ゲームと完了詳細で同じキー・同じuidのStageSkillが食い違う場合も移行を中止し、上書きしない。

Skill履歴と公開投影の初回移行成功時は `meta.schemaVersion` を `firebase-rtdb-v4-public-projection` へ更新する。旧schemaからの移行は、root/room Skill、公開投影、履歴修復、schema markerを同じmulti-location updateで確定する。updateが拒否された場合はschemaVersionも更新されないため、次回Host認証で安全に再試行できる。

schema v4以後の有効なHostセッション再開では、private `results` / `completedGameDetails` と現在の公開枝を読み、canonical公開投影との差分だけを冪等upsertする。公開枝が正常なら書込みは0件とし、欠損・不完全な場合も `meta`、`public`、roomVersion、root player、`playerStats`、`historyPlayers`、Skill履歴は変更しない。schema markerだけを完全性の根拠にして即returnしてはならない。

通常運用の購読は引き続き `results/{currentStageId}` に限定する。移行時だけはallowlist済みHostに `results` 親の一回読取りを許可し、Player/Screenが親を一括取得することはRulesで拒否する。rootに非空canonical履歴があるプレイヤーはroot profile自体を書き直さず、room `playerStats` と公開indexだけを同期する。

root `players/{uid}` が未作成の場合は既存 `data.roomId` をHost認可に利用できない。本番の通常room `elevator-game-live` に限り、対象uidが `rooms/elevator-game-live/players/{uid}` の現在参加者として存在し、かつ要求者が同roomのallowlist済みHostである場合だけ、欠損ノードの読取りを許可する。root作成は `newData.roomId` により同roomのHostを検証できるため、backfillの単一multi-location updateで行う。これは既存本番データを安全に移行するための限定境界であり、別roomへ展開する場合はroomごとのroot player所属indexまたはサーバ移行処理を設計してからRulesを拡張する。

### 時刻同期と締切

全クライアントは `/.info/serverTimeOffset` を購読し、`Date.now() + offset` を補正済みサーバ時刻として用いる。Hostはこの補正済み時刻から `countdownEndsAt`、`tallyingEndsAt`、`animationStartedAt`、`revealEndsAt` を確定して書き、Player/Screenも同じ補正方法で描画する。

Spark + Rulesだけでは、クライアントが書いた時刻とFirebaseサーバ時刻を完全に比較する締切検証はできない。したがってSparkは信頼済みHostが締切を確定する運用とし、厳密な受理時刻を要件化する場合はBlaze + Cloud Functionsへ移行する。

### 次ゲームと同日継続

次ゲーム候補の正系は `rooms/{roomId}/nextGameConfigs/{configId}` である。Hostが候補を開始する際、直前ゲームのうち**次ゲーム開始日（Asia/Tokyo）と同じ日**にチケット提出を完了したプレイヤーだけを引き継ぐ。引継ぎ対象にはuid、表示名、現在Skill、StageSkill履歴を残し、ゲーム内score、ticket、stage result、現在ステージ位置は初期化する。前日以前の参加者と完全棄権者は現在ゲームの参加者にコピーしない。

この判定はRTDBに保存したticket提出時刻および結果確定時刻をAsia/Tokyoへ変換して行う。Spreadsheetの `game_configs`、`current_game`、`players` は判定・開始の読取り元にしない。

既存roomはplayers/resultsが空でも次ゲーム生成として扱い、初期room生成は保存済みゲーム状態が全て未作成の場合だけに限る。次ゲームのmulti-location updateは旧gameId/profileId集合のsuperset検査を通し、新たに完了するgameIdと更新するprofileId子だけをupsertする。gameId変更時も `public.roomVersion = stored roomVersion + 1` を必須とし、画面が送るbaseVersion、同一タブの待機表示、Rules CASで二重開始を拒否する。

`public`だけ欠損して履歴・meta・config・結果等が残る場合は初期化せず `room_state_incomplete` で停止する。通常JSON Importは履歴Resetを兼ねず、完全Resetは通常クライアントとRulesから分離した管理用API・確認・権限を設計するまで提供しない。

### 公開履歴の境界

Player/Screenが読む公開履歴は `completedGameSummaries/{gameId}`、`completedGamePublicDetails/{gameId}`、`historyPlayers/{profileId}` のゲームサマリ、表示名、得点、順位、公開用現在Skillに限定する。ticket、予想回答、得点内訳、StageSkill履歴、uid/UUID、個人統計は公開ノードへ置かない。本人の詳細は `completedGamePlayerDetails/{uid}/{gameId}`、Hostの確定詳細は `completedGameDetails/{gameId}` に分け、Rulesでそれぞれ本人/Host allowlistだけに限定する。

History画面で現在room参加者と公開履歴を併合する場合、raw uidは同じ`publicProfileId(uid)`へ変換してから公開`profileId`と重複排除する。History役は他人の`playerStats`を購読しないため、room playerから合成されたSkill 0で`historyPlayers.currentSkill`を上書きしない。完了詳細の既存gameIdはUnicodeを保持し、Firebase keyで禁止される`.#$\/[]`だけを拒否して読取りパスに使う。

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

archive payloadの正本はRTDBの確定済み `results`、`scores`、プロフィール9指標、使用済みstage設定、game summaryから作る。Spreadsheetは `save_data`、`stage_results`、`stage_settings`、`game_history`、`archive_log` へ出力するだけで、RTDBへ戻すための復元元にはしない。

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

`queued`はGAS応答前のブラウザ終了等で残る可能性があるため、`failed`と同様に同一`archiveId`で明示再送できる。未完了jobがあるまま次ゲームへ進む場合はその状態を新roomへ持ち越し、後続ゲームのRTDB完了詳細は通常どおり確定する。後続gameIdは`pendingGameIdsJson`へ重複なく古い順で追加し、GAS自動送信だけを延期する。先行jobのretryが成功したら、完了詳細を読み直して後続キューを同じブラウザ処理内で古い順に送る。途中で失敗またはブラウザ終了した場合は、その時点のgameId/archiveIdを`failed`または`queued`として残し、未送信の残りキューも保持する。

GAS呼出し前後の`queued`、`failed`、`exported`、次gameへの切替は`archive` nodeのRTDB transactionで更新する。ゲーム完了のmulti-location updateが同時に後続gameIdを追加した場合、transactionを再試行して新しいキューを併合し、古いブラウザ状態による全体`set`で取りこぼさない。

final済み現ゲームの手動送信では、Hostが`results`全件を再読込し、部分的な`completedGameDetails`を検出した場合はsummary、公開詳細、Host詳細、本人詳細、`archive=queued`を`public.roomVersion + 1`と同じmulti-location updateで修復する。このRTDB確定後にだけGASへ送るため、送信途中で失敗して次ゲームへ移ってもfull payloadをretryできる。

各完了ゲームのHost詳細には参加者だけの`playerSnapshots`を保存する。現在SkillとStageSkill履歴を確定時点で固定し、後続キューを翌日以降にretryしても、別ゲームのroom参加者や最新プロフィールでarchiveの9指標を置き換えない。

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
- commit失敗後に再取得した実DBの `public`
- response error
- forced refresh後のphase/version/stageId

root playerの事前読取りエラーは、拒否された絶対パス `/players/{uid}` を `lastRulesError` と通信ログに残す。後続の原子的updateへ到達しなかった場合でも、internal-statusだけで停止箇所を判別できるようにする。

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
- `lobby -> stage_intro -> voting -> countdown/tallying -> reveal -> ranking -> stage_intro/final` の許可済み遷移だけを通す。
- `stage_intro` のDBに対し、Hostの `open-voting` が成功する。
- `lobby` のDBに対し、Hostの `open-voting` が拒否される。
- `results/{stageId}` 二重作成が拒否される。
- 通常roomの現参加者でroot playerが未作成でもallowlist済みHostは欠損を読め、部外者および同roomにいない欠損uidの読取りは拒否される。
- 欠損root playerの作成を含むSkill backfillのmulti-location updateが原子的に成功する。

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

ローカルmock E2Eでは、共有mock RTDBを使うため1つのBrowser Context内にHost、Player A/B、Screenの独立pageを作り、`testSlot`ごとに匿名認証IDを分離する。

- Host page
- Player A/B page
- Screen page

同一pageのrole切替だけでは不十分である。実Firebase Emulatorまたは本番前staging smokeでは、さらに独立Browser Contextまたは物理端末を使い、Firebase AuthセッションとRTDB購読も分離して確認する。

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
4. Host phase commandをRules CAS付きmulti-location updateへ移す。
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
- Browser E2EでHost、Player A/B、Screenの3端末相当が代表1ステージを完走し、結果/Skill表示とfinal自動追従が通る。
- 50人×20ステージ相当の負荷モデルで、書込み回数とpayloadサイズがSpark運用の想定範囲に収まる。実RTDBの反映遅延は本番前smokeで確認する。
