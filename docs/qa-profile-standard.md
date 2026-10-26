# QAプロファイル基準 — 開発フェーズ×規模で「必要最低限」を決める(過剰品質ガード)

制定: 2026-10-20(レン指示「開発フェーズや規模に応じて必要最低限のテストレベルと内容を判断できる仕組みを作り、
リスクの抑え方も取り入れたうえで QA エージェントを更新する」)。
対象: `~/yosage-webqa/`(S0-S3)と `~/yosage-appqa/`(M0-M3)。施策の出典と根拠は
`~/yosage-webqa/docs/2026-10-20-qa-upgrade-proposal.md`(§3 の番号 1-1〜4-3 をこの文書でも使う)。
テストそのものの質の基準は `test-quality-standard.md`。この文書は「どの検査を・いつ・どこまで」を決める。

## 0. 一言で

QA の重さは **レベル(変更の大きさ・危険度)× フェーズ(事業の段階)× 特性(課金・個人情報・テナント)** で
機械的に決める。人(ロビ)の気分で足さない・減らさない。検査は「所見」から始めて実績で昇格し、
効いていない検査は四半期の見直しで降格する。本番と共有環境には検査の副作用を及ぼさない。

## 1. 入力

### 1-1. レベル(変更の大きさ・危険度)
従来どおり `scripts/judge_level.sh` が S0-S3 / M0-M3 を決定論的に出す(変更なし。セキュリティ起因の最高レベルは引き下げ不可)。

### 1-2. フェーズ(事業の段階)— `qa.config` の `QA_PHASE`

| 値 | 意味 | QA の基本姿勢 |
|---|---|---|
| `proto` | 触れるフロント・試作。裏が仮で、外部の利用者がいない | **QA 対象外**(メニューは空。レンが触るための見本) |
| `build` | 本実装中。公開前で、利用者はレンと自社だけ | 必要最低限: 事故の型を潰す検査だけ。探索は 1 本・短く |
| `launch` | 公開済み。外部の利用者が 1 人以上(ストア公開・有料/無料契約) | 利用者の実害を防ぐ検査を足す(アクセシビリティ・ファジング・独立判定) |
| `scale` | 規模あり(暫定の自社基準: SaaS=有料テナント 10 以上 または月商 10 万円以上が 3 か月継続 / アプリ=月間利用者 1,000 人以上) | 定期の仕組み(性能・復元リハーサル・不安定率)を常用 |

- フェーズは `qa.config` に書く。**上げる**のはロビの判断で可(その場でレンに報告)。**下げる**のはレン承認(過少品質の側のガード)。
- 書いていないときは `launch` として扱う(安全側)。未知の値はエラーで止める(黙って既定にしない)。
- しきい値は暫定の自社基準。レンが変えられる(出典のある業界値ではない)。
- 2026-10-27 レン決定: みんなの台帳・albu・GENZO・コドモ声シール帳の 4 本はいずれも `build`(公開前)。公開したら `launch` に上げる。

### 1-3. 特性(扱うものの危なさ)— `qa.config` の `QA_TRAITS`(カンマ区切り)

| 値 | 意味 | 効くこと |
|---|---|---|
| `payments` | 課金・決済がある | 課金ライフサイクル・冪等性の検査が有効 |
| `pii` | 利用者の個人情報を預かる | 個人情報の検査・漏れた欠陥台帳の重要度↑ |
| `tenant` | 複数の店舗・組織のデータを同居させる | テナント分離・同時実行・独立 2 系統判定が有効 |
| `store` | アプリストアで配布する | 審査準備・アクセシビリティ申告の検査が有効 |
| `media` | 写真・録音など利用者の機微なファイルを扱う | 保存時保護(STORAGE)・権限の取り消し試験が有効 |

## 2. 出力: メニュー(レベル × フェーズ × 特性)

メニューは `node ~/qa-standard/scripts/qa-menu.mjs` が `qa-menu.json`(基盤ごと)から決定論的に出す(§8)。
**基本項目**(従来の qa-levels.md のレベル別メニュー)はレベルだけで決まり、フェーズでは減らさない。
**条件付き項目**は次の表のとおり。「—」は実施しない。先頭 2 行(`test-diff-review`・`mutation-probe`)は 2026-10-19 導入済みのため
`qa-menu.json` では基本項目(kind=base・レベルだけで決まる)として持つ。

| id | 項目(施策番号) | build | launch | scale | 扱い(導入時) |
|---|---|---|---|---|---|
| `test-diff-review` | テスト差分レビュー(基準 §4-1) | S1+/M1+ | 同 | 同 | 所見→昇格済み(2026-10-19 導入) |
| `mutation-probe` | 変異プローブ(基準 §4-2)最大 3 変異 | S2+/M2+ | 同 | 同(SaaS は 3-3 の月次が肩代わりしたら差分のみ) | High 判定可 |
| `charter` | 探索セッション(1-1) | S2+/M2+: 1 本 × 20 分 | 2 本 × 25 分 | 2 本 × 25 分 | 所見 |
| `design-table-check` | 手順書が設計表(1-3)から出ているかの照合 | S2+/M2+ | 同 | 同 | 所見 |
| `mobile-conditions` | モバイル固有条件(1-2) | M2+: 変更に関係する行だけ | M2+: 全行 | 同 | 所見→昇格 |
| `fixed-ui-tests` | 固定化した UI テストの実行(1-5。XCUITest / Playwright) | あれば M1+/S1+ | 必須 M1+/S1+ | 同 | FAIL 可 |
| `a11y-web` | 客側画面の axe 自動検査(2-6) | — | S2+: 所見 | S2+: 昇格後 FAIL 可 | 所見 |
| `api-fuzz` | API 仕様駆動ファジング(2-3)。**ローカル/ステージングのみ** | スキーマが入ったら S3 のみ | S2+ | S2+ | 所見→昇格 |
| `dual-judge` | 独立 2 系統判定(4-2)。テナント分離・保存データ保護の 2 領域だけ | — | S3/M3 | S3/M3 | 差し戻し条件 |
| `release-staging` | 段階配信・Version URL・巻き戻し手順(3-1) | — | 有効化(手順書どおり) | 必須 | 手順 |
| `restore-drill` | D1 復元リハーサル(3-1) | — | 四半期 | 四半期 | 手順 |
| `escaped-ledger` | 漏れた欠陥台帳(1-4) | 記録開始(内部で見つけた分) | 必須 | 必須 | 記録 |
| `seeded-drill` | **前提確認だけ**: 欠陥埋め込み訓練(4-1)の記録(`ledger/drills.jsonl`)があるか。訓練そのものはメインが別枠で回す(build=初回 1 回・launch 以降=四半期。`docs/seeded-defect-drill.md`) | S1+/M1+ で確認 | 同 | 同 | 前提確認 |
| `flaky-rate` | 不安定率の記録(4-3) | 記録 | 記録+四半期判断 | 同 | 記録 |
| `perf-web` | 主要画面の Lighthouse(SaaS) | — | S2+: 所見 | S2+ | 所見 |
| `threat-model` | 脅威モデル 15 分(新しいデータの流れ・権限・外部連携を足す変更で。「誰が・何を・どう悪用できるか」を 6 問で出す) | S2+ で該当時 | 同 | 同 | 所見 |
| `attacker-charter` | 攻撃者視点の探索(他人のデータ・権限昇格・大量取得・ID 推測・手順の飛ばし) | — | S2+: `charter` の 1 本をこれに充てる | 同 | 所見→昇格 |
| `prod-monitor` | **前提条件の確認だけ**: 本番の異常を見る日次手順(`~/yosage-infra/runbooks/prod-monitoring.md`)が回っているか。手順の中身と実施は運用側 | — | S2+ で確認(無ければ所見) | 同 | 前提確認 |
| `breach-runbook` | **前提条件の確認だけ**: 漏洩対応手順書(`~/yosage-legal/incident-response.md`。法務チェックの管轄)が存在し 1 年以内に見直されているか。中身・訓練は運用側 | — | S2+ で確認(無ければ所見) | 同 | 前提確認 |
| `pii-inventory` | 個人情報台帳(何を・どこに・誰が見られ・いつ消すか)が最新か | S3 で該当時 | S2+ | 同 | 所見 |
| `dep-alerts` | 依存の脆弱性通知が入っているか(Dependabot alerts / 週次 OSV) | S3 | S1+ で確認 | 同 | 所見 |

特性による絞り込み: `dual-judge` は `tenant` か `media` のときだけ。`api-fuzz` は Web のみ。`a11y-web` は客側画面があるときだけ。
`restore-drill` は D1 を使うときだけ。`mobile-conditions` は M のみ。
`threat-model`・`attacker-charter`・`prod-monitor`・`breach-runbook`・`pii-inventory` は `pii` か `tenant` のときだけ(Web)。`dep-alerts` は両方。

## 3. 時間の上限(QA 全体)

| レベル | build | launch / scale |
|---|---|---|
| S0 / M0 | 5 分(暫定・自社基準。条件付き項目は `escaped-ledger` だけ) | 同 |
| S1 / M1 | 15 分 | 15 分 |
| S2 | 60 分 | 90 分 |
| M2 | 45 分 | 60 分 |
| S3 / M3 | 全体の上限なし(項目ごとの上限のみ) | 同 |

- 上限に当たったら、残りの条件付き項目は **「未実施(時間上限)」と記録**し、所見に「落とした項目」を列挙する。基本項目は落とさない。
- 黙って削らない(当社ルール: 振り分けで値や失敗を黙って捨てない)。項目の時間は実測して台帳に残す(§7)。

## 4. 昇格・降格(誤報対策と重さの見直し)

- **新しい機械検査は「所見(WARN)」で始める**。レポートには載るが、それだけでは落とさない。
- **昇格**(所見 → FAIL 可): 直近 3 回の QA で誤検出 0(出た指摘が全部是正されたか、指摘 0)。
- **降格**(FAIL 可 → 所見、または設定の見直し): 誤検出率(指摘のうち是正不要だった割合)が 50% 超で 2 回連続。
- **頻度の降格**(毎回 → 四半期、または削除候補): 直近 8 回で検出 0 かつ平均所要 10 分超。
- **強化**: 漏れた欠陥(§7)が「その項目で拾えたはず」に紐づいたら、その項目は頻度を上げるか FAIL 可に戻す。
- 判断は四半期の見直し(`docs/qa-quarterly-review.md`、`scripts/qa-metrics.mjs` の出力で)。変更は `qa-menu.json` の `status`/`frequency` に日付つきで記録し、レンに報告する。
- しきい値(3 回・50%・8 回・10 分)は暫定の自社基準。

## 5. 本番と共有環境の保護(副作用を出さない)

- ファジング・負荷・変異プローブ・欠陥埋め込み訓練・攻撃者視点の探索は **本番にも共有の開発環境にも向けない**。ローカル(`wrangler dev` / シミュレータ)か、名前に `-staging` を含む専用 Worker だけ。
- Version URL(本番前の事前 URL)は読み取り系の確認に限る。書き込みの実打鍵はローカルで。
- 計測タグ(GA4・Clarity)は検査中に遮断する(既存ルール。GA4 ボット汚染の再発防止)。
- 訓練の枝は `drill/` で始め、コミットメッセージに `[seeded-defect]` を付ける。`scripts/drill-guard-pre-push.sh` を pre-push に入れて、そのマーカーの push を拒否する。訓練後は枝を消し、消したことを台帳に書く。
- 段階配信(3-1)は `launch` で有効化。DB スキーマ変更を伴うリリースでは新旧 2 版が同時に動くため、前方互換(旧版が新スキーマで動く)を S2+ の確認項目にする。

## 5-2. セキュリティ観点の補強(2026-10-20 レン指示「SaaS は情報漏洩が多い」)

**切り分け(2026-10-20 レン指摘)**: QA エージェントは「アプリ開発・リリース時の品質管理」の係。運用(本番監視・漏洩対応)は QA に織り込まず、QA は launch 以降の前提条件として存在を確認するだけにする。

いまの基盤が担保しているのは **リリース前のコードと設定**(S3 直行・認可マトリクス実打鍵・saas-core/security-web・SAST・秘密情報・依存脆弱性・週次 DAST)。
「情報漏洩を防ぐ」目的で足りないのは次の 4 つで、§2 の条件付き項目として組み込む:

| 穴 | 埋める項目 | 置き場所 |
|---|---|---|
| 本番の異常に気づく仕組みがない(**運用**) | 日次の確認手順は運用側 `~/yosage-infra/runbooks/prod-monitoring.md`(2026-10-27 レン決定: 既存の朝の日次チェック `yosage-daily-inquiry` に相乗り、`launch` 以上のアプリが出たら有効化)。QA は `prod-monitor` で「回っているか」を確認するだけ | `~/yosage-infra/` |
| 設計段階の脅威分析がない(開発・QA) | `threat-model`(15 分・6 問) | `~/yosage-webqa/templates/threat-model.md` |
| 漏洩時の対応手順がない(**運用・法務**。個人情報保護委員会への報告・本人通知の義務) | 手順書・連絡先・年 1 回の机上訓練は四半期の法務チェックの管轄 `~/yosage-legal/incident-response.md`。QA は `breach-runbook` で「存在し 1 年以内に見直されているか」を確認するだけ(ストア提出前のフィードバック窓口の確認と同じ型) | `~/yosage-legal/` |
| 攻撃者目線で外から叩く検査が弱い | `attacker-charter`・`api-fuzz`・`dual-judge`、`dep-alerts`(Dependabot alerts は 2026-10-27 レン決定で非公開 11 リポジトリに有効化済み・0円。自動修正 PR は Actions の分数を使うので入れない) | 各基盤の qa-levels / checklists |

## 6. ルールの肥大化を抑える

- 実行係(Sonnet)が読むのは **その回のメニュー出力と、各項目が指す節だけ**。基準文書の全文は読ませない。
- 基準は単一ソース(この文書・`test-quality-standard.md`・各基盤の `qa-levels.md`)。新しい文書を足す前に、既存に統合できないかを確かめる。
- エージェント定義は手順を列挙せず、「メニューに従う」「鉄の掟」「報告形式」だけにする。
- 1 回の QA で新しく足す項目は原則 1 つまで(同時に複数足すと、どれが誤報を出しているか分からない)。

## 7. 指標と台帳(測るが目標にしない)

- `ledger/qa-log.jsonl` に追加する項目: `phase`、`minutes`(QA 全体)、`items`(項目ごとの `id` / `result`(PASS・FAIL・WARN・SKIP)/ `minutes` / `findings` / `false_alarms`)。
- `ledger/escaped.jsonl`(漏れた欠陥): `date` / `app` / `found_by`(レン・利用者・ロビ)/ `release_commit` / `release_level` / `should_have_caught`(項目 id か「該当なし」)/ `type`(欠陥の型)/ `severity` / `fixed_commit` / `note`。
  レンが気づいた不具合は「仕様」と言い張らず全部入れる。
- 四半期に `scripts/qa-metrics.mjs` が出すもの: 欠陥検出率 DDP = QA で見つけた数 ÷(QA で見つけた数 + 漏れた数)、変更失敗率 = 即時対応が要ったリリース ÷ 全リリース、不安定率、項目ごとの所要時間と検出・誤検出。
- **数字は目標にしない**(網羅率と同じでゲーム化する)。傾向と見直しの材料にだけ使う。

## 8. `qa-menu.mjs` の仕様(実装はこの仕様に従う。2026-10-20 実装に合わせて改訂)

```
node ~/qa-standard/scripts/qa-menu.mjs --menu <基盤>/qa-menu.json --level S2 \
  [--config <repo>/qa.config] [--phase build] [--traits payments,tenant] [--format md|json]
```
- `--config` があれば `QA_PHASE` / `QA_TRAITS` を読む。`--phase` / `--traits` は明示指定が優先。
- フェーズ未指定は `launch`。未知のフェーズ・レベル・特性(`traits_known` に無い語)は終了コード 2 でエラー(黙って既定にしない)。
- `proto` はメニュー空+「QA 対象外」の 1 行。
- 項目の `status`(扱い)は 7 種: `fail`=[必須](FAIL 可)/ `warn`=[所見] / `promoting`=[昇格中] / `procedure`=[手順](親・運用が実施) /
  `record`=[記録] / `measure`=[測定] / `precheck`=[前提確認](存在・稼働を確かめるだけ)。`frequency` は `every` / `quarterly` / `first`。
- 出力(md): 基本項目 → 条件付き項目(実施順=安い・FAIL 可→記録→前提確認→脅威モデル→探索→ツール系)の順に、ラベル・時間上限・根拠の節(`doc`)・証跡の形(`evidence`)・`note` を 1 行ずつ。
  「対象外の条件付き項目(理由つき)」の節で黙って落とさない。末尾に全体の時間上限、項目上限の合計(`budget_minutes`)、機械可読の 1 行 `QA_MENU=<id,id,...>`。
- 出力(json): `{ level, phase, traits, cap_minutes, budget_minutes, items: [{ id, title, kind: base|conditional, status, minutes, count, doc, evidence, note, frequency, shares_minutes_with }], excluded: [{ id, reason }] }`。
- `qa-menu.json`(基盤ごと): `{ _comment, base, updated, levels, traits_known(必須), caps: { S0..S3: {build, launch, scale} }, items: [{ id, title, kind, levels, phases: { build: {...}|null, launch: {...}, scale: {...} }, traits: ["any"|...], status, since, frequency, doc, evidence, note, shares_minutes_with, history: [{date, change}] }] }`。
  `shares_minutes_with` は別項目の分数の中で行う印(例: `attacker-charter` は `charter` の 2 本のうち 1 本)。編集は四半期の見直し(§4)で行い、`history` に日付と理由を残す。
- 自己テスト `qa-menu.test.mjs`(`npm test` に含む): proto は空 / build の S2 に `a11y-web` が無い / launch の S2 にある / 特性で `dual-judge` が消える / 未知の値はエラー / 上限が表どおり / 両基盤の json が基準 §2 に適合。**壊して赤を見てからコミット**(`test-quality-standard.md` §3-6)。

## 9. 使い方(開発セッションから)

```bash
~/yosage-webqa/scripts/judge_level.sh --repo <アプリ>            # 1. レベル(従来どおり)
node ~/qa-standard/scripts/qa-menu.mjs --menu ~/yosage-webqa/qa-menu.json \
  --level S2 --config <アプリ>/qa.config                          # 2. メニュー(新)
# 3. エージェントにはメニュー出力を渡す(実行係は出力と、指された節だけ読む)
```

## 10. 改訂

- 2026-10-20 制定。初回の訓練(基準値)と試走で手順が動くことを確かめてから常用する。
