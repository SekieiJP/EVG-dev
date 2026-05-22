# Elevator Game Webアプリ 開発計画

## 前提
- 参照指定された要件ファイル `elevator-game-requirements.md` は現時点の実行環境から参照できなかったため、初期計画として汎用的なエレベーターゲーム開発計画を作成する。
- 要件ファイルの内容が取得でき次第、本計画は差分更新する。

## ディレクトリ構成
```text
.
├─ game/                 # Webサーバーに静的公開する配布物
│  ├─ index.html
│  ├─ assets/
│  │  ├─ css/
│  │  ├─ js/
│  │  ├─ img/
│  │  └─ audio/
│  └─ data/
├─ docs/                 # 開発ドキュメント
│  ├─ development-plan.md
│  ├─ requirements.md
│  ├─ architecture.md
│  ├─ screen-spec.md
│  └─ test-plan.md
└─ gas/                  # Google Apps Script関連
   ├─ README.md
   ├─ src/
   └─ clasp.json
```

## 開発フェーズ

### 1. 要件整理（Day 1-2）
- 要件ファイル内容を `docs/requirements.md` に構造化（機能要件/非機能要件/制約）。
- ゲームルールを定義（勝敗条件、スコア、時間制限、イベント仕様）。
- サーバー連携要件（必要ならGAS）を定義。

成果物:
- `docs/requirements.md`
- 受け入れ条件一覧

### 2. 設計（Day 2-4）
- 画面遷移、UIレイアウト、コンポーネント分割を設計。
- 状態管理を設計（ゲーム状態、エレベーター状態、乗客キューなど）。
- データ保存方式を設計（localStorage/GAS API）。

成果物:
- `docs/architecture.md`
- `docs/screen-spec.md`

### 3. 実装（Day 4-10）
- `game/index.html` の初期画面実装。
- `game/assets/js` にゲームループと入力処理を実装。
- `game/assets/css` にレイアウト・アニメーション実装。
- 必要に応じて `gas/src` にスコア保存API（doGet/doPost）実装。

成果物:
- 初期プレイ可能版（MVP）

### 4. テスト（Day 8-11）
- 手動テスト観点作成（ゲーム進行、境界値、レスポンシブ）。
- 主要ロジックはユニットテスト化（可能な範囲）。
- GAS連携の異常系確認。

成果物:
- `docs/test-plan.md`
- バグリスト

### 5. リリース準備（Day 11-12）
- 静的ホスティング配置手順を整備。
- バージョニングと更新履歴を整備。
- デプロイチェックリスト運用。

成果物:
- リリース候補版
- 配布手順書

## 初期タスク（今回の着手範囲）
1. プロジェクトのフォルダ分割（`game` / `docs` / `gas`）。
2. 開発計画の作成（本ドキュメント）。
3. `game` と `gas` の最小READMEを追加して目的を明文化。

## リスクと対応
- 要件ファイル未取得リスク: 要件原文を入手後、計画を48時間以内に改訂。
- 仕様肥大化リスク: MVPスコープを先に固定。
- GAS連携遅延リスク: オフライン保存（localStorage）を先行実装し、後段でAPI接続。

## 次アクション
- 要件ファイルをリポジトリに取り込み、`docs/requirements.md` を確定する。
- MVPの画面モック（タイトル/ゲーム/結果）を `game/index.html` に作成する。
