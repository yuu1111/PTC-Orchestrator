# dsh-local-orchestrator

ローカルモデルで手元の作業を進め、必要な処理をAPIモデルへ委任するためのDSH拡張Repo

## 現在の状態

DSH 0.2.0-rc.2 の `@deepseek-ai/dsh-web-app/presets/ptc.patch.yml` をコピーした初期ベース
プリセットID、表示名、説明、表示順だけを変更し、子プラグインの構成は維持している
DSHの宣言には継承フィールドがないため、自動追従する継承ではなく独立したコピーとして管理する

- プリセットID: `local-orchestrator`
- 表示名: `Local Orchestrator (PTC Base)`
- 組み込みの `ptc` は上書きしない
- 機能削減、役割別の委任、モデル指定は未実装
- Host側の基盤は既存DSHを利用する
- 配下のプリセットが同じでも、Host側の追加ツールやMCPまで固定するものではない

## 検証

```powershell
npm ci
npm run check
npm run check:upstream -- "<DSHのインストール先>/node_modules/@deepseek-ai/dsh-web-app/presets/ptc.patch.yml"
```

構造テストはプリセットの独立性、PTC設定、行ID、実行式の保持を検証する
上流比較は子プラグイン構成が指定した組み込みPTCと一致するかを検証する
意図的に構成を絞った後は、上流比較で差分が検出される
これらの検証だけではHostでのマウントやモデルの実行を確認できない

## TypeScriptと品質チェック

検証スクリプトとテストはTypeScriptで記述し、Nodeの型除去で直接実行する
品質チェックにはBunが必要

- `@yuu1111/quality-check`: Biome、型検査、Knip、コード、コメント、文書、TSDocのチェックをまとめて実行
- `@yuu1111/biome-config`: Biomeの共通設定とcoreルール
- `@yuu1111/tsconfig`: strictな型検査の共通設定
- `@yuu1111/knip-config`: 未使用ファイル、依存、exportの検査設定

`npm run check` で品質チェックとテストを実行する

## DSHへの導入

DSHのプラグイン管理で、このRepoの絶対パスをローカルbundleとしてインストールする
管理ツールが利用できる場合は `plugin_manager` に `action: install_bundle` と `target: <このRepoの絶対パス>` を指定する
インストール後、プリセット登録の成功を確認し、新規セッションで表示名を選択する
既存セッションには反映されない
このRepoを作成するだけではDSHにインストールされない

## レビューと実装の順序

1. 機能と担当プラグインをこの会話で一覧にしてレビューする
2. ローカル側、API側の子、共通基盤、不要または保留に分類する
3. 合意した変更だけをベースへ反映する
4. ローカル完結、API委任、失敗時の復帰、結果検証を実タスクで評価する

別モデルへの委任にはHost側のSubagentモデル選択と許可モデルの設定が必要
このbundleはその設定、認証情報、既定モデルを変更しない
API利用の費用上限や外部送信の範囲も、採否レビュー後に別途設計する

## 出典

初期プリセットの出典は [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) の `@deepseek-ai/dsh-web-app` 0.2.0-rc.2
コピーした構成はMITライセンスで、著作権表示をLICENSEに保持している
