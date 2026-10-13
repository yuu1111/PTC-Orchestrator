# 作業規約

- ローカルの main で作業し、指示がない限りブランチやworktreeを作らない
- 日本語文書とコードコメントには句点を使わない
- コードはHow、テストはWhat、コミットログはWhyを記述する
- コメントはコードから分からないWhy notだけに限定する
- 組み込みPTCと既存のユーザー設定を変更しない
- プリセットの機能を削る前にユーザーと採否をレビューする
- モデル、認証情報、API費用、外部送信の許可を暗黙に設定しない
- コードとテストはTypeScriptで記述する
- 品質設定には @yuu1111 の quality-check、biome-config、tsconfig、knip-config を使う
- 検証は npm run check を使う
- 初期ベースの比較には npm run check:upstream -- <組み込みPTCの絶対パス> を使う
- bundleのインストールと新規セッションでの動作確認は別工程として扱う
