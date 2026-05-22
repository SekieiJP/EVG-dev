# game

静的Webサーバーへ配置する公開用ファイルです。

## 起動

```sh
python3 -m http.server 8000 -d game
```

ブラウザで以下を開きます。

- プレイヤー: `http://localhost:8000/?view=player`
- ホスト: `http://localhost:8000/?view=host`
- スクリーン: `http://localhost:8000/?view=screen`
- 戦歴: `http://localhost:8000/?view=history`
- 設定: `http://localhost:8000/?view=settings`

ホストパスワードのローカル既定値は `host` です。

## 実装状況

- 現在はローカルストレージを使う単一ブラウザ検証モードです。
- ゲームロジックは `assets/js/engine.js` に集約しています。
- GAS APIの実装は `../gas/src/Code.gs` にありますが、この画面からのfetch接続は次段階です。
