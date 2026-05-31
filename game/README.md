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

- 既定ではローカルストレージを使う単一ブラウザ検証モードです。
- ゲームロジックは `assets/js/engine.js` に集約しています。
- GAS APIの実装は `../gas/src/Code.gs` にあります。
- GAS通信前に必要な接続情報は `assets/js/config.js` のビルド時定数で管理します。`USE_GAS_API` を `true` にし、`GAS_API_BASE_URL` にGAS Web App URLを設定すると、参加・投票・ホスト進行・状態ポーリングをGASへ送信します。

## 音声ファイル

Screen端末のみ、`assets/audio/` に配置されたmp3を再生します。未配置のファイルは無視され、通信ログに一度だけ記録されます。

| 場面 | ファイル名 |
| --- | --- |
| 参加者受付中BGM | `bgm_lobby.mp3` |
| ステージ説明BGM | `bgm_stage_intro.mp3` |
| 投票受付中BGM | `bgm_voting.mp3` |
| カウントダウンBGM | `bgm_countdown.mp3` |
| 移動中BGM | `bgm_tallying.mp3` |
| 結果発表BGM | `bgm_reveal.mp3` |
| ランキングBGM | `bgm_ranking.mp3` |
| 最終結果BGM | `bgm_final.mp3` |
| 購入締切カウントダウン開始 | `se_countdown_start.mp3` |
| 購入締切 | `se_countdown_end.mp3` |
| エレベーター乗車成功 | `se_board.mp3` |
| エレベーター上昇成功 | `se_ride.mp3` |
| エレベーター下車成功 | `se_exit.mp3` |
| エレベーター強制下車 | `se_forced_off.mp3` |

## 同梱ライブラリ

- `assets/vendor/qrcode-generator/qrcode.js`
  - Screenの参加URL QRコード生成に使用します。
  - 詳細は `assets/vendor/qrcode-generator/README.md` を参照してください。
