# Firebase migration scaffold

このディレクトリはFirebase Spark移行用の初期設計と設定雛形を置く場所です。

Firebaseプロジェクト `elevator-game-live` の初期セットアップはFirebase CLIで実行済みです。再現手順は `docs/firebase-setup-guide.md` に記録しています。

## 初期方針

- Hostingは必須ではない。GitHub Pages配信を継続し、Realtime DatabaseだけFirebaseへ切り替えられる構成にする。
- Firebase Authは匿名ログインを使う。RTDB書き込み権限の主体は `auth.uid` とし、既存UUIDの復旧は将来の復旧コード設計へ分離する。
- Realtime Databaseは `rooms/{roomId}` と `players/{uid}` に分割し、画面ごとに必要なノードだけを購読する。
- Host権限は `rooms/{roomId}/roles/hosts/{uid}: true` のallowlistで付与する。クライアント内パスワードはサーバ権限として扱わない。
- SparkではCloud Functionsを前提にしない。Host操作と集計はクライアントで決定的に計算し、DBルートに対する1回のmulti-location `update()`とRulesのphase/`roomVersion` CASで確定する。
- 完了履歴5系統（`completedGameSummaries`、`completedGamePublicDetails`、`completedGameDetails`、`completedGamePlayerDetails`、`historyPlayers`）は親ノードを書き換えない。HostはgameId/profileId子を非null値で作成・修復できるだけとし、子の削除・親単位の縮小・ID不一致はRulesで拒否する。

## ファイル

- `database.rules.json`: Sparkで動かすためのRealtime Database Rules。`elevator-game-live-default-rtdb` へdeploy済み。

## デプロイ運用チェックリスト

- `database.rules.json` を変更したら、現在の本番RTDBデータとRulesをバックアップする。履歴復旧を伴う場合は、RTDBだけでなくSpreadsheet/GAS側のオーナーバックアップも先に確保する。
- `npm run test:unit`を実行する。Java Runtimeが使える環境では`npm run test:rules-emulator`も実行し、起動不能なら成功扱いにせず制約を記録する。
- クライアントとRulesの互換性が変わる場合は、互換クライアントを先に公開して公開アセットの内容を確認し、その後 `firebase deploy --only database` を実行する。
- 本番deployでは対象を明示し、`firebase deploy --only database --project elevator-game-live`を使う。
- deploy後は本番Rulesを再取得してローカル版との一致を確認し、履歴5系統の件数と内容hashがdeploy前後で変わっていないことをread-onlyで確認する。
- Rules切替後は、開いたままのHostタブをすべて強制再読み込みする。旧クライアントの親単位履歴書込みは新Rulesで拒否される。
- Rulesをdeployした日時は `docs/implementation-notes.html` に記録する。
- リリース時は、`game/index.html` のCSS/JS参照に付けているアセットquery versionを更新し、旧CSS/JSキャッシュ混在を避ける。

## ローカル作業メモ

Firebase CLIを使う場合は、プロジェクト作成後に以下のような設定を追加する想定です。

```json
{
  "database": {
    "rules": "firebase/database.rules.json"
  }
}
```

Firebase Web API keyはブラウザ公開前提の識別子であり、秘密情報ではありません。秘密情報やサービスアカウントキーはこのリポジトリに置かない。
