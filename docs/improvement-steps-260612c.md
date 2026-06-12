# 復旧手順 260612c: Import 再失敗（PERMISSION_DENIED）の追加修正

作成日: 2026-06-12 19時台 / 対象障害: [errorlog06121919.txt](errorlog06121919.txt)
前提: [improvement-steps-260612b.md](improvement-steps-260612b.md) の roomSettings 修正は**実施済みかつ正しい**（ロールバック不要）。それでも Import が失敗するのは、**同一の原子 update 内に Rules 違反が 2 つあり、1 つしか修正されていなかった**ため。
方針: 前回同様 **Rules 追記 1 箇所のみ・コード変更なし・所要約 5 分**。

---

## 1. 原因（確定）

- Import/再開始（`writeRestRoomChildren()`）は `completedGamePlayerDetails` ノードを**丸ごと 1 キー**として multi-location update に含める（[firebase-adapter.js:540-543](../game/assets/js/firebase-adapter.js) 付近、`roomToFirebaseNodes()` の出力キー）。
- Rules の `completedGamePlayerDetails` は **`$uid` 配下にしか `.write` が無く、ノード自身に `.write` が無い**（[database.rules.json:124-129](../firebase/database.rules.json)）。
- RTDB の書き込み許可は「**書き込み位置またはその祖先**の `.write` が true」の場合のみ付与され、**子の `.write` は親への一括書き込みを許可しない**。よって `completedGamePlayerDetails` への親レベル set は常に拒否され、原子 update 全体が PERMISSION_DENIED になる。
- 検証済み: `writeRestRoomChildren` が書く全 12 ノードを Rules と照合した結果、ノードレベル `.write` を欠くのは `completedGamePlayerDetails` **ただ 1 つ**（他は meta/config/players/playerStats/scores/completedGameSummaries/completedGameDetails/operations/roomSettings/archive/public すべて YES）。
- 退室が成功するのは、退室（`writeHostSideEffects()`）がこのノードを書かないため。19:04 の障害時は roomSettings と本ノードの**2 つ**が違反しており、260612b で前者だけ解消された。
- 同根の副作用: 完全新規 room の初期化（Host 認証時 `claimHost()` → `writeRestRoomChildren`）も同じ理由で失敗する状態。本修正で同時に直る。

## 2. 復旧手順（Rules 追記 → deploy のみ）

### Step 1. 現本番 Rules のバックアップ

Console からコピーし `docs/rtdb-rules-backup-20260612-3.json` として保存。

### Step 2. `firebase/database.rules.json` の `completedGamePlayerDetails` にノードレベル `.write` を 1 行追加

```json
"completedGamePlayerDetails": {
  ".write": "auth != null && root.child('rooms').child($roomId).child('roles').child('hosts').child(auth.uid).val() === true",
  "$uid": {
    ".read": "auth != null && (auth.uid === $uid || root.child('rooms').child($roomId).child('roles').child('hosts').child(auth.uid).val() === true)",
    ".write": "auth != null && root.child('rooms').child($roomId).child('roles').child('hosts').child(auth.uid).val() === true"
  }
}
```

追加は先頭の `.write` 1 行のみ。`$uid` 配下は現状維持（Player 本人読み取りの権限モデルは変わらない。ノードレベルの `.read` は**追加しない**＝他人の詳細を一括読みはできないまま）。

### Step 3. デプロイと記録

```sh
firebase deploy --only database --project elevator-game-live
```

デプロイ後 Rules を `docs/rtdb-rules-after-deploy-20260612-3.json` に取得し repo と一致確認。クライアントのリロード不要。

### Step 4. 動作確認

1. （任意・先行確認）Console の Rules プレイグラウンド: 認証 uid = Host uid、書き込み先 `/rooms/elevator-game-live/completedGamePlayerDetails`、任意のオブジェクト → **許可**になること（修正前は拒否）。
2. Host 画面で「同じJSONで再開始」または Import を実行 →「次ゲームを開始しました」トースト。
3. internal-status: 新 `gameId` / `phase: lobby` / `roomVersion: 0` になり、**ロールバックで旧 gameId(final/v37) に戻らない**こと。
4. `lastApi` が `POST /api/host/import-config ok:true` であること。

### Step 5. 記録とコミット

implementation-notes へデプロイ記録を追記し、Rules・バックアップ・本手順書をコミット/push。

## 3. うまくいかない場合

- 同じエラーが続く場合は、プレイグラウンドで `writeRestRoomChildren` が書く各ノード（meta / config / players / playerStats / scores / completedGameSummaries / completedGameDetails / completedGamePlayerDetails / operations / roomSettings / archive / public、および `tickets/{stageId}` / `ticketPresence/{stageId}` / `results/{stageId}` の null 書き込み）を Host uid で 1 つずつ検証し、拒否されるノードを特定する（update は原子のため 1 つの違反で全体が落ちる）。

## 4. 根本対応への申し送り（今回はやらない）

- `tests/firebase-rules-static.test.js` に「`writeRestRoomChildren` が丸ごと書く全ノードは、Rules 上ノード自身（または祖先）に `.write` を持つ」静的チェックを追加する。§1 の照合をテスト化すれば、今回の 2 件（roomSettings の `$other` 違反・本件の親 `.write` 欠落）はどちらも CI で検出できた。
- 中期的には improvement-report-260612 §7 T9（public 含む原子 update への統一）と T12（mutation 時の読み書きノード削減）で、書き込みノード集合自体を縮小する。
