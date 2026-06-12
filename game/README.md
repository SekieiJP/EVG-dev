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

ホストパスワードの既定値は `host` です。

## 実装状況

- バックエンドはFirebase RTDBに固定しています。`backend=gas` と `backend=local` は使用しません。
- `?backend=firebase-mock` は自動テスト・ローカル検証用のFirebase adapter mockです。
- ゲームロジックは `assets/js/engine.js` に集約しています。
- Firebase接続情報は `assets/js/config.js` のビルド時定数で管理します。

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
| フェーズ遷移 | `se_phase_transition.mp3` |
| エレベーター乗車成功 | `se_board.mp3` |
| エレベーター上昇（乗車中） | `se_ride_occupied.mp3` |
| エレベーター上昇（空） | `se_ride_empty.mp3` |
| エレベーター下車成功 | `se_exit.mp3` |
| エレベーター強制下車 | `se_forced_off.mp3` |
| 結果発表完了 | `se_reveal_complete.mp3` |

## 同梱ライブラリ

- `assets/vendor/qrcode-generator/qrcode.js`
  - Screenの参加URL QRコード生成に使用します。
  - 詳細は `assets/vendor/qrcode-generator/README.md` を参照してください。
