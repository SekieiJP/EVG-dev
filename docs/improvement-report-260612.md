# 改善レポート v2: 通信不具合（退室失敗）の根本原因、潜在リスク、アニメーション品質

更新日: 2026-06-12（v2） / 対象: `game/assets/js/{app.js,engine.js,firebase-adapter.js}`, `game/assets/css/styles.css`, `firebase/database.rules.json`
位置づけ: 調査・実施計画レポート（コード編集は未実施）。v1 で「別セッションで修正済み」とした退室時 Permission denied は**未解決**であることが errorlog06121740 で確認されたため、本 v2 で根本原因を特定し、実施可能なタスクに落とし込んだ。

参照証拠:
- `docs/errorlog06121731.txt`（修正前クライアント）/ `docs/errorlog06121740.txt`（修正後クライアント、現行 HEAD 相当）
- `docs/elevator-game-live-default-rtdb-export-06121740.json`（17:40 時点の本番 RTDB 全量エクスポート）
- git 履歴（Rules deploy 記録 a4e460d と、その後の Rules 変更 f8db28a / 7779c70）

---

## 1. エグゼクティブサマリ

- **F0（確定・最重要）: 「退室で通信に失敗」の根本原因は、6/6 の Firebase Rules 変更が本番 RTDB に未デプロイであること。** 6/6 のコード変更で Host の状態読み取りに `completedGameSummaries` / `completedGameDetails` が加わったが、本番 Rules（6/2 デプロイ版）にはこれらのノード定義が無く、RTDB の既定で読み取り拒否される。Host の全 POST 操作と `/api/status` GET は処理冒頭の `readRoom()` でこの拒否に当たって throw するため、**退室に限らず 6/6 以降すべての Host 操作が本番で失敗している**。復旧は `firebase deploy --only database` の再デプロイ。
- **F1（高・未修正のまま退室を再試行すると実害）: `withApiMeta()` が payload の `uuid` を Host 自身の playerUuid で上書きする。** Rules を直しても、退室リクエストは「選択した相手」ではなく **Host 自身のプレイヤーレコードを削除**してしまう。Rules 再デプロイ後の本番検証前に必ず修正すること。
- **F3（高・診断性）: `onValue` 購読にエラーコールバックが無く、拒否された購読がサイレントに失敗する。** 今回 `completedGame*` の購読が 6 日間失敗し続けていたのに誰も気づけなかった直接の理由。
- 状態遷移系の構造リスク（R1: public と本体データの非原子書き込み、R3: Host 端末依存の自動集計、R2: クロックスキュー未補正）と、アニメーション品質の根本原因（A1: 毎秒の全 innerHTML 再生成で CSS transition が死んでいる）は v1 から維持。R1 の Rules に関する記述は誤りがあったため訂正（§4）。

---

## 2. F0: 退室失敗の根本原因（確定）

### 2.1 証拠チェーン

1. **エラーの形**: [errorlog06121740.txt](docs/errorlog06121740.txt) で `POST /api/host/remove-player` が `ok:false, code:""(空), error:"Permission denied"`、所要 ~110ms で 2 回失敗（17:38:11 / 17:38:58、間にページリロード）。`code` が空 = adapter が返す構造化エラー（`code:"rules"/"auth"/"version_conflict"` 等）ではなく、**例外 throw 経路**（[app.js:2084](game/assets/js/app.js:2084) → [app.js:1723-1726](game/assets/js/app.js:1723)）。
2. **トランザクション未到達**: RTDB エクスポートの `public.roomVersion` は 2 回の失敗後も **32 のまま**。internal-status の `lastTransactionPublic` / `lastRulesError` も空。`commitPublicTransition()`（[firebase-adapter.js:597](game/assets/js/firebase-adapter.js:597)）はコールバックすら実行されていない。つまり失敗はその手前、`postRestHost()` 冒頭の **`readRoom()`**（[firebase-adapter.js:257](game/assets/js/firebase-adapter.js:257)）で起きている。
3. **読み取りで拒否されている**: [errorlog06121731.txt](docs/errorlog06121731.txt) では純読み取りの `GET /api/status` も同じ `Permission denied`（Host 起動 5 秒後）。書き込み権限の問題ではない。
4. **Host の認証・書き込み自体は機能している**: エクスポートの `meta.updatedAt = 2026-06-12T07:55:45.339Z` は同日の Host 認証時の `claimHost()` による書き込み（[firebase-adapter.js:353](game/assets/js/firebase-adapter.js:353)）が**成功**した痕跡。`roles/hosts` に Host uid (8pxm2…) も登録済み。allowlist・auth は正常。
5. **Rules のデプロイ記録と変更履歴の食い違い**: Rules デプロイの記録は 6/2（コミット a4e460d、implementation-notes にも 6/2 デプロイ追記のみ）。その後 6/6 の f8db28a / 7779c70 が `firebase/database.rules.json` に以下を**追加**したが、デプロイ記録が無い:
   - `completedGameSummaries`（[database.rules.json:116](firebase/database.rules.json:116)）
   - `completedGameDetails`（[database.rules.json:120](firebase/database.rules.json:120)）
   - `completedGamePlayerDetails`（[database.rules.json:124](firebase/database.rules.json:124)）
   - root `players/$uid` の Host 読み書き許可と validate 拡張（[database.rules.json:154](firebase/database.rules.json:154)）
   - `playerStats/$uid` の本人書き込み許可（[database.rules.json:59](firebase/database.rules.json:59)）
6. **コードは 6/6 以降このパスを読む**: Host の `readRoom()` は `firebaseBaseSubscriptionPaths()`（[firebase-adapter.js:787](game/assets/js/firebase-adapter.js:787)）の `completedGameSummaries` / `completedGameDetails` を `Promise.all` の `get()` で読む（[firebase-adapter.js:508-516](game/assets/js/firebase-adapter.js:508)）。6/2 版 Rules にこれらの定義は無く、RTDB は未定義パスを既定拒否 → **1 つでも拒否されると `Promise.all` 全体が "Permission denied" で reject** → `post()`/`get()` が throw。
7. **購読が動いて見えるのは反証にならない**: `listenRest()` の `onValue` はエラーコールバック未指定（[firebase-adapter.js:117](game/assets/js/firebase-adapter.js:117)）。拒否された 2 パスの購読はサイレントに死に、残り 10 パスで `room.apply` が流れ続けるため、画面上は正常に見える。

### 2.2 結論

**6/6 の Rules 変更が本番未デプロイであることが、全証拠と整合する唯一の説明。** これにより 6/6 以降、本番では (a) Host の全 POST 操作（退室・進行・集計・JSON Import）、(b) `/api/status` 取得、(c) Player 復帰（root `players/{uid}` 書き込み・`playerStats` 本人書き込みも 6/2 版 Rules では拒否）が壊れている。

### 2.3 復旧手順（T1〜T3、§7 参照）

1. Firebase Console → Realtime Database → ルール タブで、現行ルールに `completedGameSummaries` が**含まれていない**ことを確認（= 仮説の最終確定。含まれていた場合は §2.1 の手順で再調査）。
2. 現行ルールをバックアップ（コピー保存）後、リポジトリから `firebase deploy --only database` を実行。
3. デプロイ後の疎通確認: Host 画面の internal-status で `lastApi` の `/api/status` が `ok:true` になること。
4. **退室の本番検証は F1 修正後に行うこと**（未修正だと Host 自身が退室される。§3.1）。
5. implementation-notes へ「Rules 変更とデプロイ日時」を追記し、以後 Rules 変更時の必須手順とする（T7）。

---

## 3. 退室フローで発見した追加バグ（Rules 修正後に顕在化するもの）

### F1.（高）`withApiMeta()` が退室対象 uuid を Host 自身の uuid で上書きする

- 該当: [app.js:2093-2100](game/assets/js/app.js:2093)。`meta.uuid = state.playerUuid || payload.uuid` を `Object.assign({}, payload, meta)` で**後勝ち**マージするため、Host 端末に playerUuid が保存されていると（今回の端末は Host 自身が「ボット君」として参加済みで該当）、`/api/host/remove-player` の `payload.uuid`（退室対象）が **Host 自身の uuid に差し替わる**。
- 実害: adapter 側 `applyMutation()`（[firebase-adapter.js:228](game/assets/js/firebase-adapter.js:228)）は差し替え後の uuid で `removePlayerFromRoom` を実行するため、**選択した相手ではなく Host 自身のプレイヤーレコード・スコア・チケットが削除される**。ログ上は `recordApiDebug` がマージ前 payload を記録するため（`payloadUuid` に対象 uuid が出る）、発見が極めて困難。
- 修正方針: 明示指定を優先する。`uuid: payload.uuid || state.playerUuid || ""` へ順序変更（または `requesterUuid` を別キーに分離）。Player 系 path は `payload.uuid === state.playerUuid` なので挙動不変。影響があるのは remove-player のみ。

### F2.（中）`keyOperations()` の id 衝突で新しい操作ログが消える

- 該当: [firebase-adapter.js:1163-1173](game/assets/js/firebase-adapter.js:1163)。新規操作（id 無し・配列先頭に unshift）には配列 index から `op-0000` 形式の id を振るが、DB 既存の操作が既に `op-0000` を持つため、reduce で**後から処理される既存 op が新規 op を上書き**し、退室などの新規操作ログが RTDB 上から消える。
- 修正方針: 新規 op の id を `op-{ISO時刻}-{乱数4桁}` 等の衝突しない形式にする、または既存 id 集合を避けた連番にする。

### F3.（高・診断性）`onValue` 購読のサイレント失敗

- 該当: `listenRest()` の `attach`/`attachStage`（[firebase-adapter.js:116-132](game/assets/js/firebase-adapter.js:116)）。エラーコールバック未指定のため、Rules 拒否された購読が無音で死ぬ。今回の障害が 6 日間気づかれなかった直接原因。
- 修正方針: `onValue(ref, cb, (error) => {...})` の第 3 引数で `logClient("firebase.subscribe.error", {path, message})` を記録し、`debug.subscriptionErrors` に蓄積して internal-status に表示する。

### F4.（中）`readRoom()` が Host の全 mutation で `completedGameDetails` を読む

- 該当: [firebase-adapter.js:491-506](game/assets/js/firebase-adapter.js:491) + [firebase-adapter.js:787](game/assets/js/firebase-adapter.js:787)。完了ゲーム全詳細（タイムライン含む・肥大化する）を退室や進行のたびに全読みしており、Spark の 10GB/月 DL 枠を浪費し、今回のように**障害の表面積も広げる**。
- 修正方針: mutation 用の読み取りパス集合から `completedGameDetails`（必要なら `completedGameSummaries` も）を外し、履歴系 API（`historyGames` 等）だけが読むよう分離する。

### F5.（中・運用）Rules/コードのデプロイ工程が分離していて漂流する + JS キャッシュ混在リスク

- Rules はリポジトリ編集と `firebase deploy` が手動分離しており、今回のように**コードだけが先に本番へ出る**。また [index.html:18-22](game/index.html:18) の script タグにキャッシュバスティングが無く、GitHub Pages CDN でファイル別に新旧 JS が混在し得る。
- 修正方針: (a) Rules 変更を含むコミットの PR チェックリスト化（「deploy 済みか」を implementation-notes に記録）、(b) `index.html` の script/css 参照に `?v=<コミット短縮ハッシュ>` を付与（手動更新で可。ビルドが無いため）。

---

## 4. 状態遷移・通信の潜在不具合（構造リスク）

### R1.（高）`public` 遷移と本体データ書き込みの非原子性 — 部分コミットによる取り残し

- 該当: `postRestHost()`（[firebase-adapter.js:274-279](game/assets/js/firebase-adapter.js:274)）が `commitPublicTransition()`（public の `runTransaction`）の**後**に `writeHostSideEffects()` → `writeRestChildUpdates()`（`Promise.all` の独立 `set`、[firebase-adapter.js:558-562](game/assets/js/firebase-adapter.js:558)）を実行。トランザクション境界が別で原子性が無い。
- 影響: commit-result で `public` だけ `reveal` に進み `results/{stageId}` 書き込みが失敗すると、Screen は結果の無い reveal に取り残される。さらに `Engine.advancePhase("tally")` は `phase === COUNTDOWN/TALLYING` と「結果未存在」を要求する（[engine.js:357-378](game/assets/js/engine.js:357)）ため、reveal に進んだ後は**エンジン側ガードで再集計不能**になる。
- **v1 からの訂正**: v1 では「Rules の `results/$stageId` no-overwrite 制約で再集計不能」と書いたが誤り。親 `results` の `.write`（Host 許可、[database.rules.json:102](firebase/database.rules.json:102)）が下位に**カスケード許可**されるため、`$stageId` の `.write` 制約（[database.rules.json:105](firebase/database.rules.json:105)）は Host に対して実質デッドコード。デッドロックの原因はエンジン側ガードのみ。この `$stageId` ルールは「意図が効いていない Rules」として整理対象。
- 修正方針（推奨）: `runTransaction` をやめ、**`public` を含む multi-location `update()` 1 回**に本体データ（`results`/`scores`/`playerStats`/`meta`/`operations`）をまとめる。RTDB の multi-location update は原子であり、楽観ロックは Rules の `roomVersion === data.roomVersion + 1` 検証（[database.rules.json:35](firebase/database.rules.json:35)）が CAS として機能する（version がずれていれば**全体が** reject）。失敗時は再読込→リトライ。`lastTransactionPublic` デバッグは update 失敗時に `public` を `get` して記録する形へ置換。

### R2.（中）`serverTimeOffsetMs` が常に 0 — 端末間クロックスキュー未補正

- 該当: [app.js:2120-2129](game/assets/js/app.js:2120)。adapter は `serverTime: nowIso()`（自端末時刻）を返すだけで補正値は常に約 0。購読経路は `updateServerTime` を通らない。internal-status でも常に 0 を確認。
- 影響: `countdownEndsAt`/`revealEndsAt` 等は Host 端末の絶対時刻で、Player/Screen は自端末時計で評価。数秒のズレでカウントダウン表示の食い違い、reveal 演出の早送り/頭出し失敗、結果の早期開示が起きる。
- 修正方針: RTDB の `.info/serverTimeOffset` を adapter init 時に `onValue` 購読し、`state.serverTimeOffsetMs` へ反映（コールバックを config 経由で app.js に渡す）。

### R3.（高・運用）自動集計が Host 端末の常時オープンに依存 — 進行の単一障害点

- 該当: `maybeAutoCommitHostTally()`（[app.js:1841-1869](game/assets/js/app.js:1841)、毎秒 tick）。
- 影響: 移動完了時刻に Host がリロード/スリープ/トークン失効していると誰も集計せず、Screen/Player は「移動中…」のまま停止。
- 修正方針（Spark 前提の緩和）: (a)「`canTally()` 真かつ結果未生成」が一定秒続いたら Host 画面に停滞警告と手動再 commit 導線、(b) `hostToken` の期限監視と失効前の再認証誘導（現在 6h、[firebase-adapter.js:336](game/assets/js/firebase-adapter.js:336)）。恒久対策は Blaze + Cloud Functions。

### R4.（中）部分コミット後にリトライ機構が回復不能

- 該当: `hostAutoTallyKey`/`hostAutoTallyRetryAt`（[app.js:1848-1863](game/assets/js/app.js:1848)）。
- 影響: R1 の部分コミット（public=reveal、results 欠落）が起きると `canTally()` が false になり自動リトライが永久に走らない。
- 修正方針: R1 とセットで。「`phase === reveal` かつ現ステージ `results` 欠落」を検知したら復旧 commit を許す（エンジンの `tallyCurrentStage` ガードに「結果未存在なら reveal でも可」の復旧分岐を追加するか、専用の復旧 API 経路を設ける）。

### R5.（低〜中）失敗後の強制リフレッシュが Host ロール限定

- 該当: [app.js:1721-1726](game/assets/js/app.js:1721)。Player/Screen は mutation 失敗後にローカル version が古いまま残り得る。購読が主経路のため実害は限定的だが、Player の投票失敗→再描画されないケースを確認しておく。

---

## 5. アニメーションの改善（カクつき・チープさ）

### A1.（根本原因）reveal 中の「毎秒・全 innerHTML 再生成」で CSS トランジションが死んでいる

- 該当: `tick()`（[app.js:149-174](game/assets/js/app.js:149)）が毎秒 `render()` → `renderScreenReveal()`（[app.js:975-1004](game/assets/js/app.js:975)）が shaft 全体の DOM を再生成。`--reveal-shift` は階単位の整数刻み（[app.js:985](game/assets/js/app.js:985)）。
- CSS 側 `.shaft-track { transform: translateY(var(--reveal-shift)); transition: transform 0.24s linear; }`（[styles.css:880-888](game/assets/css/styles.css:880)）はトランジション前提だが、**要素ごと作り直されるため一度も発火せず**、エレベーターは 1.6 秒ごとに 1 階ぶん瞬間移動する。
- `--travel-duration` / `--reveal-delay`（[app.js:988](game/assets/js/app.js:988)）は過去の連続アニメ方式の名残で、現在の CSS から参照されない死蔵変数。
- 副作用: 毎秒の全置換によるレイアウトスラッシング、ちらつき、SE タイミングのブレ。

### A2. 改善方針（滑らかさ）

1. **（推奨）reveal 中はフルレンダーをやめ DOM を保持し、`requestAnimationFrame` で連続値更新する。** reveal 突入時に一度だけ shaft を構築し、以後 rAF ループで経過時間→実数 px を補間して `shaft.style.setProperty('--reveal-shift', px)`。階内は等速、階境界で ease のイージング関数を挟む。スコアボード・チップ類は「現在階が変わった時だけ」差分更新。
2. 代替: 元の「連続 CSS keyframe + 負の `animation-delay`」方式へ回帰（再描画耐性あり。実装メモ 2026-05-24 の方式）。圧縮階（30F 以上の空階短縮）があるため keyframe を `getRevealSchedule()` の `durations` から動的生成する必要がある点に注意。
3. アニメ対象は `transform`/`opacity` に限定し `.shaft-track { will-change: transform; }`。レイアウト誘発プロパティ禁止。
4. 端末間で滑らかさを揃えるには R2（serverTimeOffset）が前提。

### A3. リッチ化

- 各階到達の減速→停止→加速イージング（現状 `linear`）。
- 現在階のグロー/枠ハイライト、強制下車階到達時のシェイク/フラッシュ。
- 乗降チップの `opacity`+`translateY` スタッガード fade-in。
- スコアの rAF カウントアップと gain/loss パルス。
- かごの質感向上（グラデ・内側シャドウ・移動中の微バウンス）。
- `prefers-reduced-motion` で即時表示へフォールバック（演出強化と同時に必須）。
- 「移動中…」バー（[styles.css:843-850](game/assets/css/styles.css:843)）は `background-position` アニメをやめ `transform` ベースへ。

---

## 6. 優先度まとめ

| ID | 区分 | 重大度 | 影響 | 対応 |
|----|------|--------|------|------|
| F0 | 通信(確定原因) | 最高 | 全 Host 操作・status 取得・Player 復帰が本番で失敗 | Rules 再デプロイ + 検証（T1-T3） |
| F1 | ロジック | 高 | 退室が常に Host 自身を対象化（Rules 修正後に顕在化） | withApiMeta の uuid 優先順位修正（T2） |
| F3 | 診断性 | 高 | 購読失敗が不可視（今回 6 日間未検知） | onValue エラーコールバック + internal-status 表示（T4） |
| R1 | 状態遷移 | 高 | reveal で結果欠落→再集計不能 | public 含む multi-location update へ原子化（T9） |
| R3 | 進行/運用 | 高 | Host 離脱で進行停止 | 停滞警告 + 再 commit 導線（T10） |
| A1 | 演出 | 高(体感) | エレベーターが瞬間移動 | DOM 保持 + rAF 連続更新（T13） |
| R4 | 状態遷移 | 中 | 部分コミット後に自動回復不能 | 復旧 commit 経路（T10） |
| R2 | 通信/時刻 | 中 | 端末間 countdown/reveal ズレ | `.info/serverTimeOffset` 補正（T11） |
| F2 | データ | 中 | 新規操作ログが RTDB から消える | op id 採番修正（T6） |
| F4 | 帯域/堅牢性 | 中 | mutation ごとに完了ゲーム全詳細を読む | 読み取りパス分離（T12） |
| F5 | 運用 | 中 | Rules/JS の新旧混在 | デプロイチェックリスト + cache busting（T7-T8） |
| A3 | 演出 | 中 | リッチさ不足 | イージング・登場演出ほか（T14） |
| R5 | 通信 | 低〜中 | 非 Host の失敗後に旧 version 残存 | リフレッシュ全ロール化検討（T15） |

---

## 7. 実施計画（フェーズ別タスク）

### Phase 0 — 本番復旧（即日・コード変更は F1 のみ）

- **T1. Rules ドリフトの最終確定**: Firebase Console の ルール タブで本番ルールに `completedGameSummaries` が無いことを確認し、現行ルールをコピー保存（バックアップ）。
  - 確認: 含まれていなければ F0 確定。含まれていた場合は §2.1 の手順 5-7 を再調査（このタスクで止める）。
- **T2. F1 修正**: [app.js:2093-2100](game/assets/js/app.js:2093) を `uuid: payload.uuid || state.playerUuid || ""` に変更。
  - 確認: `?backend=firebase-mock` で (a) Player join/submit が従来通り動く、(b) Host remove-player で**選択した対象**が消える。
- **T3. Rules 再デプロイ + 本番疎通**: `firebase deploy --only database` → Host 画面 internal-status の `lastApi` で `/api/status` が `ok:true`、その後**不要な参加者 1 名**で退室を実行し、`players/{uid}`・`playerStats/{uid}`・`scores/{uid}`・現ステージ `tickets`/`ticketPresence`/`results` 子パスから対象だけが消え、`roomVersion` が +1 されることをエクスポートまたは Console で確認。
  - 注意: T2 デプロイ前に本番で退室を試さない（Host 自身が消える）。

### Phase 1 — 再発防止・診断性（今週中目安）

- **T4. 購読エラーの可視化（F3）**: `listenRest()` の `attach`/`attachStage`（[firebase-adapter.js:116-132](game/assets/js/firebase-adapter.js:116)）に `onValue` エラーコールバックを追加し、`debug.subscriptionErrors[path] = message` を蓄積、`getDebugInfo()`（[firebase-adapter.js:157](game/assets/js/firebase-adapter.js:157)）と internal-status 表示に追加。
  - 確認: mock で Rules 拒否相当を再現しにくいため、存在しない roomId への購読や Rules を一時的に絞った dev 環境で `firebase.subscribe.error` ログが出ること。
- **T5. get 失敗のパス特定**: `readRestNodes()`（[firebase-adapter.js:508-516](game/assets/js/firebase-adapter.js:508)）で各 `get` を catch し、`error.message` に `path` を付与して rethrow（例: `Permission denied at completedGameDetails`）。`recordApiDebug` の error にそのまま乗る。
  - 確認: 今回と同種の障害が起きた際、lastApi だけで拒否ノードが特定できる。
- **T6. 操作ログ id 衝突（F2）**: `operationNode()`（[firebase-adapter.js:1163](game/assets/js/firebase-adapter.js:1163)）の採番を `op-{Date.now()}-{乱数}` 形式へ（既存 id は維持）。
  - 確認: mock で連続操作後、`operations` ノードに全操作が残る。
- **T7. Rules 運用チェックリスト（F5）**: `firebase/README.md` に「`database.rules.json` を変更したら同一 PR 内で deploy 実施と implementation-notes への日時記録を必須とする」手順を明文化。
- **T8. キャッシュバスティング（F5）**: [index.html:18-22](game/index.html:18) の script/css に `?v=<短縮ハッシュ>` を付与し、リリース時に更新する運用をチェックリストへ追加。

### Phase 2 — 状態遷移の堅牢化

- **T9. Host 書き込みの原子化（R1）**: `postRestHost()` の `commitPublicTransition` + `writeHostSideEffects` を、**`public` を含む 1 回の multi-location `update()`** に統合（ref は `rooms/{roomId}`、keys: `public`, `meta`, `operations`, 操作別の `results/...`/`scores`/`playerStats`/`players/...`）。楽観ロックは Rules の `roomVersion + 1` / フェーズ遷移検証に委ねる。拒否時は `code:"rules_or_conflict"` を返し、再読込→1 回だけ自動リトライ。`writeRootPlayersFromRoom` は update 後に従来通り。
  - 確認: mock + 実 DB で、(a) 通常進行全フェーズ、(b) 2 つの Host タブから同時に「次へ」を押して片方だけ成功すること、(c) version 不一致時に全ノードが変化しないこと。
- **T10. 集計の復旧経路（R3/R4）**: `tallyCurrentStage()`（[engine.js:357](game/assets/js/engine.js:357)）に「`phase === REVEAL` かつ当該ステージ結果未存在なら再集計可」の復旧分岐を追加し、`maybeAutoCommitHostTally()` の `canTally()` ガードにも同条件を追加。あわせて「結果未生成のまま N 秒経過」で Host 画面に警告バナー + 手動再実行ボタン。
  - 確認: results 書き込みを意図的に失敗させた部分コミット状態から、自動/手動で回復できること。
- **T11. サーバ時刻補正（R2）**: adapter init で `.info/serverTimeOffset` を購読し、config コールバック経由で `state.serverTimeOffsetMs` を更新。internal-status の値が非ゼロになることを確認。
  - 確認: 端末時計を ±10 秒ずらした 2 端末で、カウントダウン残り秒と reveal 到達階が一致すること。
- **T12. mutation 時の読み取り削減（F4）**: `restBaseReadPaths()` を「mutation 用（completedGame* 除外）」と「フル（履歴 API 用）」に分離。
  - 確認: 退室・進行・集計が `completedGameDetails` 非読込で成立し、History 画面は従来通り表示されること。
- **T13. 失敗後リフレッシュの整理（R5）**: `shouldRefreshAfterMutationFailure` の対象ロール/パスを見直し、Player 投票失敗時の再同期を確認。

### Phase 3 — 演出（A 系）

- **T14. reveal の連続アニメ化（A1/A2 案 1）**: reveal 突入時に shaft DOM を一度だけ構築 → rAF ループで `--reveal-shift` を実数 px 更新（`getRevealSchedule().durations` から経過時間→px の区分線形補間関数を作る）。`tick()` からの reveal 中フルレンダーを停止し、「現在階が変わった時だけ」チップ/スコア/SE を差分更新。`will-change: transform` 付与。`prefers-reduced-motion` 時は従来の即時表示。
  - 確認: DevTools Performance で reveal 中の Layout/Recalc スパイクが毎秒出ないこと、60fps 近辺で滑らかに移動すること、リロード/Host 進行時に位置が正しく頭出しされること（R2 完了後は別端末とも一致）。
- **T15. リッチ化（A3）**: 階到達イージング、現在階ハイライト、チップ stagger fade-in、スコアカウントアップ、かご質感、移動中バーの transform 化。スクリーン実投影（横長 TV）で視認性を確認。

### 依存関係

- T2 → T3（F1 修正前に本番退室検証をしない）
- T9 → T10（復旧経路は原子化後の形に合わせる）
- T11 → T14 の端末間同期検証
- T4/T5 は他より先に入れるほど以後の調査が楽になる

---

## 8. 検証時の着眼点（共通）

- 本番検証はゲーム終了状態（phase=final）の現ルームで行い、必ず事前に RTDB エクスポートを取得してから操作する。
- F0 関連の回帰確認: Host 認証 → `/api/status` → 退室 → 進行（restart-current-config で新ゲーム開始）→ Player join/restore まで一連を通す。6/2 版 Rules では Player 復帰（root `players` への Host 書き込み・`playerStats` 本人書き込み）も拒否されていたため、**復帰機能の本番確認も Rules 再デプロイ後に必須**。
- R1/T9 の競合確認: 2 タブ Host で同時操作し、負けた側に version 競合エラーが出て状態が壊れないこと。
- A1/T14: `.shaft-track` の DOM ノードが reveal 中に入れ替わらないこと（Elements パネルでノード参照を保持して確認）。
