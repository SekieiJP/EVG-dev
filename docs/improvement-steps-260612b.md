# 復旧手順 260612b: 「同じJSONで再開始」「Import」の PERMISSION_DENIED

作成日: 2026-06-12 19時台 / 対象障害: [errorlog06121904.txt](errorlog06121904.txt)
方針: **最小修正での迅速復旧**（根本解決は別途）。コード変更なし・Rules 追記 1 箇所のみ・所要約 5 分。

---

## 1. 原因（確定）

- コミット `46d2e9a` 同梱の BGM/SE 分離機能が、RTDB の `roomSettings` ノードに `bgmVolume` / `seVolume` / `bgmMuted` / `seMuted` を書くようになった（[firebase-adapter.js:713-720](../game/assets/js/firebase-adapter.js)）。
- しかし Rules の `roomSettings` は `volume` / `muted` しか許可せず、`"$other": { ".validate": false }` が新フィールドを拒否する（[database.rules.json:137-143](../firebase/database.rules.json)）。本日デプロイ済みの本番 Rules も同内容。
- `roomSettings` を書き込むホスト操作は **Import / 同じJSONで再開始（`/api/host/import-config` → `writeRestRoomChildren()`）だけ**。multi-location update は原子なので、`roomSettings` の validate 違反 1 つで**更新全体が PERMISSION_DENIED** になる。退室（`writeHostSideEffects()`）は `roomSettings` を書かないため成功する — 症状と完全に一致。
- 通信ログで新 gameId（…-1dlu, lobby, v0）が一瞬適用されて旧 gameId（final, v37）へ戻るのは、SDK の楽観ローカル適用→サーバ拒否ロールバック。DB は壊れていない（部分書き込みなし）。
- 同じ理由で、**新規 room 初期化（Host 認証時の `claimHost()`）も現在失敗する**状態（同じ `writeRestRoomChildren` を使うため）。

## 2. 復旧手順（Rules 追記 → deploy のみ）

### Step 1. 現本番 Rules のバックアップ（T7 チェックリスト準拠）

Firebase Console → Realtime Database → ルール をコピーし、`docs/rtdb-rules-backup-20260612-2.json` として保存。

### Step 2. `firebase/database.rules.json` の `roomSettings` に 4 フィールドの validate を追記

```json
"roomSettings": {
  ".read": "auth != null",
  ".write": "auth != null && root.child('rooms').child($roomId).child('roles').child('hosts').child(auth.uid).val() === true",
  "volume": { ".validate": "newData.isNumber() && newData.val() >= 0 && newData.val() <= 1" },
  "bgmVolume": { ".validate": "newData.isNumber() && newData.val() >= 0 && newData.val() <= 1" },
  "seVolume": { ".validate": "newData.isNumber() && newData.val() >= 0 && newData.val() <= 1" },
  "muted": { ".validate": "newData.isBoolean()" },
  "bgmMuted": { ".validate": "newData.isBoolean()" },
  "seMuted": { ".validate": "newData.isBoolean()" },
  "$other": { ".validate": false }
}
```

変更は追加 4 行のみ（`bgmVolume` / `seVolume` / `bgmMuted` / `seMuted`）。`$other: false` は維持する。

### Step 3. デプロイ

```sh
firebase deploy --only database --project elevator-game-live
```

Rules はサーバ側のみの変更のため、**GitHub Pages の反映待ちやクライアントのリロードは不要**。Host 画面は開いたままでよい。

### Step 4. 動作確認（同一セッションで可）

1. Host 画面で「同じJSONで再開始」を実行 →「次ゲームを開始しました」トーストが出ること。
2. internal-status: `gameId` が新しい値、`phase` が `lobby`、`roomVersion` が 0 になり、その後**巻き戻らない**こと。
3. `lastApi` が `POST /api/host/import-config ok:true` であること。

### Step 5. 記録とコミット

- `docs/implementation-notes.html` に Rules 変更・デプロイ日時を追記（T7 チェックリスト）。
- `database.rules.json` の変更・バックアップ・本手順書をコミットして push。

## 3. うまくいかない場合のフォールバック

- Step 4 で別の PERMISSION_DENIED が出る場合: T5 によりエラーメッセージへ拒否パスが含まれる（ただし `update()` 一括拒否のため出ない場合は、Console の Rules プレイグラウンドで `rooms/elevator-game-live/roomSettings` への host uid 書き込みを検証）。
- Rules を即時に直せない事情がある場合の代替最小コード修正（非推奨・参考）: `roomToFirebaseNodes()` の `roomSettings` から追加 4 フィールドを外せば旧スキーマに戻る（Screen 音量は localStorage 優先のため機能影響は軽微）。ただし JS 配信は Pages 反映 + `?v=` 更新が必要で Rules 修正より遅い。

## 4. 根本対応への申し送り（今回はやらない）

- 機能追加で RTDB へ**新フィールドを書く場合は Rules の validate 追記とセット**にする検査観点を、T7 チェックリストへ追加する（「`roomToFirebaseNodes()` の出力スキーマを変えたら Rules を見る」）。
- `$other: false` を使うノードのスキーマ一覧をテストで照合する（`tests/firebase-adapter.test.js` に「emit するキーが Rules の許可キー集合に含まれる」静的チェックを足すと再発を CI で止められる）。
- 障害対応コミットへの機能同梱を避ける（improvement-report-260612 §7 実施状況の補足を参照）。
