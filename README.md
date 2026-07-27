# qa-standard — Web事業共通QA基盤

レンのWeb事業(メディアサイト・ポータル)全サイト共通の品質・セキュリティ検査基盤。
**リリースの大きさ・複雑さを自動判定し、必要なレベルのテストだけを自動実行する。**
記事追加のような軽微な更新は約1分で通過し、認証・決済・依存関係に触れるリリースは
フルセキュリティ検査+レンの手動承認を通る。

## 仕組みの全体像

```
push / PR
   │
   ▼
[classify] 変更ファイルと差分規模から QA レベルを自動判定
   │
   ├─ L0 コンテンツのみ(記事・データ・画像) → シークレットスキャンのみ(約1分)
   ├─ L1 軽微なコード変更(≤5ファイル/150行) → + lint / unit / build
   ├─ L2 標準リリース(レイアウト・大規模変更) → + E2Eスモーク / リンク切れ / Lighthouse
   └─ L3 セキュリティ敏感(認証・決済・DB・依存) → + SAST / 依存脆弱性 / 🙋レン承認
   │
   ▼
[qa-gate] 全ジョブ成功で通過 → [deploy] wrangler deploy → [post-deploy] 本番スモーク+ヘッダ検査
                                                              ├ 失敗時: 30秒間隔で最大3回リトライ
                                                              │  (エッジ伝播前の旧レスポンス誤検知を防止)
                                                              └ それでも失敗: Issue自動起票(ロールバック提案)
毎週月曜 09:00 JST
   └─ [security-weekly] 依存CVE / 本番ヘッダ / 全ページリンク切れ / (portalのみ)ZAP DAST → 問題あればIssue起票
```

判定を上書きしたいとき: コミットメッセージに `[qa:L0]`〜`[qa:L3]` を書くか、
Actions タブ → workflow_dispatch の `level_override`。

## リポジトリ構成

| パス | 役割 |
|---|---|
| `.github/workflows/qa.yml` | 本体: 判定→レベル別実行 (reusable) |
| `.github/workflows/post-deploy.yml` | デプロイ直後の本番検証 (reusable) |
| `.github/workflows/security-weekly.yml` | 週次セキュリティスキャン (reusable) |
| `scripts/classify-release.mjs` | QAレベル判定エンジン(依存ゼロ) |
| `scripts/check-headers.mjs` | セキュリティヘッダ検査(OWASP準拠)。`--retries` でリトライ可 |
| `scripts/smoke-check.mjs` | HTTP生存確認。`--retries` でリトライ可 |
| `scripts/e2e-smoke.spec.mjs` | 共通E2Eスモーク(サイト側テストコード不要) |
| `config/` | Playwright / Lighthouse / ポリシー例 |
| `templates/` | 各サイトに置く caller のコピー元 |
| `docs/qa-policy.md` | QA標準書(出典つき・なぜこの構成か) |

## 新しいサイトへの導入手順(ロビの作業、1サイト約5分)

1. `templates/caller-media-qa-deploy.yml`(ポータルは `caller-portal-qa-deploy.yml`)を
   サイトリポジトリの `.github/workflows/qa-deploy.yml` にコピー
2. `templates/caller-weekly.yml` を `.github/workflows/weekly.yml` にコピー
3. `<OWNER>` を Organization 名に、`<YOUR-DOMAIN>` を本番ドメインに置換
4. `smoke_paths` を主要ページ(トップ+テンプレート種別ごとに1ページ)に設定
5. 必要なら `qa-policy.json` をリポジトリ直下に置いて判定ルールを調整
   (無くても classify 内蔵デフォルトで動く。`config/qa-policy.example.json` 参照)

## 🙋 レンのタスク(人間にしかできない作業)

### 初回のみ(全体で15分)
- [ ] GitHub Organization を作成し、このディレクトリを `qa-standard` リポジトリとして push
- [ ] **qa-standard リポジトリの Settings → Actions → General → Access を
  「Accessible from repositories in the organization」に変更**
  (デフォルトは Not accessible。これを忘れると全サイトの QA が起動できない — GitHub 公式仕様)
- [ ] Organization 設定 → Code security → Dependabot alerts / security updates を全リポジトリで有効化(無料)
- [ ] GitHub と Cloudflare のアカウントで 2FA を有効化
  (個人情報保護法の技術的安全管理措置②「アクセス者の識別と認証」に対応)

### サイトごと(1サイト5分)
- [ ] リポジトリの Settings → Secrets and variables → Actions に登録:
  - `CLOUDFLARE_API_TOKEN`(Workers デプロイ権限つきトークン)
  - `CLOUDFLARE_ACCOUNT_ID`
- [ ] `templates/dependabot.yml` を `.github/dependabot.yml` としてコピー(ロビの導入作業に含めてOK)
- [ ] Settings → Environments → `qa-l3-approval` を作成し、
  **Required reviewers に自分を追加**(これが L3 の承認ゲートになる)
- [ ] Issues のラベル `qa-failure`(赤)と `security`(黄)を作成(Issue自動起票用)
- [ ] (PR運用を始める場合) ブランチ保護の required status check には **`qa-gate` だけ**を指定する。
  qa-gate は QA レベルに関係なく常に実行されるため「スキップされた check が Pending のまま
  PR をブロックする」という GitHub 公式ドキュメント記載の罠を回避できる

### 運用中(受動的でOK)
- [ ] L3 リリース時: GitHub から届く承認依頼メールの「Review deployments」→ Approve
  (内容に不安があればロビに「このL3リリースの変更内容を説明して」と聞く)
- [ ] 週次スキャンが起票した Issue の確認(対応はロビに依頼でOK)
- [ ] デプロイ後検証失敗の Issue が来たら最優先(本番が壊れている可能性)

## ローカルでの事前チェック(ロビ用)

```bash
# リリース前にQAレベルを予測
node scripts/classify-release.mjs --base origin/main --head HEAD --cwd /path/to/site

# 本番のヘッダ・生存確認
node scripts/check-headers.mjs --url https://example.com --profile static
node scripts/smoke-check.mjs --base https://example.com --paths "/,/about/"
```

どちらのスクリプトも `--retries N --retry-wait 秒` で「失敗時に待って再検査」ができる
(デフォルトはリトライなし)。デプロイ直後の Cloudflare Workers はエッジ伝播前の
旧レスポンスを返すことがあるため、post-deploy.yml は `--retries 3 --retry-wait 30` で
呼んでいる(成功時は即通過なので通常のデプロイ時間は延びない)。
ローカルからデプロイ直後に確認するときも同様に付けるとよい。
