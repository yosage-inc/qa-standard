# qa-standard — Web事業共通QA基盤

レンのWeb事業(メディアサイト・ポータル)全サイト共通の品質・セキュリティ検査基盤。
**リリースの大きさ・複雑さを自動判定し、必要なレベルのテストだけを自動実行する。**
記事追加のような軽微な更新は約1分で通過し、認証・決済・依存関係に触れるリリースは
フルセキュリティ検査を通る(レンの手動承認ゲートは GitHub のプランの制約で今は使っていない。下の「Actions の分数」)。

## 仕組みの全体像

```
push / PR
   │
   ▼
[classify] シークレットスキャン(全レベル)+ 変更ファイルと差分規模から QA レベルを自動判定
   │
   ├─ L0 コンテンツのみ(記事・データ・画像) → シークレットスキャンのみ(約1分)
   ├─ L1 軽微なコード変更(≤5ファイル/150行) → + lint / unit / build
   ├─ L2 標準リリース(レイアウト・大規模変更) → + E2Eスモーク / リンク切れ / Lighthouse
   └─ L3 セキュリティ敏感(認証・決済・DB・依存) → + SAST / 依存脆弱性(🙋レン承認は l3_approval: true のときだけ)
   │
   ▼
全ジョブ成功(1つでも落ちれば飛ぶ) → [deploy] main の先頭のときだけ wrangler deploy → [post-deploy] 本番スモーク+ヘッダ検査
                                                              ├ 失敗時: 30秒間隔で最大3回リトライ
                                                              │  (エッジ伝播前の旧レスポンス誤検知を防止)
                                                              ├ それでも失敗: Issue自動起票(ロールバック提案)
                                                              └ 通過: ブランチ qa-deployed を今回のコミットへ進める
                                                                 (= 次の判定の基準。下の「デプロイの安全装置」)
毎週月曜 09:00 JST
   └─ [security-weekly] 依存CVE / 本番ヘッダ / 全ページリンク切れ / (portalのみ)ZAP DAST → 問題あればIssue起票
```

判定を上書きしたいとき: コミットメッセージに `[qa:L0]`〜`[qa:L3]` を書くか、
Actions タブ → workflow_dispatch の `level_override`。
本番基準モードのサイトでは、ほかの push の未検証の変更が含まれるとき、上書きは**上げるのにだけ**効く。

## デプロイの安全装置(順番の守り + 本番基準モード)

QA の重さは変更ごとに違う(L0 約2分・L3 約10分)。同じサイトに続けて push すると、
**後から来た軽い実行が先に終わり、検査中・検査で落ちた前の変更ごと本番に出る**
(過去2か月で5件。検査で落ちたまま出た3件+検査完了前に出た2件。docs/qa-policy.md §2-2)。
これを2つの仕組みで防ぐ(2026-10-08 レン決定。2つで1組なので片方だけ外さない):

| 仕組み | どこ | 何をする |
|---|---|---|
| 順番の守り | 各サイトの deploy ジョブ | デプロイ直前に main の先頭を確かめ、先頭でない実行はデプロイを飛ばす(古いビルドで本番を戻さない) |
| 本番基準モード | qa.yml の `deployed_ref` + post-deploy.yml の `mark_deployed_ref` | 検査の重さを「直前の push からの差分」ではなく「本番に出て検証を通った最新のコミット(ブランチ `qa-deployed`)からの差分」で決める。検証が通ると post-deploy が `qa-deployed` を進める |

結果として、main の先頭の実行は「本番にまだ出ていない変更すべて」を必要な重さで検査してからデプロイする。

**運用で変わること(ロビ・各セッション向け)**
- L2/L3 の実行中に別の push を積んでも安全(積んだ側の実行が自動で重い検査になる)。
  ただし重い検査が2回走って分数を食うので、急がない push はまとめる
- **L3 が落ちたら、直すか revert を最優先**。直すか戻すまで、後ろに積んだ記事・データの更新も本番に出ない
  (落ちた変更を revert すれば本番との差が消えるので、検査は軽い方に戻る)
- `qa-deployed` ブランチは手で動かさない・消さない(手で進めると検査が抜ける。消した場合は次の実行が
  L3 で全部検査し、検証が通ったデプロイで自動的に作り直される)
- 古い実行の Re-run はデプロイしない(順番の守り)。ロールバックは revert して push
- L3 が落ちた後の小修正を `gh run cancel` → `level_override=L3` で通し直す手順(2026-10-03)は不要
- 本番にまだ出ていない(検証待ちの)コミットの確認:
  `git fetch origin && git log --oneline origin/qa-deployed..origin/main`

**導入状況**
| サイト | 順番の守り | 本番基準モード |
|---|---|---|
| 個室サウナナビ(portal-sauna) | ✅ 2026-10-07 | ✅ 2026-10-08(本番で実測済み。docs/qa-policy.md §2-2) |
| KAZOERU / リフォーム相場ナビ / 塗装相場ナビ | 準備済み・未導入 | 未導入 |
| 実家じまい案内所 | caller 未導入 | caller 未導入 |

Node の3サイトは、L3 が依存の既知脆弱性(OSV / npm audit)で通らない間は導入しない
(導入コミット自体が L3 で、本番基準モードは L3 が通るまで後続の push も止めるため)。
L3 が緑になったら、順番の守りと同じ push に `deployed_ref` / `mark_deployed_ref` / post-deploy の
`permissions` を載せる(templates/caller-media-qa-deploy.yml が完成形)。

## Actions の分数(無料枠 月2,000分)

private リポジトリの Actions は月2,000分まで無料で、yosage-inc は予算0円・超過で停止の設定。
**使い切ると月末まで全サイトの自動 QA・デプロイが止まる**(docs/qa-policy.md §5)。
課金はジョブごとに1分単位で切り上げなので、数秒で終わる検査でも独立したジョブにすると1分かかる。

- **2026-10-08 の対策**(レン承認「0円の対策を進める」): secrets-scan を classify に同居・qa-gate を廃止・
  approval を任意化(入力 `l3_approval`、既定は使わない)。1実行あたり L0〜L2 で2分・L3 で3分減る
  (9/1〜10/7 の実績に当てはめると全体の約18%。実測の前後比較は docs/qa-policy.md §2-3)
- **push は1つの作業の最後に1回にまとめる**(push 1回ごとに QA+デプロイが1本走る)。
  `[skip ci]` は使わない(順番の守りで、前の実行もそのコミットもデプロイしなくなる)
- 公開リポジトリ(この qa-standard)の実行と、Dependabot 自身の更新ジョブは無料枠に数えない
  ([GitHub Docs](https://docs.github.com/en/billing/concepts/product-billing/github-actions) /
  [Dependabot](https://docs.github.com/en/code-security/concepts/supply-chain-security/dependabot-on-actions))。
  ワークフローの試験は qa-standard の使い捨てブランチで行う(手順は docs/qa-policy.md §2-3)
- 今月の使用量(Dependabot と公開リポジトリの分も含むので、無料枠の消費より多めに出る):
  `gh api "/organizations/yosage-inc/settings/billing/usage/summary?year=2026&month=10" --jq '.usageItems[]|select(.sku=="actions_linux").grossQuantity'`

## リポジトリ構成

| パス | 役割 |
|---|---|
| `.github/workflows/qa.yml` | 本体: 判定→レベル別実行 (reusable) |
| `.github/workflows/post-deploy.yml` | デプロイ直後の本番検証 (reusable) |
| `.github/workflows/security-weekly.yml` | 週次セキュリティスキャン (reusable) |
| `scripts/classify-release.mjs` | QAレベル判定エンジン(依存ゼロ)。`--deployed-base` で本番基準モード |
| `scripts/classify-release.test.mjs` | 判定エンジンの自己テスト(`npm test`。使い捨ての git リポジトリで場面ごとに確かめる) |
| `scripts/check-headers.mjs` | セキュリティヘッダ検査(OWASP準拠)。`--retries` でリトライ可 |
| `scripts/smoke-check.mjs` | HTTP生存確認。`--retries` でリトライ可 |
| `scripts/e2e-smoke.spec.mjs` | 共通E2Eスモーク(サイト側テストコード不要) |
| `config/` | Playwright / Lighthouse / ポリシー例 |
| `templates/` | 各サイトに置く caller のコピー元 |
| `docs/qa-policy.md` | QA標準書(出典つき・なぜこの構成か) |

## 新しいサイトへの導入手順(ロビの作業、1サイト約5分)

1. `templates/caller-media-qa-deploy.yml`(ポータルは `caller-portal-qa-deploy.yml`)を
   サイトリポジトリの `.github/workflows/qa-deploy.yml` にコピー
   (順番の守り・本番基準モード入り。`qa-deployed` ブランチは最初の検証済みデプロイで自動的に作られる。
   それまでの実行は記録が無いので L3 になる=導入コミットの L3 が通ることが前提)
2. `templates/caller-weekly.yml` を `.github/workflows/weekly.yml` にコピー
3. `<OWNER>` を Organization 名に、`<YOUR-DOMAIN>` を本番ドメインに置換
4. `smoke_paths` を主要ページ(トップ+テンプレート種別ごとに1ページ)に設定
5. 必要なら `qa-policy.json` をリポジトリ直下に置いて判定ルールを調整
   (無くても classify 内蔵デフォルトで動く。`config/qa-policy.example.json` 参照)
6. サイト本体がリポジトリ直下でなくサブディレクトリにある場合(例: kazoeru は `site/`)は、
   qa.yml / security-weekly.yml の入力 `working_directory` にそのディレクトリを渡す。
   あわせて classify のデフォルト判定パターンはルート直下前提のものがある
   (`package.json` `wrangler.jsonc` 等)ため、`qa-policy.json` でサブディレクトリ分を足すこと

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
- [ ] ~~Settings → Environments → `qa-l3-approval` を作成し、Required reviewers に自分を追加~~
  → **GitHub Free / Pro / Team の private リポジトリでは required reviewers を設定できない**
  ([GitHub Docs](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)。
  2026-08-13 に API 422 でも確認)。qa.yml は既定で承認ジョブを走らせない(入力 `l3_approval`。下の「Actions の分数」)
- [ ] Issues のラベル `qa-failure`(赤)と `security`(黄)を作成(Issue自動起票用)
- [ ] (PR の必須チェックを使う場合) ブランチ保護・ルールセットは GitHub Free の private リポジトリでは使えない
  (API 403「Upgrade to GitHub Pro or make this repository public」、2026-10-08 に全サイトで確認)。
  有料プランで使うときは、呼び出し側に「`if: always()` で `needs.qa.result` を見て success 以外なら落とす」
  集約ジョブを1つ足してそれだけを必須にする。`needs` だけの集約ジョブは、依存が落ちると skipped になり、
  skipped は「Success」として扱われるため素通りする
  ([GitHub Docs](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/troubleshooting-required-status-checks))。
  以前の qa-gate ジョブがこの役だったが、必須チェックを使えない間は毎回1分かかるだけなので 2026-10-08 に廃止した

### 運用中(受動的でOK)
- [ ] (`l3_approval: true` のサイトだけ) L3 リリース時: GitHub から届く承認依頼メールの「Review deployments」→ Approve
  (内容に不安があればロビに「このL3リリースの変更内容を説明して」と聞く。今は該当サイトなし)
- [ ] 週次スキャンが起票した Issue の確認(対応はロビに依頼でOK)
- [ ] デプロイ後検証失敗の Issue が来たら最優先(本番が壊れている可能性)

## ローカルでの事前チェック(ロビ用)

```bash
# リリース前にQAレベルを予測
node scripts/classify-release.mjs --base origin/main --head HEAD --cwd /path/to/site

# 本番基準モードのサイトは、CI と同じく本番の検証済みコミットからの差分で予測する
git -C /path/to/site fetch origin
node scripts/classify-release.mjs --base origin/main --head HEAD --cwd /path/to/site \
  --deployed-base "$(git -C /path/to/site rev-parse origin/qa-deployed)"

# 判定エンジンを触ったら自己テスト
npm test

# 本番のヘッダ・生存確認
node scripts/check-headers.mjs --url https://example.com --profile static
node scripts/smoke-check.mjs --base https://example.com --paths "/,/about/"
```

どちらのスクリプトも `--retries N --retry-wait 秒` で「失敗時に待って再検査」ができる
(デフォルトはリトライなし)。デプロイ直後の Cloudflare Workers はエッジ伝播前の
旧レスポンスを返すことがあるため、post-deploy.yml は `--retries 3 --retry-wait 30` で
呼んでいる(成功時は即通過なので通常のデプロイ時間は延びない)。
ローカルからデプロイ直後に確認するときも同様に付けるとよい。
