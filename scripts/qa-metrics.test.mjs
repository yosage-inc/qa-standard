#!/usr/bin/env node
/**
 * qa-metrics.test.mjs — qa-metrics.mjs の自己テスト(依存ゼロ)。
 *
 * 合成の qa-log.jsonl / escaped.jsonl を使い捨ての台帳ディレクトリに書き、
 * DDP・変更失敗率・不安定率・昇格/降格/頻度降格/強化の候補・欠損件数・期間絞り込み・引数エラーを確かめる。
 * 期待値は台帳の中身から手で数えた値(実装の式を写していない)。
 *
 *   node scripts/qa-metrics.test.mjs
 *   QA_METRICS=<別の qa-metrics.mjs> node scripts/qa-metrics.test.mjs   (壊した写しで赤を見るとき)
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const METRICS = process.env.QA_METRICS ? resolve(process.env.QA_METRICS) : join(HERE, "qa-metrics.mjs");
const root = mkdtempSync(join(tmpdir(), "qa-metrics-test-"));

let failed = 0;
let passed = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++; else failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      実際: ${JSON.stringify(actual)}\n      期待: ${JSON.stringify(expected)}`}`);
}
const approx = (v, d = 4) => (v === null ? null : Number(v.toFixed(d)));

function ledger(name, qaLines, escLines) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "qa-log.jsonl"), qaLines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n");
  if (escLines !== null) writeFileSync(join(dir, "escaped.jsonl"), escLines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n");
  return dir;
}
function run(args) {
  const r = spawnSync("node", [METRICS, ...args], { encoding: "utf8" });
  return r;
}
function metrics(args) {
  const out = execFileSync("node", [METRICS, ...args, "--format", "json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return JSON.parse(out);
}

const item = (id, result, minutes, findings, false_alarms, extra = {}) => ({ id, result, minutes, findings, false_alarms, ...extra });

try {
  // ---------- 台帳 A: 指標の本体 ----------
  // QA 7 行。旧様式 2 行(fail/warn のみ)、新様式 5 行(items つき)
  const A = ledger("A", [
    // 旧様式(phase / minutes / items 無し): QA で見つけた数 = fail + warn = 1 + 2 = 3
    { date: "2026-07-01", app: "x", level: "S2", commit: "aaaaaaa", result: "PASS", fail: 1, warn: 2, report: "r", note: "旧" },
    // 旧様式(items 無し。CONDITIONAL なのでリリース数には入らない)
    { date: "2026-07-02", app: "x", level: "S3", commit: "bbbbbbb", result: "CONDITIONAL", fail: 0, warn: 3, report: "r", note: "旧" },
    // 新様式。items: charter 3 件中 1 件誤検出(実 2)、a11y 2 件中 0(実 2)、旧欄 flaky=true(率には入らない)。build-test 120 本中 再実行で通った 1 本
    { date: "2026-08-01", app: "x", level: "S2", commit: "ccccccc", result: "PASS", fail: 0, warn: 2, phase: "launch", minutes: 50,
      items: [item("charter", "WARN", 25, 3, 1), item("a11y-web", "WARN", 5, 2, 0, { flaky: true }), item("half", "WARN", 5, 2, 1),
        item("build-test", "PASS", 5, 0, 0, { flaky_tests: 1, tests_total: 120 })] },
    // 新様式。charter 誤検出 0(実 1)、a11y 2 件中 2 件誤検出(実 0)、fixed-ui SKIP。build-test 120 本中 0 本
    { date: "2026-08-15", app: "x", level: "S2", commit: "ddddddd", result: "PASS", fail: 0, warn: 1, phase: "launch", minutes: 40,
      items: [item("charter", "WARN", 25, 1, 0), item("a11y-web", "WARN", 5, 2, 2), item("fixed-ui-tests", "SKIP", 0, 0, 0), item("half", "WARN", 5, 2, 1),
        item("build-test", "PASS", 5, 0, 0, { flaky_tests: 0, tests_total: 120 })] },
    // 新様式。charter 0 件、a11y 3 件中 2 件誤検出(実 1)= 2 回連続 50% 超。build-test 130 本中 1 本
    { date: "2026-09-01", app: "x", level: "S2", commit: "eeeeeee", result: "PASS", fail: 0, warn: 1, phase: "launch", minutes: 30,
      items: [item("charter", "PASS", 20, 0, 0), item("a11y-web", "WARN", 5, 3, 2), item("two-runs", "PASS", 5, 0, 0),
        item("build-test", "PASS", 6, 0, 0, { flaky_tests: 1, tests_total: 130 })] },
    // 新様式。同じ commit で 2 回目(リリース数では 1 つに数える)。APPROVED
    { date: "2026-09-02", app: "x", level: "S2", commit: "eeeeeee", result: "APPROVED", fail: 0, warn: 0, phase: "launch", minutes: 10,
      items: [item("charter", "PASS", 10, 0, 0), item("two-runs", "PASS", 5, 0, 0)] },
    // 新様式。FAIL なのでリリース数には入らない。items の欄に欠損(minutes 無し・false_alarms 無し)。build-test は flaky_tests / tests_total 無し(欠損)
    { date: "2026-09-10", app: "y", level: "S3", commit: "fffffff", result: "FAIL", fail: 1, warn: 0, phase: "build", minutes: 70,
      items: [{ id: "mutation-probe", result: "FAIL", findings: 1 }, { id: "charter", result: "PASS", minutes: 20, findings: 0, false_alarms: 0 },
        item("build-test", "PASS", 5, 0, 0)] },
    // JSON として読めない行(落とさず数える)
    "{ this is not json",
  ], [
    // 漏れ 5 件:
    //   ccccccc に charter で拾えたはず(hotfix)。同じリリースを 40 桁で書いた 2 件目(hotfix)→ 変更失敗率では 1 つのリリースに畳む
    //   eeeeeee は該当なし(hotfix 無し)。zzzzzzz は qa-log に無い commit(hotfix 欄も無い)→ 率に入らない
    //   bbbbbbb は qa-log にあるが CONDITIONAL(リリースに数えない)の commit(hotfix)→ 率に入らず別出し
    { date: "2026-08-10", app: "x", found_by: "レン", release_commit: "ccccccc", release_level: "S2", should_have_caught: "charter", type: "表示", severity: "Minor", hotfix: true, fixed_commit: "c1c1c1c", note: "" },
    { date: "2026-08-12", app: "x", found_by: "レン", release_commit: "cccccccccccccccccccccccccccccccccccccccc", release_level: "S2", should_have_caught: "charter", type: "表示", severity: "Minor", hotfix: true, fixed_commit: "c2c2c2c", note: "40 桁" },
    { date: "2026-09-05", app: "x", found_by: "利用者", release_commit: "eeeeeee", release_level: "S2", should_have_caught: "該当なし", type: "仕様", severity: "Minor", hotfix: false, fixed_commit: null, note: "" },
    { date: "2026-09-20", app: "y", found_by: "ロビ", release_commit: "zzzzzzz", release_level: "S1", should_have_caught: "dep-alerts", type: "依存", severity: "Major", fixed_commit: null, note: "hotfix 欄なし" },
    { date: "2026-07-10", app: "x", found_by: "レン", release_commit: "bbbbbbb", release_level: "S3", should_have_caught: "該当なし", type: "仕様", severity: "Minor", hotfix: true, fixed_commit: null, note: "CONDITIONAL のまま出た" },
  ]);
  const mA = metrics(["--ledger", A]);

  // 1. QA 件数(読めない行は数えない。7 行)
  check("件数: 合計・レベル別・結果別", [mA.counts.total, mA.counts.by_level, mA.counts.by_result],
    [7, { S2: 5, S3: 2 }, { APPROVED: 1, CONDITIONAL: 1, FAIL: 1, PASS: 4 }]);

  // 2. DDP: QA で見つけた数 = 旧様式 (1+2)+(0+3)=6、items は行ごとに 08-01: 2+2+1+0=5 / 08-15: 1+0+0+1+0=2 / 09-01: 0+1+0+0=1 / 09-02: 0 / 09-10: 1(false_alarms 欠損は 0 扱い)+0+0=1 → 9。
  //    合計 15。漏れ 5 → 15/20 = 0.75
  check("DDP = 15 ÷ (15 + 5)", [mA.ddp.found_by_qa, mA.ddp.found_from_legacy_rows, mA.ddp.found_from_items, mA.ddp.escaped, approx(mA.ddp.value)],
    [15, 6, 9, 5, 0.75]);

  // 3. 変更失敗率: リリース = PASS/APPROVED の (app,commit) = x@aaaaaaa, x@ccccccc, x@ddddddd, x@eeeeeee = 4。
  //    拾えたはずの漏れがあったリリース = ccccccc だけ(40 桁の 2 件目は同じリリースに畳む。zzzzzzz は qa-log に無いので入らない)= 1 → 25%。
  //    hotfix = ccccccc だけ(bbbbbbb は CONDITIONAL でリリースに無いので入らない)= 1 → 25%
  check("変更失敗率 (a) 1/4 (b) 1/4(40 桁は同じリリースに畳む・分母に無い漏れは入らない)", [mA.change_failure.releases, mA.change_failure.caughtable_releases, approx(mA.change_failure.caughtable_rate),
    mA.change_failure.hotfix_releases, approx(mA.change_failure.hotfix_rate)], [4, 1, 0.25, 1, 0.25]);
  // 分母に無い漏れは率に入れず別出し: zzzzzzz(qa-log に無い)・bbbbbbb(PASS/APPROVED でない)の 2 件。理由つき
  check("分母に無い漏れ = zzzzzzz(qa-log に無い)と bbbbbbb(PASS/APPROVED でない)を別出し", [mA.change_failure.excluded_escaped,
    mA.escaped.not_in_releases.map((e) => [e.release_commit, e.hotfix, e.reason.includes("qa-log に無い"), e.reason.includes("PASS / APPROVED でない")])],
    [2, [["bbbbbbb", true, false, true], ["zzzzzzz", false, true, false]]]);   // escaped は日付順(07-10 の bbbbbbb が先)

  // 4. 不安定率: build-test 4 回(08-01・08-15・09-01・09-10)のうち flaky_tests / tests_total の記録があるのは 3 回。
  //    Σ flaky_tests = 1+0+1 = 2、Σ tests_total = 120+120+130 = 370 → 2/370 = 0.0054。旧欄 flaky=true の項目 1(率には入らない)
  check("不安定率 2/370(build-test 4 回・記録あり 3 回・旧欄 flaky は参考のみ)", [mA.flaky.build_test_runs, mA.flaky.build_test_with_record, mA.flaky.tests_total, mA.flaky.flaky_tests, approx(mA.flaky.rate), mA.flaky.legacy_flag_items],
    [4, 3, 370, 2, 0.0054, 1]);
  // items 総数は 18 個(4+5+4+2+3)。build-test 以外の flaky_tests は数えない
  check("items 総数 18・build-test 以外に flaky_tests を書いても分母に入らない", [mA.flaky.items_total, mA.items.find((i) => i.id === "a11y-web").tests_total], [18, 0]);

  // 5. 項目ごと: charter 5 回(全部 SKIP 以外)、所要 (25+25+20+10+20)/5 = 20、検出 4、誤検出 1
  const charter = mA.items.find((i) => i.id === "charter");
  check("項目: charter の回数・平均所要・検出・誤検出", [charter.runs, charter.executed, approx(charter.avg_minutes), charter.findings, charter.false_alarms, approx(charter.false_alarm_rate)],
    [5, 5, 20, 4, 1, 0.25]);
  const fixed = mA.items.find((i) => i.id === "fixed-ui-tests");
  check("項目: SKIP は実施回数に入るが SKIP 以外には入らない", [fixed.runs, fixed.executed, fixed.by_result], [1, 0, { SKIP: 1 }]);

  // 6. 候補(--menu 無しなので status による絞り込みは無い)
  // 昇格: charter の直近 3 回(09-10, 09-02, 09-01)は誤検出 0 → 候補。build-test も直近 3 回 誤検出 0 → 候補。a11y-web の直近 3 回は誤検出あり → 候補でない。
  //       two-runs は誤検出 0 だが 2 回しか無い(境界: 3 回に 1 回足りない)→ 候補でない
  check("昇格候補 = build-test と charter(2 回しか無い two-runs は入らない)", mA.candidates.promote.map((c) => c.id), ["build-test", "charter"]);
  // 降格: a11y-web は 08-15(2/2) と 09-01(2/3) が 50% 超で連続 → 候補。half は 2 回連続ちょうど 50%(1/2)なので「超」でない → 候補でない
  check("降格候補 = a11y-web だけ(ちょうど 50% の half は入らない)", mA.candidates.demote.map((c) => [c.id, c.runs]), [["a11y-web", ["2026-08-15", "2026-09-01"]]]);
  // 頻度降格: 8 回に届く項目が無い → 無し
  check("頻度降格候補 = なし(8 回未満)", mA.candidates.frequency_down, []);
  // 強化: charter(ccccccc の漏れ 2 件)と dep-alerts(zzzzzzz)。該当なしは入らない
  check("強化候補 = charter(2 件)と dep-alerts(1 件)", mA.candidates.reinforce.map((c) => [c.id, c.escaped.length]), [["charter", 2], ["dep-alerts", 1]]);
  // 判定不能: mutation-probe は 1 回なので何も出ない(欠損があっても 3 回に届かない)
  check("判定できなかったもの = なし", mA.candidates.undeterminable, []);

  // 7. 欠損件数
  check("欠損: 旧様式 2・読めない行 1・items 欄の欠損・escaped の hotfix 無し 1・build-test の flaky 欄無し 1・矛盾 0", [
    mA.missing.rows_legacy, mA.missing.rows_missing_items, mA.missing.unparsable_qa_log, mA.unparsable_lines.qa_log.map((u) => u.line),
    mA.missing.items_missing_minutes, mA.missing.items_missing_false_alarms, mA.missing.escaped_missing_hotfix,
    mA.missing.build_test_missing_flaky_fields, mA.missing.items_inconsistent,
  ], [2, 2, 1, [8], 1, 1, 1, 1, 0]);
  check("注意: release_commit が qa-log に無い漏れ = zzzzzzz", mA.escaped.not_in_qa_log.map((e) => e.release_commit), ["zzzzzzz"]);

  // 8. 期間の絞り込み(--since / --until)
  const mSince = metrics(["--ledger", A, "--since", "2026-09-01", "--until", "2026-09-30"]);
  // 9 月の QA は 09-01(1)・09-02(0)・09-10(1)の 3 行で見つけた数 2、漏れは 09-05・09-20 の 2 件 → 2/4
  check("期間 9 月: QA 3 件・漏れ 2 件・DDP = 2/(2+2)", [mSince.counts.total, mSince.escaped.total, mSince.ddp.found_by_qa, approx(mSince.ddp.value)], [3, 2, 2, 0.5]);

  // ---------- 台帳 B: 頻度降格・--menu・escaped 無し ----------
  // slow-item: 9 回とも検出 0・所要 12 分(平均 12 > 10)→ 頻度降格候補。fast-item: 検出 0 だが 8 分 → 候補でない。
  // ten-item: 9 回 検出 0・所要ちょうど 10 分(境界: 基準 §4 は「10 分超」)→ 頻度降格候補でない(昇格候補には出る)。
  // quiet-item: 8 回 検出 0・所要 15 分だが menu で quarterly → 候補でない。fail-item: 誤検出 0 が 3 回だが menu で status=fail → 昇格候補でない。
  // record-item: 誤検出 0・検出 0・15 分だが menu で status=record(記録の項目)→ 昇格候補にも頻度降格候補にも出ない。
  // promo-item: status=promoting・誤検出 0 → 昇格候補に出る。
  // seven-item: 検出 0・12 分だが 7 回しか無い(境界: 8 回に 1 回足りない)→ 頻度降格候補でない。menu に無いので昇格候補にも出さず「メニューに無い」に出る
  const bRows = [];
  for (let i = 1; i <= 9; i++) {
    const items = [item("slow-item", "PASS", 12, 0, 0), item("fast-item", "PASS", 8, 0, 0), item("ten-item", "PASS", 10, 0, 0), item("quiet-item", "PASS", 15, 0, 0),
      item("fail-item", "PASS", 3, 0, 0), item("record-item", "PASS", 15, 0, 0), item("promo-item", "PASS", 3, 0, 0)];
    if (i <= 7) items.push(item("seven-item", "PASS", 12, 0, 0));
    bRows.push({ date: `2026-07-${String(i).padStart(2, "0")}`, app: "z", level: "M2", commit: `b${i}00000`, result: "PASS", fail: 0, warn: 0, phase: "launch", minutes: 40, items });
  }
  const B = ledger("B", bRows, null);  // escaped.jsonl を作らない
  writeFileSync(join(root, "menu.json"), JSON.stringify({ items: [
    { id: "slow-item", status: "warn", frequency: "every" }, { id: "fast-item", status: "warn", frequency: "every" }, { id: "ten-item", status: "warn", frequency: "every" },
    { id: "quiet-item", status: "warn", frequency: "quarterly" }, { id: "fail-item", status: "fail", frequency: "every" },
    { id: "record-item", status: "record", frequency: "every" }, { id: "promo-item", status: "promoting", frequency: "every" },
  ] }));
  const mB = metrics(["--ledger", B, "--menu", join(root, "menu.json")]);
  check("頻度降格候補 = slow-item だけ(7 回の seven-item・8 分の fast-item・ちょうど 10 分の ten-item・quarterly の quiet-item・record の record-item は入らない)",
    mB.candidates.frequency_down.map((c) => [c.id, approx(c.avg_minutes)]), [["slow-item", 12]]);
  check("--menu: 昇格候補は warn / promoting だけ(fail の fail-item・record の record-item・メニューに無い seven-item は出ない)",
    mB.candidates.promote.map((c) => c.id), ["fast-item", "promo-item", "quiet-item", "slow-item", "ten-item"]);
  check("--menu: メニューに無い id は別枠に出る(黙って落とさない)", mB.candidates.not_in_menu.map((c) => [c.id, c.runs]), [["seven-item", 7]]);
  check("escaped.jsonl が無い: DDP・変更失敗率は算出不可で、無いことを明示", [mB.ddp.value, mB.change_failure.hotfix_rate, mB.missing.escaped_file_missing.length], [null, null, 1]);
  // --menu 無しなら status の絞り込みは無く、record-item も fail-item も seven-item も昇格候補に出る(status が分からないため)
  const mBnoMenu = metrics(["--ledger", B]);
  check("--menu 無し: status の絞り込みは無い", [mBnoMenu.candidates.promote.length, mBnoMenu.candidates.not_in_menu.length], [8, 0]);

  // 欠損で判定できないもの: 8 回あるが minutes が全部無い
  const C = ledger("C", Array.from({ length: 8 }, (_, i) => ({ date: `2026-08-${String(i + 1).padStart(2, "0")}`, app: "c", level: "S2", commit: `c${i}00000`, result: "PASS", fail: 0, warn: 0, phase: "launch", minutes: 30,
    items: [{ id: "no-minutes", result: "PASS", findings: 0, false_alarms: 0 }] })), []);
  const mC = metrics(["--ledger", C]);
  check("判定できなかったもの: minutes が全部欠損なら頻度降格を判定しない", mC.candidates.undeterminable.map((u) => [u.id, u.rule]), [["no-minutes", "frequency_down"]]);
  check("escaped が 0 件のときは DDP に注記", typeof mC.ddp.note === "string" && mC.ddp.note.includes("0 件"), true);
  check("build-test の items が無ければ不安定率は算出不可で、無いことを明示", [mC.flaky.rate, typeof mC.flaky.note === "string" && mC.flaky.note.includes("build-test")], [null, true]);

  // ---------- 台帳 D: 記録の矛盾(false_alarms > findings)----------
  // odd-item: 3 回のうち 1 回が findings 1・false_alarms 3(矛盾)。件数が出て、候補の判定はしない(undeterminable)。黙って 0 に丸めない
  const D = ledger("D", [
    { date: "2026-08-01", app: "d", level: "S2", commit: "d100000", result: "PASS", fail: 0, warn: 0, phase: "launch", minutes: 30, items: [item("odd-item", "PASS", 5, 0, 0)] },
    { date: "2026-08-02", app: "d", level: "S2", commit: "d200000", result: "PASS", fail: 0, warn: 0, phase: "launch", minutes: 30, items: [item("odd-item", "WARN", 5, 1, 3)] },
    { date: "2026-08-03", app: "d", level: "S2", commit: "d300000", result: "PASS", fail: 0, warn: 0, phase: "launch", minutes: 30, items: [item("odd-item", "PASS", 5, 0, 0)] },
  ], []);
  const mD = metrics(["--ledger", D]);
  check("矛盾(false_alarms > findings)は件数が出て、その項目は候補でなく判定不能に回る", [mD.missing.items_inconsistent, mD.items.find((i) => i.id === "odd-item").inconsistent,
    mD.candidates.promote.map((c) => c.id), mD.candidates.undeterminable.map((u) => [u.id, u.rule])], [1, 1, [], [["odd-item", "inconsistent"]]]);
  check("md 出力に矛盾の件数が出る", run(["--ledger", D]).stdout.includes("記録の矛盾(false_alarms > findings): 1 件"), true);

  // 複数台帳の合算
  const mAB = metrics(["--ledger", A, "--ledger", B]);
  check("複数 --ledger は合算(7 + 9 件)", [mAB.counts.total, mAB.sources.length], [16, 2]);

  // 期間指定: 分母は期間内のリリースだけ。期間外のリリースの漏れは率に入れず別出し
  // 8 月のリリース = x@ccccccc, x@ddddddd = 2。8 月の漏れ = 08-10・08-12(どちらも ccccccc)→ (a) 1/2 (b) 1/2、別出し 0
  const mAug = metrics(["--ledger", A, "--since", "2026-08-01", "--until", "2026-08-31"]);
  check("期間 8 月: 分母 2・拾えたはず 1・hotfix 1・別出し 0", [mAug.change_failure.releases, mAug.change_failure.caughtable_releases, mAug.change_failure.hotfix_releases, mAug.change_failure.excluded_escaped], [2, 1, 1, 0]);
  // 9 月のリリース = x@eeeeeee = 1。漏れ 09-05(eeeeeee・該当なし)・09-20(zzzzzzz・qa-log に無い)→ (a) 0/1、別出し 1
  const mSep = metrics(["--ledger", A, "--since", "2026-09-01", "--until", "2026-09-30"]);
  check("期間 9 月: 分母 1・(a) 0・別出し 1", [mSep.change_failure.releases, mSep.change_failure.caughtable_releases, mSep.change_failure.excluded_escaped], [1, 0, 1]);
  // 8/5〜8/12 のリリースは無い(分母 0)。漏れ 08-10・08-12 は ccccccc(08-01 のリリース=期間外)→ 率に入れず「期間外のリリース」として別出し 2
  const mGap = metrics(["--ledger", A, "--since", "2026-08-05", "--until", "2026-08-12"]);
  check("期間 8/5〜8/12: 分母 0・期間外のリリースの漏れ 2 を別出し", [mGap.change_failure.releases, mGap.change_failure.caughtable_rate, mGap.escaped.not_in_releases.map((e) => e.reason)], [0, null, ["期間外のリリース", "期間外のリリース"]]);

  // ---------- 引数エラー(黙って既定にしない) ----------
  check("--ledger 無しは終了コード 2", run([]).status, 2);
  check("日付の形が違えば終了コード 2", run(["--ledger", A, "--since", "2026/09/01"]).status, 2);
  check("存在しない日付(2026-02-30)は終了コード 2", run(["--ledger", A, "--since", "2026-02-30"]).status, 2);
  check("--format が md/json 以外は終了コード 2", run(["--ledger", A, "--format", "csv"]).status, 2);
  check("qa-log.jsonl が無い台帳は終了コード 2", run(["--ledger", join(root, "nope")]).status, 2);
  check("--menu が無ければ終了コード 2", run(["--ledger", A, "--menu", join(root, "no-menu.json")]).status, 2);

  // md 出力が主要な見出しと「書き換えない」を含む
  const md = run(["--ledger", A]).stdout;
  check("md 出力に候補の節と「書き換えていない」がある", ["## 7. 昇格", "qa-menu.json は書き換えていない", "数字は目標にしない"].every((s) => md.includes(s)), true);
  check("md 出力に不安定率の新しい式と率に入れなかった漏れが出る", ["Σ flaky_tests ÷ Σ tests_total", "2 ÷ 370", "変更失敗率に入れなかった漏れ 2 件", "bbbbbbb"].every((s) => md.includes(s)), true);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n${failed === 0 ? "ALL PASS" : "FAILED"}: ${passed} 件 PASS / ${failed} 件 FAIL`);
process.exit(failed === 0 ? 0 : 1);
