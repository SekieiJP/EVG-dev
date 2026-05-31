# Firebase migration scaffold

このディレクトリはFirebase Spark移行用の初期設計と設定雛形を置く場所です。

現時点では本番FirebaseプロジェクトIDやDatabase URLは未設定です。`firebase-spark-migration` ブランチで通信層を追加する際に、以下を段階的に埋めます。

## 初期方針

- Hostingは必須ではない。GitHub Pages配信を継続し、Realtime DatabaseだけFirebaseへ切り替えられる構成にする。
- Firebase Authは匿名ログインを使う。既存のゲームUUIDは、復旧用のプレイヤーIDとして維持する。
- Realtime Databaseは `rooms/{roomId}` と `players/{uid}` に分割し、画面ごとに必要なノードだけを購読する。
- SparkではCloud Functionsを前提にしない。Host操作と集計は初期版ではクライアント + Rules + transactionで扱う。

## ファイル

- `database.rules.json`: Sparkで動かすためのRealtime Database Rules初期案。実装開始時に、実際のデータ構造とクライアントSDK呼び出しに合わせて厳格化する。

## ローカル作業メモ

Firebase CLIを使う場合は、プロジェクト作成後に以下のような設定を追加する想定です。

```json
{
  "database": {
    "rules": "firebase/database.rules.json"
  }
}
```

このリポジトリにはまだFirebaseプロジェクトの実IDや秘密情報を置かない。
