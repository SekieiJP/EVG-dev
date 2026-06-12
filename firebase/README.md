# Firebase migration scaffold

このディレクトリはFirebase Spark移行用の初期設計と設定雛形を置く場所です。

Firebaseプロジェクト `elevator-game-live` の初期セットアップはFirebase CLIで実行済みです。再現手順は `docs/firebase-setup-guide.md` に記録しています。

## 初期方針

- Hostingは必須ではない。GitHub Pages配信を継続し、Realtime DatabaseだけFirebaseへ切り替えられる構成にする。
- Firebase Authは匿名ログインを使う。RTDB書き込み権限の主体は `auth.uid` とし、既存UUIDの復旧は将来の復旧コード設計へ分離する。
- Realtime Databaseは `rooms/{roomId}` と `players/{uid}` に分割し、画面ごとに必要なノードだけを購読する。
- Host権限は `rooms/{roomId}/roles/hosts/{uid}: true` のallowlistで付与する。クライアント内パスワードはサーバ権限として扱わない。
- SparkではCloud Functionsを前提にしない。Host操作と集計は初期版ではクライアント + Rules + `public` ノードtransactionで扱う。

## ファイル

- `database.rules.json`: Sparkで動かすためのRealtime Database Rules。`elevator-game-live-default-rtdb` へdeploy済み。

## デプロイ運用チェックリスト

- `database.rules.json` を変更したら、現在の本番RTDB Rulesをバックアップしてから `firebase deploy --only database` を実行する。
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
