# Firebaseセットアップ手順

更新日: 2026-06-01

## 現在のセットアップ結果

Firebase CLIで以下を確認・実行済み。

- CLI: `firebase-tools 15.19.0`
- Project ID: `elevator-game-live`
- Project Display Name: `Elevator-Game-Live`
- Project Number: `672500393326`
- Realtime Database instance: `elevator-game-live-default-rtdb`
- Realtime Database location: `asia-southeast1`
- Web App display name: `Elevator Game Live`
- Web App ID: `1:672500393326:web:babf3d5e5ec49a8f0e8d7f`
- Database URL: `https://elevator-game-live-default-rtdb.asia-southeast1.firebasedatabase.app`
- Security Rules: `firebase/database.rules.json` をdeploy済み
- Authentication: Anonymous providerを有効化済み

このリポジトリには以下のFirebase設定を追加済み。

- `.firebaserc`
- `firebase.json`
- `firebase/database.rules.json`
- `game/assets/js/config.js` のFirebase Web設定

## 実行済みコマンド

```sh
firebase projects:list
firebase init database --project elevator-game-live
firebase apps:create web "Elevator Game Live" --project elevator-game-live
firebase apps:sdkconfig WEB 1:672500393326:web:babf3d5e5ec49a8f0e8d7f --project elevator-game-live
firebase init auth --project elevator-game-live
firebase deploy --only auth --project elevator-game-live
firebase deploy --only database --project elevator-game-live
```

`firebase init database` では以下を選択した。

- Rules file: `firebase/database.rules.json`
- Realtime Database setup: Yes
- Location: `asia-southeast1`
- 既存 `firebase/database.rules.json` は上書きしない
- Firebase Agent Skills: No

`firebase init auth` では以下を選択した。

- Provider: `Anonymous`
- Firebase Agent Skills: No

## 新規環境での手順

1. GoogleアカウントでFirebase Consoleにログインする。
2. Firebase CLIをインストールする。

```sh
npm install -g firebase-tools
firebase login
```

3. プロジェクトを作る。すでに作成済みならこの手順は不要。

```sh
firebase projects:create elevator-game-live --display-name "Elevator-Game-Live"
```

4. リポジトリのFirebase設定を初期化する。

```sh
firebase use elevator-game-live
firebase init database --project elevator-game-live
```

選択:

- Rules file: `firebase/database.rules.json`
- Location: `asia-southeast1`
- 既存rulesファイルがある場合は上書きしない

5. Webアプリを登録し、SDK設定を取得する。

```sh
firebase apps:create web "Elevator Game Live" --project elevator-game-live
firebase apps:list --project elevator-game-live
firebase apps:sdkconfig WEB <app-id> --project elevator-game-live
```

6. 取得したSDK設定を `game/assets/js/config.js` に反映する。

```js
FIREBASE_PROJECT_ID: "elevator-game-live",
FIREBASE_API_KEY: "...",
FIREBASE_AUTH_DOMAIN: "elevator-game-live.firebaseapp.com",
FIREBASE_DATABASE_URL: "https://...firebasedatabase.app",
FIREBASE_ROOM_ID: "elevator-game-live",
```

7. Rulesをdeployする。

```sh
firebase deploy --only database --project elevator-game-live
```

8. Anonymous Authを有効化する。

```sh
firebase init auth --project elevator-game-live
firebase deploy --only auth --project elevator-game-live
```

選択:

- Provider: `Anonymous`
- ほかのProviderは必要になるまで有効化しない

## ローカル確認

Firebase実プロジェクトへ接続せず、ローカルmockで確認する場合:

```text
http://localhost:8000/?view=host&backend=firebase-mock
http://localhost:8000/?view=player&backend=firebase-mock&testSlot=a
http://localhost:8000/?view=screen&backend=firebase-mock
```

Firebase実RTDBへ接続する場合:

```text
http://localhost:8000/?view=host&backend=firebase
http://localhost:8000/?view=player&backend=firebase&testSlot=a
http://localhost:8000/?view=screen&backend=firebase
```

## 注意点

- Firebase Web API keyはブラウザ公開前提の識別子で、秘密情報ではない。ただしRealtime Database Rulesを必ずdeployし、匿名Auth必須にする。
- Sparkの同時接続上限は100。50人本番では複数タブ、見学端末、予備端末の運用ルールを決める。
- 初期Firebase版はSpark前提のためCloud Functionsを使わない。Hostブラウザ集計を信頼する設計が残る。
- 本番前に `backend=firebase` でHost/Player/Screenの複数端末確認と、50人相当の負荷試験を行う。
- `auth/configuration-not-found` が出る場合は、Anonymous providerが未deploy、またはFirebase Authenticationが未初期化。
