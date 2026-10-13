# dsh-local-orchestrator

ローカルモデルで手元の作業を進め、必要な処理をAPIモデルへ委任するための、自分用のDSHプリセット
参考にする場合はforkし、MCPやプラグイン構成を自分の環境に合わせて変更する
汎用のMCP選択UIやモデルルーターは提供しない

## 組み込みPTCとの差

DSH 0.2.0-rc.2 の組み込みPTCをコピーし、IDA限定のMCP制御を追加している
自動追従する継承ではなく独立した構成として管理する

- プリセットID: `local-orchestrator`
- 表示名: `Local Orchestrator (PTC Base)`
- このプリセットのMCPは `idalib` のみ
- 組み込みPTCとHost全体のMCP設定は上書きしない
- MCP以外のPTCプラグイン構成は維持している
- 役割別の委任、ローカルモデル固定、API費用上限は未実装

## IDA限定の仕組み

Hostで設定済みのIDAエントリー `include:mcp-idalib` の実行時設定をメモリ内で読み、各Agentに専用のMCPクライアントを作る
接続先、ヘッダー、環境変数、認証情報をRepoへ書き出さない
Hostの接続自体を共有する方式ではないため、Agentや子Agentの数だけ接続が増える
stdio接続の場合はプロセスも増える

各Agentで、継承したMCPツールをすべて除外してから専用IDAツールを登録する
リソース操作もサーバー名を厳密に確認し、IDA以外のMCP指示文とサーバー一覧を非公開にする
ツールや指示文が後から追加されても、次のモデルステップ前に制限を更新する
子Agentにも同じ処理を個別に適用する

HostのIDAエントリーが無効、未設定、別サーバー、またはAgent専用クライアントが利用不能の場合は、モデルステップを開始しない
サーバー接続の障害は既存MCPクライアントの再接続とエラー処理に従う
この制御はモデルのMCP公開範囲を絞るものであり、シェルや任意コードのネットワークアクセスを遮断するsandboxではない

## 開発と検証

実装、スクリプト、テストはTypeScriptで記述する
テストはNodeの型除去で直接実行し、Host用のJavaScriptはTypeScriptから生成する
生成した `dist/` はGitで管理せず、導入前にローカルでビルドする
品質チェックにはBunが必要

```powershell
npm ci
npm run check
npm run check:upstream -- "<DSHのインストール先>/node_modules/@deepseek-ai/dsh-web-app/presets/ptc.patch.yml"
```

`npm run check` は最初にHostコードをビルドし、品質チェックと17件のテストを実行する
上流比較ではIDA制御プラグインだけを除外し、残りのPTC構成が一致するかを検証する
プラグイン削減を始めた後は、その変更も比較方針へ反映する

- `@yuu1111/quality-check`: Biome、型検査、Knip、コード、コメント、文書、TSDocの7系統を実行
- `@yuu1111/biome-config`: Biomeの共通設定とcoreルール
- `@yuu1111/tsconfig`: strictな型検査とHostビルドの共通設定
- `@yuu1111/knip-config`: 未使用ファイル、依存、exportの検査設定

## DSHへの導入と動作確認

clone後に `npm ci` と `npm run check` を実行して生成物を用意する
その後、DSHのプラグイン管理で、このRepoの絶対パスをローカルbundleとしてインストールする
管理ツールの場合は `plugin_manager` に `action: install_bundle` とRepoの絶対パスを指定する
プリセット登録の成功を確認し、新規セッションで表示名を選択する
既存セッションは開始時のプリセットrevisionを保持するため、更新の確認には新規セッションを使う

既に同じローカルパスがリンクされている場合、再インストールは `ambiguous-install` になることがある
その場合は、現在の登録状態を確認してからプラグイン管理でこのbundleだけを無効化・再有効化し、登録結果を確認する
JavaScriptの更新がHMRで反映されない場合はDSHを再起動する

このプリセットでは、モデルへ送信しない診断コマンドを使える

```text
/orchestrator-check
/orchestrator-check child
```

通常の診断は実際のPTC宣言、MCP指示文、サーバー一覧、Cloudflareリソース3操作の拒否を確認する
`child` はモデルを起動しない一時的な子Agentと比較用PTC Agentも作り、検証後に両方をdisposeする
委任先モデルの応答を試すコマンドではない
診断結果はコマンドログに残るが、接続設定や認証情報は表示しない

ローカル実機では、親と子のIDAツール74個、他MCPツール・指示文0、リソース3操作の拒否を確認済み
比較用PTCはCloudflareツール4個とIDAツール74個を維持した
ツール数は接続先のバージョンによって変わる

## これからの調整

機能と担当プラグインを会話でレビューし、合意したものだけ削減・調整する
Goal、Plan、Skill、委任、Webなどの採否はまだ決めていない
別モデルへの委任にはHost側のSubagentモデル選択と許可モデルの設定が必要で、このbundleは既定モデルや認証情報を変更しない

## 出典

初期プリセットは [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) の `@deepseek-ai/dsh-web-app` 0.2.0-rc.2 を基にしている
コピーした構成はMITライセンスで、著作権表示をLICENSEに保持している
