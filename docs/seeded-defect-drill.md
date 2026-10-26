# 欠陥埋め込み訓練(seeded-defect drill)— QA 自身の検出率を測る(施策 4-1・基準 §5)

制定: 2026-10-20(レン指示「SaaS は情報漏洩が多いのでセキュリティ観点の品質管理も。いまの QA エージェントで担保されているか」
→ 答えを数字で持つための仕組み)。
対象: `~/yosage-webqa/`(S0-S3)と `~/yosage-appqa/`(M0-M3)。メディアサイトの CI(L0-L3)は対象外。
位置づけ: `qa-profile-standard.md` §2 の条件付き項目 `seeded-drill`(測定)と §5(本番と共有環境の保護)の実施手順。
施策の出典と根拠は `~/yosage-webqa/docs/2026-10-20-qa-upgrade-proposal.md` §3 の 4-1(出典番号 [n] はそこの §6)。
道具: `scripts/drill-guard-pre-push.sh`(訓練の枝を push させない)・`scripts/drill-guard.test.sh`(その自己テスト)・
`templates/drill-answer-key.example.json`(正解表の雛形)。

## 0. 一言で

わざと壊したコードを使い捨ての枝に仕込み、**いつもどおり QA を回して、いくつ見つかるかを数える**。
見つからなかった型をメニューやチェックリストに足す。これをやらないと「QA は良くなっているか」を誰も言えない。
健康診断で言えば、模擬の病変を混ぜた画像で読影の見逃し率を測るのと同じ。
訓練の枝は本番にも共有環境にも絶対に出さない(枝名・コミットの印・pre-push の守りの 3 重)。

## 1. 目的と測るもの

| 測るもの | 定義 | 使い方 |
|---|---|---|
| 検出率 DDP(訓練) | 見つけた数 ÷ 埋めた数 | QA の「見つける力」の基準値と推移。ISTQB はテスト有効性の指標に DDP を挙げる [28]。既知の欠陥を埋めて検出を見るのは error seeding の古典手法 [40] |
| 型別の検出 | 欠陥の型ごとの 見つけた / 埋めた | **落ちた型**がメニュー・チェックリストの強化対象(§12) |
| 誤報数 | 指摘のうち、埋めた欠陥でも本物の不具合でもなかった数 | 赤を信じられるか(test-quality-standard §1)。偽装の変更(§5-4)を指摘したら誤報 |
| 所要時間 | QA 全体の実測分と、訓練全体(埋める+回す+採点)の分 | 基準 §3 の時間上限の妥当性と、訓練のコストの記録 |

- 基準 §7 の DDP(QA で見つけた数 ÷(QA で見つけた数+漏れた数))とは分母が違う。**両方を四半期の見直しに並べる**。
  訓練の DDP は「仕込んだ欠陥に限った検出率」であり、本番の見逃し率そのものではない。
- **数字は目標にしない**(基準 §7)。LLM の判定者は「通すべきでないものを通す」型(真陰性が低い)が報告されている [30] ので、
  当社の数字を持つことが目的で、数字を上げること自体を目的にしない。

## 2. 役割の分離(3 係)

主観を混ぜないため、埋める係・回す係・採点係を分ける。**埋めた一覧(正解表)は回す係に見せない**。

| 係 | 誰 | すること | 持っていい情報 |
|---|---|---|---|
| 埋める係 | メインが立てる別のサブエージェント(Sonnet) | §3〜§5 のとおり枝を作り、欠陥と偽装の変更を仕込み、正解表(§9)を scratchpad に書く | 型の一覧・訓練の回数番号・対象リポジトリ |
| 回す係 | その基盤の QA エージェント(yosage-webqa / yosage-appqa) | いつもどおり QA を回し、レポートを書く(§7) | いつもの依頼文だけ(枝・レベル・変更概要)。正解表は見せない。訓練だと明かさない |
| 採点係 | メイン(ロビ本体) | レポートと正解表を突き合わせて採点(§8)・記録(§9)・後始末(§10)・強化(§12) | すべて |

- 埋める係と回す係は**別のサブエージェント**として立てる(サブエージェントは親の会話を読めず、渡したブリーフだけを見る。
  別セッションにする必要は無い)。回す係のブリーフには**正解表・件数・型・埋める係の出力(報告文・正解表の場所)を一切含めない**。
  埋める係の報告を受けたメインが、§7 の雛形どおりに依頼文を書き直してから回す係に渡す(埋める係の報告をそのまま転送しない)。
- 枝名が `drill/` で始まるので、回す係が「訓練かもしれない」と気づく余地はある(枝名は守りのために固定。§14)。
  それでも何を・いくつ埋めたかは分からないので、測定としては成り立つ。
- 採点係は正解表を読む前に、レポートを一度「普通の QA レポート」として検分する(いつもの検分の質を落とさないため)。

## 3. 枝の作り方(使い捨て worktree)

1. 基準点 = `ledger/last-qa-<app>.ref` のコミット(無ければ main の先頭)。基準点から枝を切ると、QA の差分 = 埋めた変更だけになる。
2. 作業ツリーは**使い捨ての worktree**。開発セッションの作業ツリー・枝には触らない(変異プローブと同じ作法。test-quality-standard §4-2)。
   **置き場所は一時領域(scratchpad・/tmp)にしない**(2026-10-27 改訂): 訓練 #1 で QA 実行中に Mac の時計が 6 日飛び、一時領域の掃除で worktree と正解表が消えた。`~/.qa-drills/<基盤>/drill-<日付>-<app>` のように消えない場所に作る。
   ```bash
   REPO=~/yosage-apps/albu; APP=albu; DATE=2026-10-20
   BASE=$(cat ~/yosage-appqa/ledger/last-qa-$APP.ref)
   mkdir -p ~/.qa-drills/appqa && git -C "$REPO" worktree add -b "drill/$DATE-$APP" ~/.qa-drills/appqa/drill-$DATE-$APP "$BASE"
   ```
   Node のアプリは `node_modules` をシンボリックリンクで共有してよい。Xcode は `project.yml` があれば `xcodegen generate`。
3. 枝名は **`drill/<日付>-<app>`**(例 `drill/2026-10-20-albu`)。コミットメッセージは **`[seeded-defect] drill <回数番号> #<連番>`** だけにする
   (何を埋めたかを書かない。メッセージは回す係が読む)。偽装の変更(§5-4)も同じ形。
4. 欠陥 1 件 = コミット 1 つ(正解表の `commit` に短縮ハッシュを書く。採点で diff を引きやすい)。
5. pre-push の守り(§13)が入っていることを先に確かめる。hooks の場所は**絶対パス**で取る(§13-2。`--path-format=absolute` が無いと
   cwd 相対の `.git/hooks` が返り、リポジトリの外から実行すると偽の「未導入」になる):
   `test -x "$(git -C "$REPO" rev-parse --path-format=absolute --git-path hooks)/pre-push" && echo ok`。
   入っていなければ先に入れる。**訓練の枝を push することは無い**(`--no-verify` は使わない)。

## 4. 欠陥の型の一覧(当社の事故由来)

型は当社の事故記録から取った(出典は右端)。`id` は正解表と台帳の `type` に使う。
「基盤」は埋められる基盤(Web = SaaS Web、iOS = モバイル)。拾うはずの項目は正解表の `expected_item` の既定値
(メニュー id は各基盤の `qa-menu.json`。チェックリストの項目は `checklists/` の id)。

| # | id | 型 | 基盤 | 拾うはずの項目(expected_item の既定値) | 由来 |
|---|---|---|---|---|---|
| 1 | `fail-open-detector` | 発火しない検出器・テスト(何を入れても緑。例外を握りつぶして PASS、アサーションが常に真) | Web/iOS | `test-diff-review`/B6、`mutation-probe` | 検査器で 3 回(content-quality-standard §6、2026-08-25)、test-quality-standard §2-2 |
| 2 | `float-boundary` | 浮動小数の境界ずれ(以上/未満・ちょうど半分・小数 1 桁の丸めが 1 段ずれる) | Web/iOS | `test-diff-review`/B7、`flows-regression`/境界行、`mutation-probe` | KAZOERU /bmi/ ほか 3 ページ(2026-10-08、7337b86) |
| 3 | `tenant-id-200` | 他テナントの ID を渡すと 200 で他社データが返る(WHERE の tenant_id 抜け、ID の出所がクライアント) | Web | `authz-matrix`、`saas-core`/T-1〜T-3 | webqa 鉄の掟 6。OWASP BOLA(qa-levels.md) |
| 4 | `numeric-input-fullwidth-decimal` | 数値入力の全角・かな入力の「。」・小数点が消えて 10 倍/空欄になる | Web/iOS | `flows-regression`/同値分割の行、`test-diff-review`/B8 | KAZOERU 100 ページ超の是正(2026-10-03〜13、施策案 [45]) |
| 5 | `year-rollover-timebomb` | 年替わりの時限(年を固定した id・今年前提の計算・期限の年を書き込み) | Web/iOS | `flows-regression`/時間を進めて確認する行、`test-diff-review`/時刻固定テストの有無、`charter`(SFDPOT の T) | 時限バグ(2026-08-31・2026-09-29、feedback-timebomb / feedback-hidden-conditional-notes) |
| 6 | `authz-table-passthrough` | 認可表の素通り行(期待が全部 200 の行、skip された行、ロールを読まない判定) | Web | `test-diff-review`/B2・B6、`authz-matrix` | 既存テスト棚卸しで消した fail-open 行(test-quality-standard §4-5、2026-10-20) |
| 7 | `billing-gate-off-by-one` | 課金ゲートの off-by-one(無料 50 件の 51 件目・9 枚の 10 枚目・36 枚の 37 枚目が通る/手前で止まる) | iOS/Web | `flows-regression`/境界行(ちょうど・±1)、`test-diff-review`、`mutation-probe` | 施策 1-3 の境界値(albu 50 件・コドモ声 9 枚・GENZO 36 枚) |
| 8 | `plist-usage-description-missing` | Info.plist の権限説明文の欠落(カメラ・写真・Face ID の UsageDescription が無い/空) | iOS | `static-checks`/権限整合、`permission-diff`、`privacy-appstore`/5.1.1 | appqa static_checks の権限整合(GENZO 初回 QA 所見#2、2026-09-15) |
| 9 | `plaintext-http` | 平文 http(ATS の全面許可・`http://` の URL・リダイレクト無し) | Web/iOS | iOS: `static-checks`/ATS、`security-masvs`/NETWORK。Web: `security-web`/12.2.1(旧 A04-2) | appqa static_checks の ATS 検査、security-web 12.2.1(2026-10-20 に ASVS 5.0 の ID へ組み替え済み。旧 ID は括弧併記のみ) |
| 10 | `secret-leak` | 秘密情報の混入(鍵・トークン・署名シークレットをコード・設定・ログに) | Web/iOS | `static-checks`/gitleaks、`saas-core`/B-4・P-1、`sast` | wrangler 鍵の表示事故(2026-10-03、feedback-secret-output) |
| 11 | `utc-jst-date-boundary` | UTC/JST の日付境界(Workers は UTC。JST 0:00〜8:59 に「今日」が前日になる) | Web | `flows-regression`/時刻固定の行、`test-diff-review`、`charter` | 施策案 G7・2-2 |
| 12 | `double-booking` | 二重予約(同じ棟・同じ日に同時送信で 2 本確定。冪等キーの再送で 2 件) | Web | `flows-regression`/同時送信の行、`saas-core`/T-6(同時実行: 排他と冪等性) | 施策案 G8・2-2。Stripe の冪等の定義 [18] |
| 13 | `japanese-calendar-dateformatter` | 和暦の DateFormatter(ロケール固定なしで「2016 年」が平成 2016 年に) | iOS | `test-diff-review`、`flows-regression`/暦設定の行、`mobile-conditions`/OS 設定 | 施策案 2-5・[41] |

### 変異の演算子(型の一覧に加えて、ランダム相当で入れるもの)

test-quality-standard §4-2 の 4 種。正解表の `type` は `mutation`、`mutation_operator` に次の id を書く。
添字は **0 始まり**(§5-3 の式 `(n + k) mod 4` の結果がそのまま添字)。

| 添字 | id | 演算子 | 例 |
|---|---|---|---|
| 0 | `compare-invert` | 比較の反転 | `<` → `<=`、`>=` → `>`、`==` → `!=` |
| 1 | `return-fixed` | 戻り値の固定 | `return isAllowed` → `return true` |
| 2 | `branch-delete` | 分岐の削除 | `if (!ok) throw` を消す、`guard` を外す |
| 3 | `constant-plusminus-1` | 定数の ±1 | `limit = 50` → `51`、`maxFailures = 5` → `4` |

## 5. 1 回の訓練の組み立て

### 5-1. 件数

- 1 回 **5〜8 件**(暫定・自社基準。施策案 4-1 の「5〜10 件」を S2/M2 の時間上限に収まる数に絞った)。
  そのうち**少なくとも 2 件は変異の演算子からランダム相当**(§5-3)。残り 3〜6 件は §4 の型の一覧から(§5-2)。
- 既存のユニットテストで赤になる埋め込みばかりだと「テストの力」を測るだけになる。**半分以上は既存テストが緑のままの埋め込み**にする
  (暫定・自社基準。埋める係はテストを 1 回回して、赤になった件数を正解表の `description` に書く)。
- **優先順位(両立しないとき)**: この「半分ルール」は **§4 の型の一覧から取る 3〜6 件にだけ**適用する(型は §5-2 で決まるが、
  その型を埋める場所は埋める係が選ぶので、既存テストが緑のままの場所を選んで満たす)。ランダム相当(§5-3)は**式を優先**し、
  式で決めた対象が既存テストで赤になっても対象を変えない。赤になった件数を正解表に記録するだけ(半分未満でも対象を変えない)。

### 5-2. 型は毎回入れ替える(回数番号で決める)

型の一覧(§4 の # 順・13 個)から、**開始位置 = ((回数番号 − 1) × 4) mod 13** として順に取る(開始位置は 0 始まり。0 = #1)。
**取る件数 = その回の件数(§5-1)− ランダム相当の件数**(例: 5 件の回でランダム相当が 2 件なら、型の一覧から 3 件)。
その基盤に当てはまらない型(iOS に `tenant-id-200` など)は飛ばし、**飛ばした型は全部**、理由つきで正解表の `type_rotation.skipped` に書く
(黙って落とさない。取り終えた位置より後ろの型は「飛ばした」ではなく「今回は未到達」なので書かない)。
取った型は `type_rotation.picked` に書き、`defects[]` の `type` と一致させる(picked に無い型を埋めない・埋めた型を picked から落とさない)。
4 と 13 は互いに素なので、回数を重ねると開始位置が全部の型を一巡する(回 1=#1 から、回 2=#5 から、回 3=#9 から、回 4=#13 から…)。
回数番号は基盤ごと・アプリごとに 1 から数える(台帳 `drills.jsonl` の同じ `app` の行数 + 1)。

### 5-3. ランダム相当(埋める係の裁量を無くす)

乱数を使わず、回数番号 n から決める(再現できる。埋める係が「見つけやすい所」を選べない)。暫定・自社基準。

1. 候補の列挙は**機械で**やる(何を「判断」と数えるかに裁量を残さない。2 回やっても同じ N・同じ順になる)。
   対象リポジトリ(訓練の worktree)で次の 1 本を実行し、出力の各行(`ファイル:行番号:内容`)を候補とする。
   `git grep` の出力はパス順→行番号順で決定論的なので、並べ替えない:
   ```bash
   # iOS(Swift)
   git -C <worktree> grep -nE '^[[:space:]]*(if|guard|while|case|return)[[:space:]].*(<=|>=|==|!=|<|>)' \
     -- '*.swift' ':!*Tests*' ':!*UITests*' | head -200
   # SaaS Web(TypeScript / JavaScript)。対象はサーバ側の判断がある src ディレクトリに限る(daicho は apps/api/src)
   git -C <worktree> grep -nE '^[[:space:]]*(if|while|case|return)[[:space:]].*(<=|>=|==|!=|<|>)' \
     -- 'apps/api/src' ':!*test*' ':!*spec*' | head -200
   ```
   候補数 N は出力の行数。**上限 200 行**(暫定・自社基準。超えたら先頭 200 行だけを候補にし、超えたことを `random_candidates.note` に書く)。
   実行したコマンドと出力(候補一覧)を正解表の `type_rotation.random_candidates`(`cmd` / `count` / `list` / `note`)に**そのまま保存**する(採点係が再現できる)。
   2026-10-20 の実測: albu 46 行・daicho(`apps/api/src`)103 行(daicho を `public/` の画面 JS まで広げると 297 行で上限超え。広げない)。
2. k 件目(k = 0, 1, …)のランダム相当は: 演算子 = §4 の演算子一覧の **添字 (n + k) mod 4**、対象 = 候補の **添字 (n × 7 + k) mod N**。
   **添字はどちらも 0 始まり**(演算子 0=`compare-invert`、1=`return-fixed`、2=`branch-delete`、3=`constant-plusminus-1`。
   候補も先頭行が 0)。正解表の `description` には「候補 N 行中 添字 (n×7+k) mod N = m(0 始まり)」の形で書く。
3. その対象にその演算子が適用できない(定数が無い等)ときは、次の候補へ 1 つずらし(添字 +1。末尾なら 0 へ)、ずらしたことを `description` に書く。

### 5-4. 偽装の変更(誤報を測る)

振る舞いを変えない変更を **1〜3 件**(暫定・自社基準)混ぜる(変数名の変更・コメントの整理・同値の書き換え)。
正解表の `decoys` に書く。既存テストが全部緑であることを確かめてからコミットする(本当に無害でなければ誤報の計測にならない)。
回す係がこれを欠陥として指摘したら誤報に数える。

### 5-5. 埋める係が守ること

- ビルドを壊さない(ビルドが落ちると QA が始まらず、何も測れない)。埋めた欠陥は**実際に到達できる**(呼ばれない関数に埋めない)。
- コードのコメント・変数名・コミットメッセージに手がかりを残さない(`// seeded`、`TODO drill` 等は禁止)。
- 本番・共有環境に向く操作をしない(push・デプロイ・`wrangler` の本番コマンド・ASC)。基準 §5。
- 秘密情報の型(`secret-leak`)は**本物の鍵を使わない**。形だけの偽の値(例: `sk_test_` に続く無意味な文字列)で、正解表にもその値を書かない。
- 正解表(§9)は対象リポジトリの外(scratchpad)に書き、場所をメイン(採点係)にだけ返す。回す係のブリーフに渡さない(§2)。

## 6. レベル(S2・M2 で回す)

- 回すレベルは **S2 / M2**(基本項目+その回のメニューの条件付き項目)。フェーズ・特性はそのアプリの `qa.config` のとおり
  (メニューは `node ~/qa-standard/scripts/qa-menu.mjs --menu <基盤>/qa-menu.json --level S2 --config <worktree>/<qa.config の場所>`)。
  - `qa.config` の場所はアプリごと(albu・GENZO・コドモ声はリポジトリ直下。**daicho は `apps/api/qa.config`**。直下には無いので
    `--config <worktree>/apps/api/qa.config`。`judge_level.sh` も `--repo <worktree>/apps/api`)。
  - `qa.config` が無い、または `QA_PHASE` / `QA_TRAITS` が書かれていないアプリは、**先に書く**か `--phase` / `--traits` を明示して出す。
    未記入のままだと `launch` 扱い(基準 §1-2 の安全側)になり、時間上限と項目が変わって基準値が取れない(§11 の表の注記)。
- **レベルの引き下げではない**: 訓練はリリース QA ではないので、`judge_level.sh` の出力は正解表に記録するだけで `--override` は使わない
  (基準 §1-1「セキュリティ起因の最高レベルは引き下げ不可」はそのまま)。回す係には基準どおり**メインがレベル(S2/M2 + 追加項目)と
  メニュー出力を依頼文で渡す**(エージェント定義: レベルとメニューが渡されたらそれに従う)。
- 採点係は訓練の枝で `judge_level.sh` を 1 回走らせ、**出力を正解表の `judge_level_output` に残す**(埋め込みのパスに判定器が反応したかも検出の一部)。
  **必ず `--base "$BASE"` を付ける**: `judge_level.sh` は worktree 名(`drill-<日付>-<app>`)をアプリ名にして `ledger/last-qa-drill-….ref` を探し、
  無いのでタグか初回コミットに基準点が落ちて「実質フル QA = S3/M3」の誤判定になる(appqa / webqa 両方の判定器で同じ)。
  ```bash
  ~/yosage-appqa/scripts/judge_level.sh --repo <worktree> --base "$BASE"            # iOS
  ~/yosage-webqa/scripts/judge_level.sh --repo <worktree>/apps/api --base "$BASE"   # daicho
  ```
  回す係が判定器を自前で走らせると同じ誤判定を踏む(webqa なら S3 = レン承認待ちで止まり得る)ので、§7 の依頼文にメニュー出力を添付して
  自前で出させない。
- **セキュリティ由来の埋め込みがある回だけ、S3/M3 の該当項目を追加する**(全項目ではない。必要最低限)。
  `security-web` の ID は 2026-10-20 に ASVS 5.0 の ID へ組み替え済み(旧 ID は括弧併記のみ。実行係・採点係は現行 ID で探す):

| 埋めた型 | 追加する項目(Web) | 追加する項目(iOS) |
|---|---|---|
| `tenant-id-200` | `security-web`/Y-8-1(旧 A01-1) | — |
| `authz-table-passthrough` | `security-web`/Y-8-1・Y-15-5(旧 A01-1・A10-1) | — |
| `secret-leak` | `sast`、`security-web`/Y-13-3(旧 A04-3) | `security-masvs`/STORAGE・CRYPTO の鍵の行 |
| `plaintext-http` | `security-web`/12.2.1(旧 A04-2) | `security-masvs`/NETWORK |
| `plist-usage-description-missing` | — | `privacy-appstore`/5.1.1 |

- 時間上限は基準 §3 のとおり(S2 build 60 分 / M2 build 45 分、launch 以降 90 / 60 分)。上限で落ちた項目は回す係が「未実施(時間上限)」と書く。
  その項目で拾うはずだった欠陥は**見逃しに数える**(実際に回した QA は見つけていない)が、`unperformed_items` に別記して、
  四半期の見直しで「時間が足りない」と「見る力が無い」を分けて読む。

## 7. 回す(QA エージェントへの依頼文)

いつもの依頼文と同じ形で渡す。訓練だと書かない。正解表の中身・件数・型を書かない。
**メニュー出力(採点係が §6 のとおり S2/M2 で生成した `qa-menu.mjs` の md)を添付する**(回す係に `judge_level.sh` を自前で走らせない。§6)。

> リポジトリ: `<scratchpad>/drill-<日付>-<app>`(枝 `drill/<日付>-<app>`)
> レベル: S2(または M2)+ 追加項目 `<§6 の表の項目があれば>`
> メニュー出力: 以下のとおり(添付)。このメニューの項目だけを順に実行すること
> 変更概要: 基準点 `<base_commit>` からの差分(判断ロジックとテストの変更を含む)
> いつもどおりメニューに従って回し、実施しなかった項目は理由つきで書くこと。
> 台帳(`ledger/qa-log.jsonl`)と `ledger/last-qa-<app>.ref` の更新はこちらで行う(書かない・動かさない)。

- 最後の 1 行は通常の QA でも README の [記録] がメインの仕事なので、訓練だと明かすことにならない。
  回す係には訓練だと明かさない設計なので、「書くな」という指示は依頼文に入れないと届かない(appqa `qa-levels.md` は
  「QA 合格時にエージェントが `last-qa-<app>.ref` を更新する」としており、放っておくと ref が §10 で消す訓練コミットを指す)。
- 回す係は QA 台帳 `ledger/qa-log.jsonl` に**書かない**(採点係が §9 の `drills.jsonl` に書く)。`last-qa-<app>.ref` も動かさない。
- 回す係がレポートを `ledger/reports/` に書いた場合、採点係が `ledger/drills/<日付>-<app>/report.md` へ移す(通常の QA 履歴に混ぜない)。

## 8. 採点(採点係=メイン)

1. 正解表を読む**前に**、レポートをいつもの QA レポートとして検分する(§2)。
2. 正解表の `defects[]` を 1 件ずつ、レポートの指摘と突き合わせる。判定の決まり:

| 判定 | 条件 |
|---|---|
| 見つけた(`found: true`) | 同じファイル(または同じ症状の再現)で、**同じ誤った振る舞い**を指摘している。行番号は ±10 行を許容(暫定・自社基準)。重要度は問わない |
| 重要度の不一致(`severity_mismatch`) | 見つけたが、報告の重要度が正解表より 2 段以上低い(暫定・自社基準。Web の 4 段階 Blocker/High/Medium/Low では Blocker→Medium/Low・High→Low、モバイルの 3 段階 Blocker/Major/Minor では Blocker→Minor の 1 通りだけ)。見つけた数には入れる |
| 見逃し(`found: false`) | 指摘が無い。ファイルに「変更あり」と触れただけ・差分を要約しただけは見逃し |
| 未実施(`unperformed_items` に項目 id) | 拾うはずの項目が「未実施」と記録されている。見逃しに数え、別記する |

3. 指摘の残り(正解表に無いもの)を分類する:
   - **偽装の変更への指摘** → 誤報
   - **本物の不具合**(基準点のコードで採点係が再現できる) → `bonus_found`。誤報ではない。通常の不具合として開発セッションへ渡す
   - **どちらでもない**(是正不要) → 誤報
4. 数字を出す: `seeded`・`found`・`ddp = found ÷ seeded`・`found_by_type`(型ごとの 見つけた/埋めた)・`missed_types`・
   `false_alarms`・`bonus_found`・`minutes_qa`(レポートの実測分)・`minutes_total`。
   あわせて **`ledger/last-qa-<app>.ref` と `ledger/qa-log.jsonl` に訓練の行・訓練コミットが無いことを確認**する
   (`cat ledger/last-qa-<app>.ref` が `base_commit` のまま / `grep drill/ ledger/qa-log.jsonl` が空)。動いていたら元に戻し、正解表の `grading_summary.note` に書く。
5. 報告(レンへ、噛み砕いて): 「埋めた n 件のうち m 件を見つけた(型別に ○○ は全部、△△ は 0/2)。誤報 k 件。落ちた型は ××。
   次回までに ×× の検査を足す」。数字は目標にしない旨を添える。

## 9. 記録

### 9-1. 正解表(answer key)

- 雛形: `templates/drill-answer-key.example.json`。必須の欄は `defects[]` の `id` / `type` / `file` / `line` / `description` / `expected_item` / `severity`。
  `expected_item` は「`<メニュー id>/<チェックリストの項目か手順書の行>`」。拾う項目が無ければ `"該当なし"`(それ自体が §12 の材料)。
- 置き場所: **最初から各基盤の `ledger/drills/<日付>-<app>/answer-key.json`**(対象リポジトリの外・消えない場所。2026-10-27 改訂: 一時領域に置いた訓練 #1 の正解表が消え、コミットの diff から復元する羽目になった)。
  回す係には場所を教えず、エージェント定義で「訓練では正解表を見ない」と定めている。QA の所見なので非公開の ledger 側に置く。
- 秘密情報を書かない(§5-5)。

### 9-2. 台帳 `ledger/drills.jsonl`(基盤ごと・1 回の訓練 = 1 行)

```json
{"date":"2026-10-20","app":"albu","level":"M2","seeded":5,"found":3,"missed_types":["fail-open-detector","japanese-calendar-dateformatter"],
 "false_alarms":1,"minutes":41,"report":"drills/2026-10-20-albu/report.md",
 "drill_no":1,"branch":"drill/2026-10-20-albu","base_commit":"abc1234","judge_level":"M3(vault)","bonus_found":0,
 "unperformed_items":[],"cleanup_verified":true}
```

- 最初の 9 項目(`date` `app` `level` `seeded` `found` `missed_types` `false_alarms` `minutes` `report`)は基準 §2 `seeded-drill` の記録項目。
  `minutes` は QA 全体の実測分(回す係のレポートの値)。
- 後ろの項目は追加(訓練の再現と後始末の確認用)。`cleanup_verified` は §10 の確認が済んだら `true`、済んでいなければ `false` のまま残す(黙って消さない)。
- `~/yosage-webqa/ledger/drills.jsonl` と `~/yosage-appqa/ledger/drills.jsonl`。レポートと正解表は `ledger/drills/<日付>-<app>/`。
- 四半期の見直し(`docs/qa-quarterly-review.md`)で `scripts/qa-metrics.mjs` の出力と並べて読む。

## 10. 後始末(worktree・枝を消し、残っていないことを確かめる)

採点と記録が終わったら、その日のうちに消す。消したことを台帳(`cleanup_verified`)に書く。

```bash
REPO=~/yosage-apps/albu; APP=albu; DATE=2026-10-20
git -C "$REPO" worktree remove --force ~/.qa-drills/appqa/drill-$DATE-$APP
git -C "$REPO" branch -D "drill/$DATE-$APP"
git -C "$REPO" worktree prune
# 確認(4 つとも「本体だけ/空」であること。出力を採点の記録に貼る)
git -C "$REPO" worktree list                                   # 本体の 1 行だけ
git -C "$REPO" branch --list 'drill/*'                         # 空
git -C "$REPO" ls-remote --heads origin 'drill/*'              # 空(守りが効いていれば最初から無い)
git -C "$REPO" log --all --oneline --fixed-strings --grep='[seeded-defect]'   # 空
```

- 回す係が変異プローブで作った worktree(`<scratchpad>/mutation-<n>`)が残っていれば同じように消す(`git worktree list` に出る)。
- 消した枝のコミットは reflog の期限まで手元に残るが、どの枝からも届かないので push されない(害は無い)。
- 正解表を scratchpad から `ledger/drills/` へ移したことも確かめる(scratchpad はセッションと一緒に消える)。

## 11. 頻度

| フェーズ | 頻度 | 備考 |
|---|---|---|
| `build` | **初回 1 回**(基準値) | 手順が動くことの確認も兼ねる。初回は 5 件でよい |
| `launch` 以降 | **四半期に 1 回** | 四半期の見直し(`docs/qa-quarterly-review.md`)の**前**に回し、結果を見直しの材料にする |

- 対象アプリ: SaaS Web = みんなの台帳(daicho)、モバイル = albu・GENZO・コドモ声シール帳。基盤ごとに 1 アプリ回せば、その基盤の QA の力は測れる
  (アプリ固有の型を測りたいときは増やす。暫定・自社基準)。

| 対象 | 基盤 | `qa.config` | 初回(build)の前にすること(2026-10-20 時点) |
|---|---|---|---|
| albu / GENZO / コドモ声シール帳 | appqa | リポジトリ直下 | `QA_PHASE` / `QA_TRAITS` が書かれているか確認(無ければ書く) |
| みんなの台帳(daicho) | webqa | **`apps/api/qa.config`**(直下には無い) | **`QA_PHASE="build"` と `QA_TRAITS`(そのアプリの実態で。基準 §1-3)を書く**。無いと launch 扱い(時間上限 90 分・launch の項目)になり「build 初回 1 回(基準値)」にならない。`ledger/last-qa-daicho.ref` も無いので基準点は §3 の fallback(main の先頭) |
- 基準 §2 の `seeded-drill` の `frequency`(build: first / launch・scale: quarterly)と同じ。

## 12. 落ちた型をメニュー・チェックリストへ足す手順(基準 §4 の強化ルールに接続)

見逃した欠陥 1 件につき、正解表の `expected_item` で分岐する。**1 回の QA で新しく足す項目は原則 1 つ**(基準 §6)なので、
複数落ちたら影響の大きい型(Blocker 相当)から。

| `expected_item` | すること | 書く場所 |
|---|---|---|
| 項目はあり、`所見(WARN)` 扱い | 基準 §4「強化」: その項目を **FAIL 可に戻す/頻度を上げる**。`qa-menu.json` の `status`/`frequency` を日付つきで変え、`history` に「訓練 #n で `<型>` を見逃し」と書く | 各基盤の `qa-menu.json` |
| 項目はあり、FAIL 可だが見逃した | その項目の**確認方法に具体の手がかりを 1 行足す**(例: saas-core T-3 に「JOIN・集計クエリも」、flows の境界行に「ちょうど・±1 の 3 点」)。チェックリストなら `checklists/`、手順書なら `flows/`、兆候なら test-quality-standard §2 の表 | 該当のチェックリスト・flows・基準 |
| `該当なし`(拾う項目が無い) | **新しい項目を「所見(WARN)」で足す**(基準 §4。いきなり FAIL 可にしない)。`qa-menu.json` に `since` を書き、3 回誤検出 0 で昇格 | `qa-menu.json` + 項目が指す節 |
| 未実施(時間上限) | 項目を足さない。四半期の見直しで時間上限か項目の順番を見直す材料にする | `docs/qa-quarterly-review.md` の材料 |

- 変更はレンに報告する(基準 §4)。何を・なぜ足したかを、訓練の報告(§8-5)に続けて 1 行ずつ。
- 足した項目は次の訓練で同じ型を必ず入れる(回数番号の順番に関係なく 1 件追加)。直ったかを次回で確かめる。

## 13. push の守り(`scripts/drill-guard-pre-push.sh`)

### 13-1. 何をするか

git の pre-push フックとして、push しようとする参照のどれかが次に当たれば **push 全体を拒否して理由を出す**:
(1) 枝名が `drill/` で始まる(ローカル側・リモート側のどちらでも)、(2) 新しく送るコミットのメッセージ(件名・本文)に `[seeded-defect]` がある。
削除(`git push --delete`)・タグ・普通の枝は通る。依存は git と `/bin/sh` だけ(0 円)。

### 13-2. 導入(4 リポジトリ。1 つ 1 分)

フックは各リポジトリの hooks ディレクトリに**コピー**して入れる(git はフックをリポジトリに含めないので、clone し直したら入れ直す)。
worktree は本体の hooks を共有するので、訓練の worktree にも自動で効く。

hooks の場所は **`--path-format=absolute` で絶対パスとして取る**(git 2.31+。手元は 2.54)。これが無いと `git -C "$REPO" rev-parse --git-path hooks` は
**cwd 相対の `.git/hooks`** を返す(`-C` でリポジトリに入ってから相対パスを返す仕様)ので、ホームなど別の場所から実行すると `cp` が
「No such file or directory」になり(cwd が別の git リポジトリならそのリポジトリの hooks に入ってしまう)、`test -x` も偽の「未導入」になる。
下のループと確認コマンドは **cwd に依らない**。

```bash
for REPO in ~/yosage-apps/albu ~/yosage-apps/genzo ~/yosage-apps/koe-techo ~/yosage-saas/daicho; do
  HOOKS="$(git -C "$REPO" rev-parse --path-format=absolute --git-path hooks)"
  cp ~/qa-standard/scripts/drill-guard-pre-push.sh "$HOOKS/pre-push" && chmod +x "$HOOKS/pre-push"
  echo "$REPO → $HOOKS/pre-push"
done
```

| リポジトリ | 基盤 | 2026-10-20 時点の既存 pre-push |
|---|---|---|
| `~/yosage-apps/albu` | appqa | 無し(.sample のみ) |
| `~/yosage-apps/genzo` | appqa | 無し(.sample のみ) |
| `~/yosage-apps/koe-techo` | appqa | 無し(.sample のみ) |
| `~/yosage-saas/daicho` | webqa | 無し(.sample のみ) |

入ったことの確認: `test -x "$(git -C <repo> rev-parse --path-format=absolute --git-path hooks)/pre-push" && echo ok`。
動くことの確認(push せずに): 標準入力に 1 行渡すと拒否文が出て終了コード 1 になる。
```bash
echo "refs/heads/drill/x 1111111111111111111111111111111111111111 refs/heads/drill/x 0000000000000000000000000000000000000000" \
  | "$(git -C <repo> rev-parse --path-format=absolute --git-path hooks)/pre-push" origin url; echo "exit=$?"
```

2026-10-20 の実測(cwd = ホーム `/Users/narisawaren`、使い捨てリポジトリ `<scratchpad>/hookproof/repo` に上の手順で入れた。
4 リポジトリへの実導入は別途。相対パス版が同じ cwd で偽の「未導入」になることも同時に確認):
```
cwd=/Users/narisawaren
relative : .git/hooks
absolute : <scratchpad>/hookproof/repo/.git/hooks
ok                                        ← test -x(絶対パス)
relative: NOT ok (cwd=/Users/narisawaren に .git/hooks は無い)   ← test -x(相対パス。直す前の書き方)
drill-guard: push を拒否しました(欠陥埋め込み訓練の守り)
  理由:
    - 枝名が drill/ で始まる(ローカル): refs/heads/drill/x
    - 枝名が drill/ で始まる(リモート先): refs/heads/drill/x
  (略)
exit=1
```

### 13-3. 既存のフックがあるとき(連結)

- 既存の `pre-push` を同じディレクトリの **`pre-push.local`** に改名してから上のコピーをする。drill-guard は通過後に `pre-push.local` を
  同じ引数・同じ標準入力で呼び、どちらかが非 0 なら push は止まる(自己テスト (d) で実測)。
- husky・lefthook のように `core.hooksPath` を使うリポジトリでは、`git rev-parse --path-format=absolute --git-path hooks` がそのディレクトリを返すので、上のコマンドのままそこに入る。
  そのツールが生成したフックが先にあれば、同じく `pre-push.local` に改名する。

### 13-4. 自己テスト

```bash
~/qa-standard/scripts/drill-guard.test.sh            # 使い捨てリポジトリ(リモートはローカルの bare)で 23 項目を実測
DRILL_GUARD_HOOK=<壊したコピー> ~/qa-standard/scripts/drill-guard.test.sh   # 壊して赤を見る用
```
確かめること: (a) マーカー付きコミットの push が拒否される(件名・本文・3 コミットの真ん中・新しい枝)、(b) `drill/` 枝が拒否される
(そのまま・別名へ・リモート側だけ drill/)、(c) 普通のコミット・枝・タグ・削除は通る(`drilling/` は通る・角括弧なしは通る)、
(d) `pre-push.local` の連結。フックを直したら 1 か所壊して赤を見てから出す(test-quality-standard §3-6)。

### 13-5. 守りの限界

- `git push --no-verify` はフックを飛ばす。**訓練中は使わない**(ルール)。守りは「うっかり」を止める網で、意図した突破は止められない。
- フックは手元のリポジトリにしか効かない。CI 側(qa-standard の classify)は `drill/` 枝を知らない。
  仮に突破して push しても、main でなければデプロイされない(デプロイは main の先頭だけ。qa-standard README)。

## 14. 黙って落とさない・限界

- **一時領域は消える**(訓練 #1・2026-10-20〜27 の実例): QA が日をまたぐと scratchpad/tmp の掃除で worktree・正解表が消える。worktree は `~/.qa-drills/`、正解表は `ledger/drills/` に最初から置く(§3・§9-1)。消えた場合でも、埋め込みは枝のコミットに残るので diff から復元できる(正解表の復元版にはその旨を書く)。
- **認可マトリクスは読み取りの行だけでは書き込みの越境を拾えない**(訓練 #1 の `tenant-id-200`: WHERE 抜けの UPDATE は 110 行すべて緑のまま、saas-core の実打鍵で見つかった)。書き込み API のあとに他テナントの状態が不変であることを見る行を足す(daicho は flows の M28 候補)。

- 実施しなかった項目(時間上限・環境)は回す係が「未実施(理由)」と書き、採点係は `unperformed_items` に残す。
- 埋められなかった型(基盤に該当なし・適用できる箇所が無い)は `type_rotation.skipped` に理由つきで残す。
- 後始末の確認が取れていなければ `cleanup_verified: false` のまま台帳に残す。
- 枝名 `drill/` で回す係が訓練と気づき得る(§2)。気づいても件数・型は分からない。枝名を隠す案は、守り(§13)と引き換えになるので採らない。
- 訓練の DDP は仕込んだ欠陥に限った数字。本番の見逃しは `ledger/escaped.jsonl`(基準 §7)で別に数える。
- 数字で QA を評価するのは四半期の見直しの材料としてだけ。数字を上げるために埋め込みを易しくしない(§5-3 で裁量を無くしている理由)。

## 15. 出典

- 施策案 `~/yosage-webqa/docs/2026-10-20-qa-upgrade-proposal.md` §3 4-1・§6: [28] ISTQB CTAL-TM v3.0(DDP をテスト有効性の指標に)/
  [40] error seeding の定義・DeMillo ほか 1978(ミューテーションの原典)/ [46] DDP の式 / [30] arXiv 2510.11822(LLM 判定者の真陰性 25% 未満、minority-veto)/
  [18] Stripe 冪等リクエスト / [41] iOS の和暦設定と DateFormatter / [45] 数値入力欄の 10 倍バグ(当社記録)
- `qa-profile-standard.md` §2(`seeded-drill`)・§4(昇格・降格・強化)・§5(本番と共有環境の保護)・§7(指標)
- `test-quality-standard.md` §2(兆候 B2・B6・B7・B8)・§3-6(壊して赤を見る)・§4-2(変異プローブの演算子と worktree の作法)
- 当社の事故記録: `~/yosage-content/content-quality-standard.md` §6(発火しない検出器)、KAZOERU 境界値の是正(7337b86)、
  `~/.claude/projects/-Users-narisawaren/memory/` の feedback-timebomb・feedback-secret-output・feedback-numeric-input・feedback-float-boundary-compare

## 16. 改訂

- 2026-10-20 制定。初回(build の基準値)を 1 本回して手順が動くことを確かめてから常用する。
- 2026-10-20 レビュー反映: hooks の場所を絶対パスに(§3-5・§13-2・フック先頭コメント。相対パスだと cwd 次第で入らない)/ 役割分離は別セッションでなく
  別サブエージェント+ブリーフから正解表を除く(§2)/ 添字 0 始まりと候補列挙の機械化(§4・§5-3)/ 半分ルールとランダム相当の優先順位(§5-1)/
  型を取る件数と skipped の書き方(§5-2)/ `security-web` を ASVS 5.0 の現行 ID に(§4 #9・§6)/ `double-booking` は `saas-core`/T-6(§4 #12)/
  judge_level は `--base` 必須・メニュー出力を依頼文に添付・「引き下げではない」の言い直し(§6・§7)/ qa.config の場所と daicho の初回前準備(§6・§11)/
  qa-log・last-qa ref を動かさない指示と採点時の確認(§7・§8)/ 暫定・自社基準の明記(§5-4・§8)。
- 2026-10-27 訓練 #1(daicho・S2)の教訓を反映: worktree と正解表を一時領域に置かない(§3・§9-1・§10)、§14 に 2 件追記
