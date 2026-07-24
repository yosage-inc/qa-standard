# Web事業 QA標準書

レンのWeb事業(メディアサイト・送客ポータル)における品質・情報セキュリティ品質の標準。
qa-standard リポジトリのワークフローはこの標準を実装したものである。
**出典なき数値は使わない**方針で作成(調査日: 2026-07-24)。

---

## 1. 設計原則

1. **リスクベース**: テストの厚さは変更のリスクに比例させる。ISTQB CTFL Syllabus v4.0 はリスクレベルを
   「発生確率 (Likelihood) × 影響度 (Impact)」で評価し、テスト活動をリスク分析に基づいて
   選択・優先順位付けする手法を risk-based testing と定義する
   ([ISTQB CTFL v4.0 §5.2](https://swisstestingboard.org/wp-content/uploads/2023/01/ISTQB_CTFL_Syllabus-v4.0-Beta-1.pdf))。
2. **fail-fast**: 軽量・高速なチェックを前段に、重量・高価なチェックを後段に置き、失敗したら早く止める
   (GitLab のステージ設計: 「ステージ内のジョブが失敗したら次ステージは実行しない」
   [GitLab CI Pipelines](https://docs.gitlab.com/ci/pipelines/))。
3. **変更ベースのテスト選択は業界の実践**: Shopify は変更ファイルからテストを選択して実行率約60%で
   失敗検出率(リコール)99.94%を達成、Vercel は変更のないプロジェクトのビルドを自動スキップ、
   GitLab は「リスクの高い変更(広範囲・セキュリティ重要コンポーネント)」にのみ追加レビューを推奨
   ([Shopify Engineering](https://shopify.engineering/spark-joy-by-running-fewer-tests) /
   [Vercel Monorepos](https://vercel.com/docs/monorepos) /
   [GitLab MR workflow](https://docs.gitlab.com/development/contributing/merge_request_workflow/))。
   ML型のテスト選択(Shopify/Meta 方式)は数万件規模のテストスイート向けであり、
   当事業の規模では**変更パスベースの機械的判定**が適正投資。
4. **自動チェックの限界を認める**: 自動アクセシビリティチェックが検出できる問題は57%
   (axe-core 開発元 Deque 社の2021年自社調査、第三者検証ではない点に注意
   [Deque Blog](https://www.deque.com/blog/automated-testing-study-identifies-57-percent-of-digital-accessibility-issues/))。
   CI が緑 = 品質保証完了ではなく、L3 の人間承認と週次監視で補完する。

## 2. QAレベル定義(リリースの大きさ・複雑さの自動判定)

`scripts/classify-release.mjs` が git 差分から自動判定する。判定優先順位は
①手動オーバーライド → ②L3パス該当 → ③全ファイルがL0パス → ④L2パス該当 → ⑤差分規模でL1/L2。

| レベル | 定義(リスク) | 実行するテスト | 想定所要 |
|---|---|---|---|
| **L0** | コンテンツ・データ・画像のみ。コード不変で影響度が最小 | シークレットスキャンのみ | 約1分 |
| **L1** | 軽微なコード変更(≦5ファイル かつ ≦150行) | + lint / unit / build | 3〜5分 |
| **L2** | レイアウト・テンプレート等の全ページ波及、または中規模以上の変更 | + E2Eスモーク / リンク切れ / Lighthouse | 8〜15分 |
| **L3** | 認証・決済・セッション・DBスキーマ・依存関係・CI設定・ヘッダ(影響度が最大の領域) | + SAST / 依存脆弱性スキャン / **人間の承認** | 15分+承認 |

- L0 でもシークレットスキャンを外さない理由: API キーの誤コミットはコンテンツ更新でも起こる事故で、
  影響度(Impact)が極めて高いため。
- しきい値(5ファイル/150行)は「変更(CL)を小さく保つ」という Google のレビュー文化
  ([google.github.io/eng-practices](https://google.github.io/eng-practices/review/developer/small-cls.html))を
  参考にした当事業の運用値(業界標準の固定値ではない。運用しながら `qa-policy.json` で調整する)。
- 「docs のみの変更で CI をスキップする」パターンは GitHub 公式の `paths-ignore` としても存在するが
  ([GitHub Docs](https://docs.github.com/en/actions/using-workflows/workflow-syntax-for-github-actions))、
  ワークフロー自体をスキップすると **required status check が Pending のまま残り PR をブロックする**
  公式記載の罠がある([GitHub Docs](https://docs.github.com/en/actions/using-workflows/triggering-a-workflow))。
  そのため本基盤は「ワークフローは常に起動し、classify が内部でジョブを間引く」方式を採る。
  required check には常に実行される `qa-gate` のみを指定すること。

## 3. 品質テストの標準

### 3-1. テスト構成の考え方(テストピラミッド)

- Google の公開している目安: **70% unit / 20% integration / 10% E2E**
  ([Google Testing Blog 2015](https://testing.googleblog.com/2015/04/just-say-no-to-more-end-to-end-tests.html))、
  書籍版では **80% unit / 15% integration / 5% E2E**
  ([Software Engineering at Google Ch.11](https://abseil.io/resources/swe-book/html/ch11.html))。
  いずれも「unit 最多・E2E 最少という形状」が本質で、比率は出発点の目安。
- 当事業への適用: 静的メディアサイトはロジックが薄いため unit は少なくてよい。
  ポータル(Hono + D1)は料金計算・権限判定等のロジックを unit でカバーし、
  E2E は「壊れていたら他が無意味になる主要動線」に限定する。

### 3-2. CI/CD パイプラインの標準ステージ

「lint → unit → build → E2E → deploy → 本番スモーク」の並びは、単一の標準文書ではなく
以下の複数一次情報の合成である(fail-fast の原則で軽いものを前へ):
- GitLab: build → test → deploy の順次ステージ + fail-fast
  ([GitLab CI](https://docs.gitlab.com/ci/pipelines/pipeline_architectures/))
- Atlassian: スモークテストは「本番デプロイ後・公開前の最終ゲート」
  ([Atlassian CD Pipeline](https://www.atlassian.com/continuous-delivery/principles/pipeline))
- Google: presubmit は高速・安定したテストのみ、低速テストは postsubmit へ
  ([SWE at Google Ch.23](https://abseil.io/resources/swe-book/html/ch23.html))

### 3-3. パフォーマンス基準(Core Web Vitals)

Google 公式の閾値(75パーセンタイル評価、[web.dev/vitals](https://web.dev/articles/vitals))を採用:

| 指標 | Good(採用基準) | Poor | 出典 |
|---|---|---|---|
| LCP (最大コンテンツ描画) | **≦2.5秒** | >4.0秒 | [web.dev/lcp](https://web.dev/articles/lcp) |
| CLS (レイアウトずれ) | **≦0.1** | >0.25 | [web.dev/cls](https://web.dev/articles/cls) |
| INP (操作応答) | **≦200ms** | >500ms | [web.dev/inp](https://web.dev/articles/inp) |

- CI では Lighthouse CI(`config/lighthouserc.json`)で LCP/CLS を error 閾値として強制。
  INP はラボ環境で正確に測れないため TBT(Total Blocking Time)300ms を warn で代用し、
  公開後はフィールドデータ(CrUX)で確認する。
- カテゴリスコアの基準: performance ≧0.8 (warn) / accessibility ≧0.9 (error) /
  SEO ≧0.9 (error、メディア事業の生命線) / best-practices ≧0.9 (warn)。
  これは当事業の運用値(preset `lighthouse:recommended` は静的サイトにノイズが多いため明示指定を採用)。

### 3-4. E2E スモークテスト

- ISTQB 定義: 「本格テスト開始前に、主要機能をカバーして正常動作を確認するテストスイート」
  ([ISTQB Glossary v3.5](https://www.erikvanveenendaal.nl/site/wp-content/uploads/ISTQB-Glossary-V3.5.pdf))。
  Google SRE Book: 「非常に単純だが重要な動作をテストし、より高価なテストを短絡させる」
  ([SRE Book](https://sre.google/sre-book/testing-reliability/))。
- 検査項目(主要ページ表示・認証フロー・主要フォーム送信)は公式標準ではなく
  複数の業界情報源に共通する実務パターン。本質は「壊れていたら他が無意味になる動線」をサイトごとに選ぶこと。
- 実装: `scripts/e2e-smoke.spec.mjs`(Playwright)。各 smoke_paths について
  HTTP 200 / `<title>` 非空 / JS エラーなし / console.error なし / 画像破損なしを検証。
  CI では Playwright 公式推奨に従い workers:1([playwright.dev/docs/ci](https://playwright.dev/docs/ci))。
  ポータルで本格的な E2E を書く段階では、公式の Smoke プロジェクト分離パターン
  ([playwright.dev/docs/test-projects](https://playwright.dev/docs/test-projects))へ移行する。

### 3-5. リンク切れチェック

- ツール: lychee([lycheeverse/lychee-action](https://github.com/lycheeverse/lychee-action)、
  Apache-2.0/MIT)。
- PR/リリース時(L2+)は `--offline` でサイト内リンク整合性のみ(外部リンクはフレーク源のため除外)。
  外部リンクを含む全数チェックは週次スキャンで実施し、`.lycheeignore` でレート制限サイトを除外。

### 3-6. アクセシビリティ

- 自動チェックは Lighthouse の accessibility カテゴリ(axe-core ベース)≧0.9 を error として強制。
- 限界の認識: 自動検出できるのは問題の約57%(Deque 2021年自社調査
  [出典](https://www.deque.com/blog/automated-testing-study-identifies-57-percent-of-digital-accessibility-issues/))。
  「自動+半自動で80%」という数値は半自動ツール込みであり自動単独の値ではない。
  会員向け重要フォーム(ポータルの登録・決済導線)は公開前に一度、キーボード操作のみでの
  完走確認を人間(またはロビの実機操作)で行う。

## 4. 情報セキュリティテストの標準

### 4-1. 準拠フレームワーク

| フレームワーク | 当事業での使い方 |
|---|---|
| [OWASP Top 10:2025](https://owasp.org/Top10/2025/) | 設計・コードレビューのチェックリスト見出し。2025年版で A03「Software Supply Chain Failures」が新設されており、依存関係の変更を L3 扱いする本基盤の判定と整合 |
| [OWASP ASVS 5.0](https://github.com/OWASP/ASVS/blob/master/5.0/en/0x03-What-is-the-ASVS.md) | 静的メディアサイト = **Level 1**(最低要件)、会員制ポータル = **Level 2** を目標。公式は「ほとんどのアプリケーションが目指すべき水準」と L2 を位置づける。※会員制小規模サービス=L2 は公式の直接指定ではなく合理的解釈である |
| [OWASP WSTG v4.2](https://owasp.org/www-project-web-security-testing-guide/v42/) | ASVS が「何を満たすか」、WSTG が「どう検証するか」。ポータルの認証(4.4)・セッション管理(4.6)の手動テスト手順として使用 |

### 4-2. CI セキュリティツール構成と選定理由

| ツール | 分類 | 実行タイミング | 無料条件(2026-07-24確認) |
|---|---|---|---|
| TruffleHog OSS | secrets | **全レベル・毎push** | Apache-2.0、無制限 |
| Semgrep CE (`semgrep/semgrep` Docker) | SAST | L3 + 必要時 | CLI は LGPL-2.1 で無制限無料(Platform 未登録運用) |
| osv-scanner + npm audit | SCA | L3 + 週次 | Apache-2.0 / npm 標準 |
| Dependabot (alerts + security updates) | SCA | 常時(GitHub 側) | 全プラン無料([GitHub Docs](https://docs.github.com/en/code-security/getting-started/github-security-features)) |
| OWASP ZAP baseline | DAST | 週次(portal のみ、本番URL) | Apache-2.0。baseline は非攻撃で「本番への実行も想定内」と公式明記([ZAP Docs](https://www.zaproxy.org/docs/docker/baseline-scan/)) |

**選定で避けたもの(理由つき)**:
- **gitleaks-action**: v2 以降 Gitleaks LLC の独自ライセンスで、**Organization 配下は1リポジトリまでしか無料にならない**
  ([公式README](https://github.com/gitleaks/gitleaks-action))。サイト量産計画(1サイト=1リポジトリ)と衝突するため
  TruffleHog OSS を採用。gitleaks コア CLI 自体は MIT なので、必要なら CLI 直接実行への切り替えは可能。
- **CodeQL**: private リポジトリでは GitHub Free/Pro プランで利用不可。有効化には Team プラン + GitHub Code Security
  ($30/active committer/月)が必要([GitHub Docs](https://docs.github.com/en/code-security/how-tos/scan-code-for-vulnerabilities/troubleshooting/troubleshooting-analysis-errors/cannot-enable-codeql-in-a-private-repository))。
  SAST は Semgrep CE で代替。
- **ZAP full scan**: 実攻撃を伴い「長時間実行の可能性」と公式が明記。**本番 URL には絶対に向けない**。
  ポータルで決済等の重要機能を追加する段階でステージング環境を用意し、リリース前ゲートとして導入する。

**頻度の根拠**: secrets はコミット時点が最重要(OWASP DevSecOps Guideline
[Pre-commit](https://github.com/OWASP/www-project-devsecops-guideline/blob/master/latest/01-Pre-commit.md))なので全レベルで実行。
SAST/SCA のフルスキャンを週次で回す設計は GitHub code scanning デフォルト(週次スケジュール
[GitHub Changelog](https://github.blog/changelog/2023-08-22-code-scanning-default-setup-now-analyzes-on-a-weekly-schedule/))および
Snyk Code(weekly 固定 [Snyk Docs](https://docs.snyk.io/manage-assets/configure-repository-monitoring))と同水準。
L1/L2 で SAST/SCA を省略できるのは、**依存関係やセキュリティ敏感パスの変更自体が L3 判定される**ため
(新規の脆弱性混入経路が塞がれている)+ 週次スキャンがリリース後に公開された CVE を拾うため。
NIST SP 800-53 RA-5 はスキャン頻度を「組織定義パラメータ」としており、数値頻度の業界義務は存在しない。

### 4-3. セキュリティヘッダ標準

[OWASP Secure Headers Project 公式推奨](https://github.com/OWASP/www-project-secure-headers/blob/master/mainsite/03_best_practices.md)
をベースに、当事業では以下を標準設定とする:

```
Strict-Transport-Security: max-age=63072000; includeSubDomains   # 2年。preload は公式提案どおり付けない
X-Content-Type-Options: nosniff
Content-Security-Policy: default-src 'self'; form-action 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; upgrade-insecure-requests
Referrer-Policy: strict-origin-when-cross-origin   # OWASP 提案は no-referrer だが、アフィリエイト成果計測にリファラが必要なため当事業はこの値
Permissions-Policy: camera=(), microphone=(), geolocation=()
Cross-Origin-Opener-Policy: same-origin            # ポータルのみ必須
X-Frame-Options: DENY                              # CSP frame-ancestors の後方互換
```

- **X-XSS-Protection は設定しない**(OWASP が Deprecated 指定。モダンブラウザで廃止済みで、
  むしろ問題を招きうるため CSP で代替)。
- Cookie(ポータル): `Secure` + `HttpOnly` + `SameSite` を必須とする。
  [Mozilla HTTP Observatory の採点実装](https://github.com/mdn/mdn-http-observatory/blob/main/src/grader/charts.js)で
  HttpOnly 欠如 -30 / Secure 欠如 -40 と、単一項目として最も重い減点であるため。
- 検査: `scripts/check-headers.mjs` がデプロイ直後と週次に自動検査(HSTS は1年以上で PASS、設定値は2年を推奨)。
  手動確認には [MDN HTTP Observatory](https://developer.mozilla.org/en-US/observatory) を使う
  (旧 Mozilla Observatory は 2024-10 にサンセット済み。目標グレード A 以上)。

### 4-4. Cloudflare Workers / D1 / Better Auth チェックリスト(ポータル構築時に必ず確認)

- [ ] シークレットは `wrangler secret put` のみで管理。`wrangler.toml` の `vars` に機微情報を書かない
      ([Cloudflare 公式](https://developers.cloudflare.com/workers/configuration/secrets/))。
      `.dev.vars` / `.env` は `.gitignore` 必須(本基盤の classify は `.env*` を L3 判定する)
- [ ] **drizzle-orm は 0.45.2 以上に固定**: それ未満は識別子エスケープ不備の SQL インジェクション脆弱性
      **CVE-2026-39356**(CVSS 7.5)あり([GitHub Advisory](https://github.com/advisories/GHSA-gpj5-g38j-94v9))
- [ ] 値のバインドは Drizzle の `sql` テンプレート / D1 の `.bind()` に統一(公式がインジェクション防止を明記)。
      テーブル名・カラム名をユーザー入力から動的に組む場合は必ず許可リスト方式にする(`sql.identifier()` に直接渡さない)
- [ ] Better Auth: `trustedOrigins` に本番ドメインを明示 / `/sign-in` 系に `customRules` で
      デフォルト(100リクエスト/60秒)より厳しいレート制限(例: 3回/10秒)/
      セッション有効期限デフォルト7日の妥当性を検討([Better Auth Docs](https://www.better-auth.com/docs/reference/security))
- [ ] Cloudflare 無料機能の有効化: Bot Fight Mode、ログイン/登録フォームへの Turnstile
      (無料枠: ウィジェット20個 [Cloudflare Docs](https://developers.cloudflare.com/turnstile/plans/))

### 4-5. 会員制サイトのリリース前 手動セキュリティテスト(L3 承認前にロビが実施し結果を添付)

| # | テスト項目 | 根拠 |
|---|---|---|
| 1 | パスワード最小8文字(推奨15)・漏えいパスワード拒否が効いている | ASVS V6.2 |
| 2 | ログイン試行のレート制限が実際に発動する | WSTG-ATHN-03 / ASVS V6.3 |
| 3 | ログイン成功時に新しいセッショントークンが発行される(固定化対策) | WSTG-SESS-03 / ASVS V7.2 |
| 4 | ログアウトでサーバー側セッションが無効化される(Cookie削除だけでない) | WSTG-SESS-06 / ASVS V7.4 |
| 5 | Cookie に Secure/HttpOnly/SameSite が付与されている | WSTG-SESS-02 |
| 6 | 偽装 Origin からの状態変更リクエストが拒否される(CSRF) | WSTG-SESS-05 |
| 7 | セッションタイムアウト(非アクティブ+絶対上限)が要件どおり | WSTG-SESS-07 / ASVS V7.3 |
| 8 | 登録・決済フォームをキーボードのみで完走できる(アクセシビリティ実機確認) | §3-6 |

### 4-6. 個人情報保護法(会員データを持つ時点で適用)

- 根拠: 個人情報保護法第23条(安全管理措置)、個人情報保護委員会
  [通則ガイドライン](https://www.ppc.go.jp/personalinfo/legal/guidelines_tsusoku/) 第10章。
  措置は「事業の規模・性質に応じて必要かつ適切な内容」でよい(全例示の実施義務はない)。
- 技術的安全管理措置4項目と本基盤の対応:
  ①アクセス制御(会員データを扱えるのはレンのみ、Cloudflare アカウント権限で担保)
  ②識別と認証(GitHub / Cloudflare の 2FA 必須化 — レンのタスク)
  ③外部からの不正アクセス防止(WAF Free Managed Ruleset + 依存脆弱性の週次スキャン + Better Auth レート制限)
  ④漏えい防止(全通信 HTTPS、シークレットスキャン、Cookie 属性検査)
- **注意**: 会員DBの個人数が過去6ヶ月のいずれかの日に5,000人を超えると「中小規模事業者」の
  軽減例示の対象外になる。ポータル会員が5,000人規模に近づいたら安全管理措置の文書化を強化する。
- 2026-07-17 に改正法が公布済み(施行日未定・政令待ち)。ガイドライン改定をウォッチする。

## 5. 運用ルール

| いつ | 何が走る | 人間(レン)の関与 |
|---|---|---|
| 毎 push / PR | classify → レベル別 QA → qa-gate | L3 のみ承認クリック |
| デプロイ直後 | 本番スモーク + ヘッダ検査 | 失敗 Issue が来たら最優先で対応指示 |
| 毎週月曜 09:00 JST | 依存脆弱性 / 本番ヘッダ / 全リンク / (portal) DAST | 起票された Issue の確認 |

- QA が検出した問題の対応順: ①本番障害(post-deploy 失敗) → ②シークレット漏えい →
  ③依存脆弱性 High 以上(1週間以内に更新) → ④リンク切れ・Lighthouse 劣化(次回リリースで)。
- GitHub Actions コスト管理: private リポジトリの無料枠は Free プランで 2,000分/月、
  Linux ランナー $0.006/分([GitHub Docs、2026-07-24 確認](https://docs.github.com/en/billing/managing-billing-for-github-actions/about-billing-for-github-actions))。
  L0 リリース(約1分)中心の運用なら1サイト月数十分で収まる。
  reusable workflow の実行分数は**呼び出し元リポジトリに課金される**ため、サイトを増やすほど
  合計消費は増える(qa-standard 側には集約されない)
  ([GitHub Docs](https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations))。

## 6. この標準の改訂

- しきい値・パスパターンの調整は各サイトの `qa-policy.json` で行い、全サイト共通の変更のみ
  qa-standard を更新する。
- 年1回(または OWASP Top 10 / CWV の改定時)にこの文書を見直す。
