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
   CI が緑 = 品質保証完了ではなく、週次監視とリリース前のレビューで補完する
   (L3 の人の承認ゲートは GitHub のプランの制約で今は使えない。§2-3)。

## 2. QAレベル定義(リリースの大きさ・複雑さの自動判定)

`scripts/classify-release.mjs` が git 差分から自動判定する。判定優先順位は
①手動オーバーライド → ②L3パス該当 → ③全ファイルがL0パス → ④L2パス該当 → ⑤差分規模でL1/L2。

| レベル | 定義(リスク) | 実行するテスト | 想定所要 |
|---|---|---|---|
| **L0** | コンテンツ・データ・画像のみ。コード不変で影響度が最小 | シークレットスキャンのみ | 約1分 |
| **L1** | 軽微なコード変更(≦5ファイル かつ ≦150行) | + lint / unit / build | 3〜5分 |
| **L2** | レイアウト・テンプレート等の全ページ波及、または中規模以上の変更 | + E2Eスモーク / リンク切れ / Lighthouse | 8〜15分 |
| **L3** | 認証・決済・セッション・DBスキーマ・依存関係・CI設定・ヘッダ(影響度が最大の領域) | + SAST / 依存脆弱性スキャン(人の承認ゲートは `l3_approval: true` のときだけ。§2-3) | 10〜15分 |

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
  (以前は required check 用に常に走る集約ジョブ `qa-gate` を置いていたが、ブランチ保護は GitHub Free の
  private リポジトリでは使えず、毎回1分かかるだけなので 2026-10-08 に廃止した。§2-3。
  有料プランで必須チェックを使うときの注意は README「レンのタスク」)

### 2-1. 判定の基準(何と比べるか)

| イベント | 比べる相手 | 備考 |
|---|---|---|
| pull_request | PR のベース | PR の変更全体 |
| main への push(従来) | 直前の push(`github.event.before`) | その push で増えた変更だけを見る |
| main への push / 手動実行(本番基準モード) | 本番に出て検証を通った最新のコミット(ブランチ `qa-deployed`) | このデプロイで本番が実際に変わる中身を見る(§2-2) |

従来の「直前の push」基準には穴がある。デプロイされるのは「その push の変更」ではなく
「その時点の main の全体」なので、前の push の変更が本番に出ていない(検査中・検査で落ちた・
取り消された)と、その変更が後ろの push の軽い検査で本番に出る。

### 2-2. 本番基準モード(2026-10-08 レン決定)

**決定**: 判定の基準を「本番に出て post-deploy の検証を通った最新のコミット」に変える(案A)。
qa.yml の入力 `deployed_ref` と post-deploy.yml の入力 `mark_deployed_ref` に同じブランチ名
(`qa-deployed`)を渡すと有効になる。各サイトの deploy ジョブの「順番の守り」(main の先頭でない
実行はデプロイを飛ばす)とセットで使う。

**きっかけ・実績**(4サイトの QA+Deploy 実行履歴 2026-08-03〜10-07 を全件集計):
- 検査で落ちた変更が、後ろの軽い push で本番に出た: 3件
  (portal-sauna 8/4 問い合わせフォーム=SAST と E2E で落ちた後の L1 修正 cc9f0c0 / reform-soba 8/12
  AdSense 導入=E2E で落ちた後の `[qa:L1]` 修正 19d55cf / portal-sauna 10/7 9922fa7 の L3 が Lighthouse で
  落ちる前に L0 の 38e6876 が先にデプロイ)
- 重い検査が終わる前に本番に出た: 2件(kazoeru 8/25 d5fd755・reform-soba 8/10 4ba3cae。どちらも直後に
  遅い実行が古いビルドで上書きし、新しい更新が一時的に本番から消えた=順番の守りで防ぐ側の事故)
- L3 が落ちた後の小修正が L1 判定で通る件(kazoeru 10/3)は、手作業(cancel → level_override=L3)で回避していた

**しくみ**(scripts/classify-release.mjs の `--deployed-base`):
- 判定する差分 = `qa-deployed` のツリー → head のツリー(2点の直接比較。履歴が書き換わっても本番との差になる)
- ほかの push の未検証の変更が含まれる(本番のツリー ≠ 直前の push のツリー)ときは、
  コミットメッセージのタグ・`level_override` は**上げるのにだけ**効く。自分の push の変更しか無いときは従来どおり
- `qa-deployed` が無い(導入直後・削除)ときは、本番に出ていない変更が分からないので L3。
  検証を通ったデプロイで post-deploy が自動的に作る
- head が `qa-deployed` より古い(古い実行の Re-run)ときはデプロイされないので従来の判定
- `qa-deployed` は post-deploy の検証が通ったときだけ、前にしか進めない(後から終わった古い実行は戻さない。
  force push で履歴が分かれたときだけ付け替える)。デプロイを飛ばした実行・検証で落ちた実行は進めない
- 本番と head の中身が同じ(デプロイ済みの先頭の再実行)なら、未検証の変更なし=安全側の L2

**この方式でできること・できないこと**
- 落ちた変更を revert すると本番との差が消えるので、検査は軽い方に戻る(従来は revert 自体が L3 だった)
- 重い検査が落ちたら、直すか revert するまで、後ろに積んだ記事・データの更新も本番に出ない(意図した止まり方)
- 本番基準モードの判定は、従来モードのサイトの判定を変えない(過去の push 1,002件で従来の判定と完全一致を確認)
- 手作業のデプロイ(ローカルの wrangler deploy)は `qa-deployed` を進めない=次の CI はそれより前からの
  差分で判定する(重い方に倒れるだけ)

**採らなかった案**
- 案B(デプロイ直前に本番からの差分で判定し直し、足りなければデプロイしない): 順番の守りと組み合わせると、
  重い検査を通った古い実行は「先頭でない」で飛び、軽い先頭の実行は「検査が足りない」で止まり、
  どちらもデプロイしない。解くには古い実行の待ち合わせ(待つ間も課金される)や手作業の再実行が要り、
  4サイトそれぞれに複雑な処理が入る
- 運用ルールのまま(L2/L3 の実行中はほかのセッションが push を待つ): 定期タスクなど自動で push する
  ものは待てず、抜けても気づけない
- concurrency(実行の直列化): GitHub の待機枠は1件だけで、待機中の新しい実行が後から来た古い実行
  (Re-run 等)に取り消され、その古い実行は順番の守りで飛ぶ=どちらもデプロイしない穴になる

**コスト**: 追加の外部サービス・支払いなし。増えるのは「本番に未反映の重い変更があるときに、
後ろの push も重い検査になる」分の Actions 分数で、上の期間の実行履歴に当てはめると11回・
約90分(月40分前後、無料枠2,000分の約2%)。記録の更新は post-deploy の既存ジョブの中で行うので
ジョブは増えない(Actions はジョブごとに1分単位で切り上げて課金されるため、
[GitHub Docs](https://docs.github.com/en/billing/reference/actions-runner-pricing))。

**本番での実測(2026-10-08 portal-sauna)**:
1. 導入コミット e9fff29(run 37644593424): `qa-deployed` が無いので警告つきで L3 → 全検査通過 → デプロイ →
   検証通過 → 「本番の検証済みコミットを記録(新規): qa-deployed = e9fff29」
2. 穴の再現テスト: L3 の 0df8c41(.github の変更・run 37647203989)を push し、その重い検査の実行中に
   手順書だけの 1024dd2(従来なら L0・run 37647263125)を積んだ。1024dd2 は
   「本番の検証済み e9fff29 からの差分で判定(ほかの push の未検証の変更を含む): .github/workflows/qa-deploy.yml」で
   **L3** になり、SAST(15:52:08)と E2E(15:56:05)を通った後の 15:56:20 にデプロイ・記録 e9fff29 → 1024dd2。
   0df8c41 の実行は「デプロイを飛ばした(main が先に進んでいる)」で、記録も進めない。
   従来の判定なら 1024dd2 は L0 として約1分半後(15:52頃)にデプロイし、0df8c41 の検査完了(15:55:38)より前に
   未検査の .github の変更ごと本番に出ていた
3. 直後に別セッションが push した build.py の変更 e40681e は、記録(1024dd2)=直前の push なので通常どおり L2
   (余計な引き上げなし)
4. 本番の全153ページ(sitemap + robots.txt・404)が `qa-deployed` のコミットの手元ビルドとバイト一致(各段階で実測)

**権限**: `qa-deployed` の更新には post-deploy ジョブに `contents: write` が要る。post-deploy.yml は
permissions を宣言せず呼び出し側の権限をそのまま使い(呼ばれる側は権限を上げられないため。
[GitHub Docs](https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations))、
書き込み権限つきのトークンは記録ステップと Issue 起票ステップにだけ渡す(チェックアウトは
persist-credentials: false)。既存の呼び出し側は従来どおり contents: read / issues: write。

### 2-3. ジョブの組み方と Actions の分数(2026-10-08 レン承認「0円の対策を進める」)

**前提**: private リポジトリの Actions は月2,000分まで無料で、yosage-inc は予算0円・超過で停止の設定(§5)。
課金はジョブごとに1分単位で切り上げる(「GitHub rounds the minutes and partial minutes each job uses up to the
nearest whole minute.」[GitHub Docs](https://docs.github.com/en/billing/reference/actions-runner-pricing))。
**数秒で終わる検査でも、独立したジョブにすると1分かかる** → 小さい検査は既にあるジョブに同居させる。

**実測**(2026-09-01〜10-07 の全実行。各ジョブの開始〜終了の秒数を1分単位に切り上げて合計した値は1,647分で、
請求 API の日別・リポジトリ別の合計1,644分とほぼ一致。集計は `gh api repos/yosage-inc/<repo>/actions/runs` →
各実行の `attempts/<n>/jobs`):

| ジョブ(QA + Deploy) | 課金(分) | 実時間(分) | 回数 | 1回の実時間(平均) |
|---|---|---|---|---|
| e2e-quality(E2E・リンク・Lighthouse) | 472 | 443 | 80 | 332秒 |
| deploy | 195 | 136 | 114 | 71秒 |
| build-test | 157 | 103 | 103 | 60秒 |
| classify | 139 | 19 | 139 | 8秒 |
| qa-gate | 139 | 8 | 139 | 4秒 |
| secrets-scan | 138 | 36 | 138 | 15秒 |
| post-deploy(verify-production) | 112 | 12 | 112 | 7秒 |
| security-deep | 50 | 36 | 38 | 56秒 |
| approval | 14 | 1 | 14 | 4秒 |

- 小さい5ジョブ(classify・secrets-scan・qa-gate・approval・verify-production)は課金542分に対して実時間76分
- e2e-quality の大半は Lighthouse(smoke_paths の各ページを3回ずつ計測。1実行あたり平均: サウナ5ページ219秒・
  KAZOERU 7ページ284秒・リフォーム8ページ320秒・塗装8ページ323秒)
- 期間の合計1,647分のうち、Dependabot 自身の更新ジョブ(103分)と公開リポジトリ qa-standard の実行(4分)は
  無料枠に数えない(「Running Dependabot on standard GitHub-hosted or self-hosted runners does not count towards
  your included GitHub Actions minutes.」[GitHub Docs](https://docs.github.com/en/code-security/concepts/supply-chain-security/dependabot-on-actions)、
  公開リポジトリの標準ランナーは無料 [GitHub Docs](https://docs.github.com/en/billing/concepts/product-billing/github-actions))。
  請求 API の合計にはこれらも載るので、無料枠の消費は請求 API の値より少し少ない。
  Dependabot が作った PR に走る QA(13回・142分)は Dependabot 自身の実行ではなく通常のワークフローの実行なので、
  この除外には当たらない

**変えたこと**(qa.yml。呼び出し側は変更不要):
1. **secrets-scan を classify に同居**: TruffleHog の実時間は平均7〜8秒・最大15秒で、classify(平均8秒)と合わせても
   1分に収まる。qa-standard の checkout より前に置き、スキャンする中身は従来のジョブと同じ。見つかったら判定ジョブごと
   落ち、後ろの検査とデプロイは全部飛ぶ(以前は他の検査が走り切ってから qa-gate で止まっていた=失敗時も分数が減る)。
   classify の最初の checkout の認証情報(本番基準モードの `git ls-remote` が使う)には触れていない
2. **qa-gate を廃止**: 呼び出し側の deploy は `needs: qa` + 状態関数の無い if(=暗黙の success())なので、qa の中の
   ジョブが1つでも失敗すれば飛ぶ(下の試験で確認)。qa-gate のもう一つの役(PR の必須チェック)は、ブランチ保護・
   ルールセットが GitHub Free の private リポジトリでは使えない(API 403。2026-10-08 に全6リポジトリで確認)ため
   使われていなかった
3. **approval を任意化**(入力 `l3_approval`、既定 false): 「If you are on a GitHub Free, GitHub Pro, or GitHub Team plan,
   required reviewers are only available for public repositories.」([GitHub Docs](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments))。
   ゲートは数秒で素通りしていた。さらに「設定漏れ検出」の警告は、gh api が失敗すると標準出力のエラー本文と
   `|| echo 0` の「0」がつながって判定をすり抜け、一度も出ていなかった(9/1〜10/7 の承認ジョブ14回のログすべてで確認。
   承認ジョブのトークンは contents: read だけで environment の設定を読めない)→ 読めない場合と未設定の場合を分けて警告する形に直した
4. actionlint の既存の指摘2件を直した(未使用の変数・Lighthouse の引数の単語分割。Lighthouse に渡す引数は4サイトの
   smoke_paths で従来と完全一致)

**見込み**: 1実行あたり L0〜L2 で2分・L3 で3分減。上の期間に当てはめると291分(全体の18%・QA + Deploy の21%)。

**試験**(公開リポジトリ qa-standard の使い捨てブランチ。標準ランナーは無料なので分数はかからない。
呼び出し側と同じ形の deploy 役ジョブ = `needs: qa` + 状態関数の無い if を置いた):

| 場面 | 期待 | 結果 |
|---|---|---|
| T1 L0 で全部通る | deploy 役が走る | ✅ classify(TruffleHog 4秒込みで9秒)→ deploy 役が走った。secrets-scan・qa-gate のジョブは無い |
| T2 L1 で build が落ちる | deploy 役は飛ぶ | ✅ build-test=failure → e2e・approval・deploy 役=skipped |
| T3 classify が落ちる(deployed_ref の名前が不正) | 後ろは全部飛ぶ | ✅ TruffleHog は通過→判定で「deployed_ref の名前が不正」→ 全部 skipped |
| T4 L2 で全部通る(2ページ) | deploy 役が走る | 初回は試験ページにリンクが無くリンク検査が「リンク0件」で落ちた(= e2e の途中の段が落ちても deploy 役は飛ぶことの確認にもなった)→ ページを直して再実行: ✅ classify → build-test → e2e-quality(E2E・リンク・Lighthouse)が通り deploy 役が走った |
| T5 L2 で E2E が落ちる(ページの JS エラー) | deploy 役は飛ぶ | ✅ E2E=failure(リトライ1回も失敗)→ deploy 役=skipped |

サウナ(portal-sauna)では使い捨てブランチ `claude/qa-min-test` の手動実行(workflow_dispatch・本番基準モード・
`l3_approval: true`)で1回確かめた。main 以外の ref なので deploy・post-deploy は動かず、本番と qa-deployed は変わらない:
run 37656897258(2026-10-08 02:09 JST)= success。classify 16秒(TruffleHog が全履歴1,691チャンクを走査して検出0 →
本番基準モードの判定「本番の検証済み e40681e からの差分で判定: .github/workflows/qa-deploy.yml」で L3。TruffleHog を同じ
ジョブに入れても、判定の `git ls-remote`・`git fetch`(最初の checkout の認証情報を使う)は動いた)→ build-test 8秒・
security-deep 66秒・e2e-quality 275秒 → approval 4秒(直した設定漏れ検出が「qa-l3-approval environment の設定を読めなかった」
と警告)→ deploy・post-deploy は skipped(main 以外)。課金換算は QA 部分で10分(既定の `l3_approval: false` なら9分)

**前後の実測**(1実行あたりの課金分数。変更前は 9/1〜10/7 の main への push の実行・全サイト平均。
「QA」は qa.yml の中のジョブ、「デプロイ」は deploy + post-deploy で、今回は変えていない):

| レベル | 変更前 QA + デプロイ | うち今回なくなった分 | 変更後(実測) |
|---|---|---|---|
| L0 | 3.0 + 2.6 = 5.6分(36回) | 2分(secrets-scan・qa-gate) | (main に入れた後の実行で追記) |
| L1 | 4.5 + 2.9 = 7.4分(20回) | 2分 | (同上) |
| L2 | 10.2 + 2.7 = 12.9分(45回) | 2分 | (同上) |
| L3 | 12.3 + 1.7 = 14.0分(21回) | 2.7分(approval は L3 の push のうち14回) | QA 9分(サウナの試験。同じサイトの変更前は QA 11.4分・5回)+ デプロイ(変わらない) |

**運用ルール: push をまとめる**: push 1回ごとに QA + デプロイが1本走る。10/1〜10/7 の main への push 76回のうち39回は、
同じサイトへの直前の push から20分以内だった(別のセッションの push も含むので「まとめられた上限」)。1つの作業の
push は最後に1回にまとめる(~/.claude/CLAUDE.md と、同じサイトに1日2回 push しうる定期タスク
yosage-daily-revenue・yosage-weekly-content の SKILL.md に記載)。`[skip ci]` は使わない(順番の守りで、前の実行も
そのコミットもデプロイしなくなる)。

**品質に関わるので提案止まりのもの**(レン判断待ち。数字は上の期間に当てはめた見込み):

| 案 | 減る分数 | 引き換え |
|---|---|---|
| Lighthouse を各ページ3回 → 1回 | 233分(14%) | 計測のぶれで止まるデプロイが戻る(3回の中央値は、同じビルドで LCP が 2700〜6300ms と振れて自動デプロイが止まったのを受けて 2026-08-12 に入れた。cd40116) |
| Lighthouse をトップページだけ(3回) | 312分(19%) | テンプレート別の性能劣化を Lighthouse では拾えなくなる(E2E スモークは全 smoke_paths のまま) |
| Dependabot の定期更新を週1 → 月1 | 約100分(PR の QA 142分の4分の3が減ると仮定) | 依存の更新が最大1か月遅れる(新しく公開された脆弱性は L3 の OSV と週次スキャンで別に拾う) |
| post-deploy を deploy ジョブに同居 | 96分(6%) | 4サイトの呼び出し側と順番の守り・本番基準モードの記録(書き込み権限)の組み直しが要る |

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
- **サードパーティタグ(GA4 等)は本番ドメインの hostname 判定で発火させる**(ビルドモード判定のみは不可):
  `import.meta.env.PROD` のようなビルド判定だけだと、本番ビルドを検査する CI やプレビュー環境でも
  タグが発火し、①本番アナリティクスへの計測データ汚染、②Lighthouse ラボ計測(モバイル・CPU 4倍減速)で
  タグ実行のロングタスクが LCP を押し上げる誤検出、の2つを起こす。
  実例(2026-08-04, reform-soba): GA4(gtag.js 169KB)導入直後から、実ブラウザ観測値 FCP=LCP≈190ms の
  ページ群がシミュレーション値 LCP 2495〜2556ms となり、閾値 2500ms をまたいで qa-gate が恒常失敗した
  ([該当ラン](https://github.com/yosage-inc/reform-soba/actions/runs/30931630638))。
  hostname 判定にすれば CI は自サイトコードの回帰を安定検知でき、タグ込みの実ユーザー体感は
  公開後のフィールドデータ(CrUX、上表の75パーセンタイル評価)で監視する。
  Lighthouse 側で計測から除外する代替案(`blockedUrlPatterns`)は、タグの発火実態と計測条件が
  ズレる二重管理になるため採らず、発火制御はサイト側に置くことを標準とする。

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
  デプロイ直後の検査は、Cloudflare Workers の新バージョンがエッジへ伝播する前の
  旧レスポンスを検査して誤 FAIL した実績があるため(portal-sauna Issue #3、rerun で全通過)、
  失敗時に 30 秒間隔で最大 3 回リトライしてから判定する(post-deploy.yml が `--retries 3` を指定)。
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
| 毎 push / PR | classify(シークレットスキャン込み)→ レベル別 QA | なし(L3 の承認ゲートは `l3_approval: true` のサイトだけ。今は該当なし) |
| デプロイ直後 | 本番スモーク + ヘッダ検査(失敗時は30秒×3回リトライ) | 失敗 Issue が来たら最優先で対応指示 |
| 毎週月曜 09:00 JST | 依存脆弱性 / 本番ヘッダ / 全リンク / (portal) DAST | 起票された Issue の確認 |

- QA が検出した問題の対応順: ①本番障害(post-deploy 失敗) → ②シークレット漏えい →
  ③依存脆弱性 High 以上(1週間以内に更新) → ④リンク切れ・Lighthouse 劣化(次回リリースで)。
- GitHub Actions コスト管理: private リポジトリの無料枠は Free プランで 2,000分/月、
  Linux ランナー $0.006/分([GitHub Docs、2026-07-24 確認](https://docs.github.com/en/billing/managing-billing-for-github-actions/about-billing-for-github-actions))。
  有料の支払い方法が無い・予算0円のときは、使い切った時点で止まる
  ([GitHub Docs、2026-10-08 確認](https://docs.github.com/en/billing/concepts/product-billing/github-actions)。
  yosage-inc は Actions の予算0円・超過で停止の設定=使い切ると月末まで全サイトの自動 QA・デプロイが止まる)。
  課金はジョブごとに1分単位で切り上げるため
  ([GitHub Docs](https://docs.github.com/en/billing/reference/actions-runner-pricing))、
  実測の1実行あたり(2026-08〜10、post-deploy まで含む)は L0 約5分・L1 約6〜8分・L2 約10〜14分・L3 約9〜17分
  (2026-10-08 の対策後の数字と内訳は §2-3)。
  月の合計は 2026-07 415分 / 08 1,548分 / 09 753分 / 10月は1〜7日(UTC)で891分(billing usage API で実測)。
  この値には無料枠に数えない Dependabot 自身の更新ジョブと公開リポジトリの分も含まれる
  (それを除くと 09 674分 / 10月1〜7日 863分。§2-3)。
  reusable workflow の実行分数は**呼び出し元リポジトリに課金される**ため、サイトを増やすほど
  合計消費は増える(qa-standard 側には集約されない)
  ([GitHub Docs](https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations))。

## 6. この標準の改訂

- しきい値・パスパターンの調整は各サイトの `qa-policy.json` で行い、全サイト共通の変更のみ
  qa-standard を更新する。
- 年1回(または OWASP Top 10 / CWV の改定時)にこの文書を見直す。
