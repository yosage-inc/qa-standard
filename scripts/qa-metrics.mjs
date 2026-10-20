#!/usr/bin/env node
/**
 * qa-metrics.mjs — QA 台帳(qa-log.jsonl / escaped.jsonl)から四半期の指標を出す(依存ゼロ)。
 *
 * 使い方:
 *   node qa-metrics.mjs --ledger ~/yosage-webqa/ledger [--ledger ~/yosage-appqa/ledger]
 *                       [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--menu <基盤>/qa-menu.json] [--format md|json]
 *
 * 読むもの(--ledger は複数可。複数なら合算し、どこを読んだかを出す):
 *   <ledger>/qa-log.jsonl   1 QA = 1 行。date / app / level / commit / result / fail / warn / report / note に加え、
 *                           基準 §7 の phase / minutes / items[{ id, result, minutes, findings, false_alarms }]。
 *                           id が build-test の要素には flaky_tests(再実行で通った本数)/ tests_total(実行したテスト本数)を持たせる
 *   <ledger>/escaped.jsonl  漏れた欠陥。基準 §7 の date / app / found_by / release_commit / release_level /
 *                           should_have_caught / type / severity / fixed_commit / note に hotfix(true|false)を足した様式
 *
 * 出すもの(docs/qa-profile-standard.md §4・§7 / docs/qa-quarterly-review.md):
 *   1. QA 件数(レベル別・結果別・アプリ別)
 *   2. 欠陥検出率 DDP = QA で見つけた数 ÷(QA で見つけた数 + 漏れた数)
 *   3. 変更失敗率(2 本): (a) QA で拾えたはずの漏れがあったリリース ÷ 全リリース
 *                          (b) 即時対応(hotfix=true)が要ったリリース ÷ 全リリース
 *                          分子は分母(全リリース)に当たる (app, commit) だけを数える。同じリリースを 40 桁で書いても 1 つ。
 *                          分母に無い漏れ(qa-log に無い commit・PASS/APPROVED でない commit・期間外のリリース)は率に入れず別出し
 *   4. 不安定率 = Σ flaky_tests ÷ Σ tests_total(id が build-test の items。テスト実行 1 本あたりの率。
 *                 build_test.sh は再実行の記録をまだ出さないので(2026-10-20 時点)記録係が手で数えて書く前提)
 *   5. 項目ごとの実施回数・平均所要・検出・誤検出
 *   6. 昇格・降格・頻度降格・強化の候補(「提案」だけ。qa-menu.json は書き換えない)
 *   7. 欠損・注意(古い行・読めない行・足りない欄は落とさず件数を出す)
 *
 * 決めごと(黙って落とさない):
 *   - phase / minutes / items が無い行は「旧様式」として数える。件数(1.)には入れるが、項目ごとの集計には入らない
 *   - JSON として読めない行は件数と行番号を出す
 *   - --since / --until があるとき date の無い行は期間を判定できないので除外し、その件数を出す
 *   - escaped の release_commit が qa-log に無ければ「QA を通さずに出た可能性」として挙げる
 *   - 「全リリース」の台帳は無いので、暫定の近似 = qa-log の result が PASS / APPROVED の行の (app, commit) の数
 *   - false_alarms > findings の項目(記録の矛盾)は件数を出し、その項目の候補判定はしない(判定できなかったものに出す)
 *   - --menu があるときの昇格・頻度降格の候補は status が warn / promoting の項目だけ(record・measure・procedure・fail は出さない)。
 *     メニューに無い id は「メニューに無い」として別枠で出す
 *
 * しきい値(基準 §4。暫定の自社基準、出典のある業界値ではない):
 *   昇格候補        直近 3 回(SKIP を除く)の誤検出(false_alarms)が全部 0
 *   降格候補        誤検出率(false_alarms ÷ findings)が 50% 超の回が 2 回連続
 *   頻度降格候補    直近 8 回(SKIP を除く)の検出(findings)が全部 0 かつ平均所要 10 分超
 *   強化候補        escaped の should_have_caught にその項目 id がある(基準 §4「強化」)
 *
 * 終了コード: 0 = 出力した / 2 = 引数・台帳の誤り(黙って既定にしない)
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";

// ---------- しきい値(暫定の自社基準) ----------
export const RULES = {
  promote: { runs: 3 },                     // 直近 3 回の誤検出 0
  demote: { rate: 0.5, consecutive: 2 },    // 誤検出率 50% 超が 2 回連続
  freq: { runs: 8, avgMinutes: 10 },        // 直近 8 回で検出 0 かつ平均 10 分超
};
const RELEASED_RESULTS = new Set(["PASS", "APPROVED"]);
const NOT_APPLICABLE = "該当なし";
const EXECUTED = (r) => r.result !== "SKIP";
const BUILD_TEST_ID = "build-test";
// --menu があるとき、昇格・頻度降格の候補に出す status(qa-menu.mjs の STATUSES のうち検査として発火する 2 つ)
const CANDIDATE_STATUSES = new Set(["warn", "promoting"]);

// ---------- 引数 ----------
function parseArgs(argv) {
  const out = { ledgers: [], since: null, until: null, menu: null, format: "md" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} に値がありません`);
      i++;
      return v;
    };
    if (a === "--ledger") out.ledgers.push(val());
    else if (a === "--since") out.since = val();
    else if (a === "--until") out.until = val();
    else if (a === "--menu") out.menu = val();
    else if (a === "--format") out.format = val();
    else if (a === "--help" || a === "-h") { out.help = true; }
    else throw new Error(`不明な引数: ${a}`);
  }
  if (out.help) return out;
  if (out.ledgers.length === 0) throw new Error("--ledger <基盤>/ledger を 1 つ以上指定してください");
  for (const d of [out.since, out.until]) {
    if (d !== null && !isIsoDate(d)) throw new Error(`日付は YYYY-MM-DD で: ${d}`);
  }
  if (out.since && out.until && out.since > out.until) throw new Error("--since が --until より後です");
  if (!["md", "json"].includes(out.format)) throw new Error(`--format は md か json: ${out.format}`);
  return out;
}

function isIsoDate(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// ---------- 台帳の読み込み ----------
function readJsonl(path) {
  if (!existsSync(path)) return { exists: false, rows: [], unparsable: [] };
  const rows = [];
  const unparsable = [];
  const lines = readFileSync(path, "utf8").split("\n");
  lines.forEach((text, idx) => {
    if (text.trim() === "") return;
    try {
      const data = JSON.parse(text);
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("オブジェクトでない");
      rows.push({ line: idx + 1, data });
    } catch {
      unparsable.push({ line: idx + 1, text: text.slice(0, 60) });
    }
  });
  return { exists: true, rows, unparsable };
}

function readMenu(path) {
  if (!path) return null;
  const abs = resolve(path);
  if (!existsSync(abs)) throw new Error(`--menu が見つかりません: ${abs}`);
  let json;
  try { json = JSON.parse(readFileSync(abs, "utf8")); } catch (e) { throw new Error(`--menu を読めません: ${e.message}`); }
  const map = new Map();
  for (const it of json.items || []) if (it && it.id) map.set(it.id, { status: it.status ?? null, frequency: it.frequency ?? null });
  return { path: abs, items: map };
}

// ---------- 集計 ----------
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const normCommit = (c) => (typeof c === "string" ? c.trim().toLowerCase() : "");
const commitMatch = (a, b) => {
  if (!a || !b) return false;
  const n = Math.min(a.length, b.length);
  return n >= 7 && a.slice(0, n) === b.slice(0, n);
};
const pct = (num, den) => (den > 0 ? num / den : null);
const inc = (obj, key, by = 1) => { obj[key] = (obj[key] || 0) + by; };
const sortedObj = (obj) => Object.fromEntries(Object.entries(obj).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

export function computeMetrics({ ledgers, since = null, until = null, menu = null }) {
  const sources = [];
  const qaAll = [];
  const escAll = [];
  const unparsable = { qa_log: [], escaped: [] };
  const missingFiles = [];

  for (const dir of ledgers) {
    const abs = resolve(dir);
    const qa = readJsonl(join(abs, "qa-log.jsonl"));
    const esc = readJsonl(join(abs, "escaped.jsonl"));
    if (!qa.exists) throw new Error(`qa-log.jsonl が無い: ${join(abs, "qa-log.jsonl")}`);
    if (!esc.exists) missingFiles.push(join(abs, "escaped.jsonl"));
    sources.push({ ledger: abs, qa_log_lines: qa.rows.length + qa.unparsable.length, escaped_lines: esc.rows.length + esc.unparsable.length, escaped_exists: esc.exists });
    for (const r of qa.rows) qaAll.push({ ...r, ledger: abs });
    for (const r of esc.rows) escAll.push({ ...r, ledger: abs });
    unparsable.qa_log.push(...qa.unparsable.map((u) => ({ ...u, ledger: abs })));
    unparsable.escaped.push(...esc.unparsable.map((u) => ({ ...u, ledger: abs })));
  }

  // 期間
  const periodFilter = Boolean(since || until);
  const inPeriod = (d) => (!since || d >= since) && (!until || d <= until);
  const noDateExcluded = { qa_log: 0, escaped: 0 };
  const badDate = { qa_log: 0, escaped: 0 };
  const pick = (rows, kind) => rows.filter((r) => {
    const d = r.data.date;
    if (!isIsoDate(d)) {
      if (d !== undefined) badDate[kind]++;
      if (periodFilter) { noDateExcluded[kind]++; return false; }
      return true;
    }
    return inPeriod(d);
  });
  const qaRows = pick(qaAll, "qa_log");
  const escRows = pick(escAll, "escaped");
  // 時系列(date → 行番号)。date 無しは末尾
  const byTime = (a, b) => {
    const da = isIsoDate(a.data.date) ? a.data.date : "9999-99-99";
    const db = isIsoDate(b.data.date) ? b.data.date : "9999-99-99";
    if (da !== db) return da < db ? -1 : 1;
    return a.ledger === b.ledger ? a.line - b.line : a.ledger < b.ledger ? -1 : 1;
  };
  qaRows.sort(byTime);
  escRows.sort(byTime);

  // 1. QA 件数
  const counts = { total: qaRows.length, by_level: {}, by_result: {}, by_app: {}, by_level_result: {} };
  for (const { data } of qaRows) {
    const level = typeof data.level === "string" ? data.level : "(不明)";
    const result = typeof data.result === "string" ? data.result : "(不明)";
    const app = typeof data.app === "string" ? data.app : "(不明)";
    inc(counts.by_level, level); inc(counts.by_result, result); inc(counts.by_app, app);
    inc(counts.by_level_result, `${level}/${result}`);
  }
  for (const k of ["by_level", "by_result", "by_app", "by_level_result"]) counts[k] = sortedObj(counts[k]);

  // 旧様式・欠損
  const missing = {
    rows_legacy: 0, rows_missing_phase: 0, rows_missing_minutes: 0, rows_missing_items: 0,
    items_invalid: 0, items_missing_minutes: 0, items_missing_findings: 0, items_missing_false_alarms: 0,
    items_inconsistent: 0, build_test_missing_flaky_fields: 0,
    escaped_missing_hotfix: 0, escaped_missing_should_have_caught: 0, escaped_missing_fields: 0,
    unparsable_qa_log: unparsable.qa_log.length, unparsable_escaped: unparsable.escaped.length,
    no_date_excluded_qa_log: noDateExcluded.qa_log, no_date_excluded_escaped: noDateExcluded.escaped,
    bad_date_qa_log: badDate.qa_log, bad_date_escaped: badDate.escaped,
    escaped_file_missing: missingFiles,
  };

  // 2. QA で見つけた数 / 項目ごと / 不安定率 / リリース数
  let foundByQa = 0;
  let foundFromItems = 0;
  let foundFromLegacy = 0;
  const itemStats = new Map();  // id → stats
  let itemsTotal = 0;
  let itemsFlagged = 0;         // 旧欄 flaky: true の項目数(参考)
  let buildTestRuns = 0, buildTestWithRecord = 0, testsTotal = 0, flakyTests = 0;
  const releases = new Set();   // 期間内の全リリース(分母)
  const releasesAll = new Map(); // app@commit → { app, commit }(期間外も含む。漏れの突き合わせ用)
  const allCommits = qaAll.map((r) => normCommit(r.data.commit)).filter(Boolean);
  for (const { data } of qaAll) {
    if (typeof data.result === "string" && RELEASED_RESULTS.has(data.result) && normCommit(data.commit)) {
      const app = typeof data.app === "string" ? data.app : "?";
      releasesAll.set(`${app}@${normCommit(data.commit)}`, { app, commit: normCommit(data.commit) });
    }
  }
  let minutesSum = 0, minutesCount = 0;

  for (const row of qaRows) {
    const { data } = row;
    const hasPhase = typeof data.phase === "string";
    const hasMinutes = isNum(data.minutes);
    const hasItems = Array.isArray(data.items);
    if (!hasPhase) missing.rows_missing_phase++;
    if (!hasMinutes) missing.rows_missing_minutes++;
    if (!hasItems) missing.rows_missing_items++;
    if (!hasPhase || !hasMinutes || !hasItems) missing.rows_legacy++;
    if (hasMinutes) { minutesSum += data.minutes; minutesCount++; }
    if (typeof data.result === "string" && RELEASED_RESULTS.has(data.result) && normCommit(data.commit)) {
      releases.add(`${typeof data.app === "string" ? data.app : "?"}@${normCommit(data.commit)}`);
    }

    if (hasItems && data.items.length > 0) {
      let rowFound = 0;
      for (const it of data.items) {
        if (!it || typeof it !== "object" || typeof it.id !== "string" || typeof it.result !== "string") { missing.items_invalid++; continue; }
        itemsTotal++;
        if (it.flaky === true) itemsFlagged++;
        const f = isNum(it.findings) ? it.findings : null;
        const fa = isNum(it.false_alarms) ? it.false_alarms : null;
        const m = isNum(it.minutes) ? it.minutes : null;
        if (f === null) missing.items_missing_findings++;
        if (fa === null) missing.items_missing_false_alarms++;
        if (m === null) missing.items_missing_minutes++;
        const inconsistent = f !== null && fa !== null && fa > f;   // 誤検出が指摘数より多い=記録の矛盾
        if (inconsistent) missing.items_inconsistent++;
        rowFound += Math.max(0, (f ?? 0) - (fa ?? 0));
        // 不安定率(build-test の要素だけ。flaky_tests / tests_total)
        const ft = isNum(it.flaky_tests) ? it.flaky_tests : null;
        const tt = isNum(it.tests_total) ? it.tests_total : null;
        if (it.id === BUILD_TEST_ID && EXECUTED(it)) {
          buildTestRuns++;
          if (ft !== null && tt !== null) { buildTestWithRecord++; testsTotal += tt; flakyTests += ft; }
          else missing.build_test_missing_flaky_fields++;
        }
        if (!itemStats.has(it.id)) {
          itemStats.set(it.id, { id: it.id, runs: 0, executed: 0, by_result: {}, minutes_sum: 0, minutes_count: 0, findings: 0, false_alarms: 0,
            flaky_tests: 0, tests_total: 0, inconsistent: 0,
            missing_minutes: 0, missing_findings: 0, missing_false_alarms: 0, history: [] });
        }
        const s = itemStats.get(it.id);
        s.runs++;
        if (EXECUTED(it)) s.executed++;
        inc(s.by_result, it.result);
        if (m !== null) { s.minutes_sum += m; s.minutes_count++; } else s.missing_minutes++;
        if (f !== null) s.findings += f; else s.missing_findings++;
        if (fa !== null) s.false_alarms += fa; else s.missing_false_alarms++;
        if (ft !== null && tt !== null) { s.flaky_tests += ft; s.tests_total += tt; }
        if (inconsistent) s.inconsistent++;
        s.history.push({ date: isIsoDate(data.date) ? data.date : null, app: data.app ?? null, result: it.result, findings: f, false_alarms: fa, minutes: m, inconsistent });
      }
      foundFromItems += rowFound;
      foundByQa += rowFound;
    } else {
      const legacyFound = (isNum(data.fail) ? data.fail : 0) + (isNum(data.warn) ? data.warn : 0);
      foundFromLegacy += legacyFound;
      foundByQa += legacyFound;
    }
  }

  // 3. 漏れた欠陥
  const escaped = { total: escRows.length, caughtable: 0, not_applicable: 0, hotfix_true: 0, hotfix_false: 0,
    by_should_have_caught: {}, by_found_by: {}, by_severity: {}, by_app: {}, not_in_qa_log: [], not_in_releases: [] };
  const caughtableCommits = new Set();   // 分母(releases)に当たる app@commit だけ
  const hotfixCommits = new Set();
  const findRelease = (app, rc) => {
    if (!rc) return null;
    for (const r of releasesAll.values()) if (r.app === app && commitMatch(r.commit, rc)) return r;
    return null;
  };
  for (const row of escRows) {
    const { data } = row;
    for (const k of ["date", "app", "release_commit", "release_level", "type", "severity"]) if (data[k] === undefined) { missing.escaped_missing_fields++; break; }
    const shc = typeof data.should_have_caught === "string" && data.should_have_caught.trim() ? data.should_have_caught.trim() : null;
    if (shc === null) missing.escaped_missing_should_have_caught++;
    else if (shc === NOT_APPLICABLE) escaped.not_applicable++;
    else escaped.caughtable++;
    inc(escaped.by_should_have_caught, shc ?? "(欠損)");
    if (data.hotfix === true) escaped.hotfix_true++;
    else if (data.hotfix === false) escaped.hotfix_false++;
    else missing.escaped_missing_hotfix++;
    inc(escaped.by_found_by, typeof data.found_by === "string" ? data.found_by : "(欠損)");
    inc(escaped.by_severity, typeof data.severity === "string" ? data.severity : "(欠損)");
    inc(escaped.by_app, typeof data.app === "string" ? data.app : "(欠損)");
    const rc = normCommit(data.release_commit);
    const app = typeof data.app === "string" ? data.app : "?";
    const inQaLog = Boolean(rc) && allCommits.some((c) => commitMatch(c, rc));
    if (rc && !inQaLog) escaped.not_in_qa_log.push({ line: row.line, ledger: row.ledger, app: data.app ?? null, release_commit: data.release_commit });
    // 変更失敗率の分子: 分母(期間内の PASS/APPROVED の (app, commit))に当たるものだけ。40 桁と 7 桁は同じリリースに畳む
    const rel = findRelease(app, rc);
    const key = rel ? `${rel.app}@${rel.commit}` : null;
    if (key && releases.has(key)) {
      if (shc !== null && shc !== NOT_APPLICABLE) caughtableCommits.add(key);
      if (data.hotfix === true) hotfixCommits.add(key);
    } else {
      const why = !rc ? "release_commit が欠損" : !inQaLog ? "qa-log に無い(QA を通さずに出た可能性)"
        : !rel ? "qa-log にあるが PASS / APPROVED でない(条件付き・不合格のまま出た可能性。承認で出したなら APPROVED の行を足す)" : "期間外のリリース";
      escaped.not_in_releases.push({ line: row.line, ledger: row.ledger, app: data.app ?? null, release_commit: data.release_commit ?? null,
        caughtable: shc !== null && shc !== NOT_APPLICABLE, hotfix: data.hotfix === true, reason: why });
    }
  }
  for (const k of ["by_should_have_caught", "by_found_by", "by_severity", "by_app"]) escaped[k] = sortedObj(escaped[k]);

  const escapedKnown = missingFiles.length === 0;
  const ddp = {
    found_by_qa: foundByQa, found_from_items: foundFromItems, found_from_legacy_rows: foundFromLegacy,
    escaped: escaped.total, escaped_caughtable: escaped.caughtable,
    value: escapedKnown ? pct(foundByQa, foundByQa + escaped.total) : null,
    note: !escapedKnown ? "escaped.jsonl が無い台帳があるので算出不可"
      : escaped.total === 0 ? "漏れた欠陥の記録が 0 件。台帳の記録開始前の期間なら 100% に意味は無い" : null,
  };

  const changeFailure = {
    releases: releases.size,
    releases_note: "暫定の近似: qa-log の result が PASS / APPROVED の行の (app, commit) の数(リリース台帳が無いため)",
    caughtable_releases: caughtableCommits.size,
    caughtable_rate: escapedKnown ? pct(caughtableCommits.size, releases.size) : null,
    hotfix_releases: hotfixCommits.size,
    hotfix_rate: escapedKnown ? pct(hotfixCommits.size, releases.size) : null,
    excluded_escaped: escaped.not_in_releases.length,
    excluded_note: "分母に無い漏れ(qa-log に無い・PASS/APPROVED でない・期間外・release_commit 欠損)は率に入れず §6 に別出し",
    note: escapedKnown ? null : "escaped.jsonl が無い台帳があるので算出不可",
  };

  const flaky = {
    build_test_runs: buildTestRuns, build_test_with_record: buildTestWithRecord,
    tests_total: testsTotal, flaky_tests: flakyTests, rate: pct(flakyTests, testsTotal),
    items_total: itemsTotal, legacy_flag_items: itemsFlagged,
    note: buildTestRuns === 0 ? `id が ${BUILD_TEST_ID} の items が無い(不安定率は build-test の記録が始まってから)`
      : buildTestWithRecord < buildTestRuns ? `${BUILD_TEST_ID} ${buildTestRuns} 回のうち flaky_tests / tests_total の記録があるのは ${buildTestWithRecord} 回(build_test.sh は再実行の記録をまだ出さない。記録係が手で数える)` : null,
  };

  // 5. 項目ごと(時系列に並べ直す)
  const items = [...itemStats.values()].sort((a, b) => (a.id < b.id ? -1 : 1)).map((s) => ({
    id: s.id, runs: s.runs, executed: s.executed, by_result: sortedObj(s.by_result),
    avg_minutes: s.minutes_count > 0 ? s.minutes_sum / s.minutes_count : null, minutes_count: s.minutes_count,
    findings: s.findings, false_alarms: s.false_alarms, false_alarm_rate: pct(s.false_alarms, s.findings),
    flaky_tests: s.flaky_tests, tests_total: s.tests_total, inconsistent: s.inconsistent,
    missing: { minutes: s.missing_minutes, findings: s.missing_findings, false_alarms: s.missing_false_alarms },
    history: s.history,
    menu: menu ? (menu.items.get(s.id) ?? null) : null,
  }));

  // 6. 候補
  const candidates = { promote: [], demote: [], frequency_down: [], reinforce: [], undeterminable: [], not_in_menu: [] };
  for (const it of items) {
    const executed = it.history.filter(EXECUTED);
    const recent = [...executed].reverse();   // 直近が先頭
    const menuStatus = it.menu?.status ?? null;
    const menuFreq = it.menu?.frequency ?? null;

    // メニューに無い id は候補に出さず別枠(綴りの誤りか、メニューに足す前の項目)
    if (menu && !it.menu) {
      candidates.not_in_menu.push({ id: it.id, runs: it.runs, reason: "qa-menu.json に無い id(綴りの誤りか、メニューに足す前の項目)。候補には出さない" });
      continue;
    }
    // 記録の矛盾(false_alarms > findings)がある項目は候補の判定をしない
    if (it.inconsistent > 0) {
      candidates.undeterminable.push({ id: it.id, rule: "inconsistent", reason: `false_alarms > findings の回が ${it.inconsistent} 回ある(記録の矛盾。台帳を直してから判定)` });
      continue;
    }
    // --menu があるときは warn / promoting の項目だけ候補にする(fail は昇格済み、record / measure / procedure は検査でない)
    const candidateStatus = !menu || CANDIDATE_STATUSES.has(menuStatus);

    // 昇格候補: 直近 3 回の誤検出 0
    if (candidateStatus) {
      const win = recent.slice(0, RULES.promote.runs);
      if (win.length >= RULES.promote.runs) {
        if (win.some((h) => h.false_alarms === null)) {
          candidates.undeterminable.push({ id: it.id, rule: "promote", reason: `直近 ${RULES.promote.runs} 回に false_alarms の欠損がある` });
        } else if (win.every((h) => h.false_alarms === 0)) {
          candidates.promote.push({ id: it.id, status: menuStatus, runs: win.map((h) => h.date), findings: win.reduce((a, h) => a + (h.findings ?? 0), 0),
            reason: `直近 ${RULES.promote.runs} 回(${win.map((h) => h.date ?? "日付なし").join("・")})の誤検出 0` });
        }
      }
    }

    // 降格候補: 誤検出率 50% 超が 2 回連続(期間内のどこでも)
    for (let i = RULES.demote.consecutive - 1; i < executed.length; i++) {
      const win = executed.slice(i - RULES.demote.consecutive + 1, i + 1);
      const over = win.every((h) => h.findings !== null && h.false_alarms !== null && h.findings > 0 && h.false_alarms / h.findings > RULES.demote.rate);
      if (over) {
        candidates.demote.push({ id: it.id, status: menuStatus, runs: win.map((h) => h.date),
          rates: win.map((h) => h.false_alarms / h.findings),
          reason: `誤検出率 ${RULES.demote.rate * 100}% 超が ${RULES.demote.consecutive} 回連続(${win.map((h) => `${h.date ?? "日付なし"}: ${h.false_alarms}/${h.findings}`).join("・")})` });
        break;
      }
    }

    // 頻度降格候補: 直近 8 回で検出 0 かつ平均 10 分超
    if (candidateStatus && menuFreq !== "quarterly") {
      const win = recent.slice(0, RULES.freq.runs);
      if (win.length >= RULES.freq.runs) {
        if (win.some((h) => h.findings === null)) {
          candidates.undeterminable.push({ id: it.id, rule: "frequency_down", reason: `直近 ${RULES.freq.runs} 回に findings の欠損がある` });
        } else if (win.every((h) => h.findings === 0)) {
          const withMin = win.filter((h) => h.minutes !== null);
          if (withMin.length === 0) {
            candidates.undeterminable.push({ id: it.id, rule: "frequency_down", reason: `直近 ${RULES.freq.runs} 回の検出は 0 だが minutes が全部欠損で平均所要を出せない` });
          } else {
            const avg = withMin.reduce((a, h) => a + h.minutes, 0) / withMin.length;
            if (avg > RULES.freq.avgMinutes) {
              candidates.frequency_down.push({ id: it.id, frequency: menuFreq, avg_minutes: avg, minutes_known: withMin.length,
                reason: `直近 ${RULES.freq.runs} 回の検出 0 かつ平均所要 ${avg.toFixed(1)} 分(${withMin.length}/${win.length} 回に所要の記録)` });
            }
          }
        }
      }
    }
  }
  // 強化候補: 漏れた欠陥がその項目で拾えたはず
  const reinforceMap = new Map();
  for (const row of escRows) {
    const shc = typeof row.data.should_have_caught === "string" ? row.data.should_have_caught.trim() : "";
    if (!shc || shc === NOT_APPLICABLE) continue;
    if (!reinforceMap.has(shc)) reinforceMap.set(shc, []);
    reinforceMap.get(shc).push({ date: row.data.date ?? null, app: row.data.app ?? null, severity: row.data.severity ?? null, hotfix: row.data.hotfix ?? null, line: row.line });
  }
  for (const [id, rows] of [...reinforceMap.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    candidates.reinforce.push({ id, status: menu ? (menu.items.get(id)?.status ?? null) : null, in_menu: menu ? menu.items.has(id) : null, escaped: rows,
      reason: `漏れた欠陥 ${rows.length} 件がこの項目で拾えたはず → 頻度を上げるか FAIL 可に戻す(基準 §4「強化」)` });
  }

  return {
    generated: new Date().toISOString().slice(0, 10),
    period: { since, until },
    sources,
    menu: menu ? menu.path : null,
    rules: RULES,
    counts,
    minutes: { total_recorded_rows: minutesCount, avg_per_qa: minutesCount > 0 ? minutesSum / minutesCount : null },
    ddp,
    change_failure: changeFailure,
    flaky,
    items: items.map(({ history, ...rest }) => rest),
    escaped,
    candidates,
    missing,
    unparsable_lines: unparsable,
  };
}

// ---------- 出力(md) ----------
const fmtPct = (v) => (v === null || v === undefined ? "算出不可" : `${(v * 100).toFixed(1)}%`);
const fmtMin = (v) => (v === null || v === undefined ? "—" : `${v.toFixed(1)} 分`);
const kv = (obj) => Object.entries(obj).map(([k, v]) => `${k} ${v}`).join(" / ") || "(なし)";

export function renderMd(m) {
  const L = [];
  const period = `${m.period.since ?? "(最初)"} 〜 ${m.period.until ?? "(最後)"}`;
  L.push(`# QA 指標(qa-metrics)— 期間 ${period}`);
  L.push("");
  L.push(`集計日 ${m.generated}。台帳: ${m.sources.map((s) => `\`${s.ledger}\`(qa-log ${s.qa_log_lines} 行・escaped ${s.escaped_exists ? `${s.escaped_lines} 行` : "**無し**"})`).join("、")}。`);
  if (m.menu) L.push(`メニュー(現在の status/frequency の参照のみ): \`${m.menu}\``);
  L.push("");
  L.push("> **数字は目標にしない**(基準 §7)。傾向と見直しの材料にだけ使う。しきい値は暫定の自社基準(基準 §4)。");
  L.push("");

  L.push("## 1. QA 件数");
  L.push("");
  L.push(`- 合計 ${m.counts.total} 件(QA 全体の所要が記録された行 ${m.minutes.total_recorded_rows} 件、平均 ${fmtMin(m.minutes.avg_per_qa)})`);
  L.push(`- レベル別: ${kv(m.counts.by_level)}`);
  L.push(`- 結果別: ${kv(m.counts.by_result)}`);
  L.push(`- アプリ別: ${kv(m.counts.by_app)}`);
  L.push(`- レベル×結果: ${kv(m.counts.by_level_result)}`);
  L.push("");

  L.push("## 2. 欠陥検出率 DDP");
  L.push("");
  L.push(`- DDP = QA で見つけた数 ÷(QA で見つけた数 + 漏れた数)= ${m.ddp.found_by_qa} ÷(${m.ddp.found_by_qa} + ${m.ddp.escaped})= **${fmtPct(m.ddp.value)}**${m.ddp.note ? `(${m.ddp.note})` : ""}`);
  L.push(`- QA で見つけた数の内訳: items から ${m.ddp.found_from_items}(findings − false_alarms)/ 旧様式の行から ${m.ddp.found_from_legacy_rows}(fail + warn。誤検出を引けない)`);
  L.push(`- 漏れた ${m.ddp.escaped} 件のうち QA で拾えたはず(should_have_caught が「${NOT_APPLICABLE}」以外)${m.ddp.escaped_caughtable} 件`);
  L.push("");

  L.push("## 3. 変更失敗率");
  L.push("");
  L.push(`- 全リリース ${m.change_failure.releases} 件(${m.change_failure.releases_note})`);
  L.push(`- (a) QA で拾えたはずの漏れがあったリリース: ${m.change_failure.caughtable_releases} ÷ ${m.change_failure.releases} = **${fmtPct(m.change_failure.caughtable_rate)}**`);
  L.push(`- (b) 即時対応(hotfix=true)が要ったリリース: ${m.change_failure.hotfix_releases} ÷ ${m.change_failure.releases} = **${fmtPct(m.change_failure.hotfix_rate)}**`);
  L.push(`- 分子は分母に当たる (app, commit) だけ(40 桁と 7 桁は同じリリースに畳む)。率に入れなかった漏れ ${m.change_failure.excluded_escaped} 件(${m.change_failure.excluded_note})`);
  if (m.change_failure.note) L.push(`- ${m.change_failure.note}`);
  L.push("");

  L.push("## 4. 不安定率");
  L.push("");
  L.push(`- Σ flaky_tests ÷ Σ tests_total(id が build-test の items)= ${m.flaky.flaky_tests} ÷ ${m.flaky.tests_total} = **${fmtPct(m.flaky.rate)}**(build-test ${m.flaky.build_test_runs} 回のうち記録あり ${m.flaky.build_test_with_record} 回)`);
  if (m.flaky.note) L.push(`- ${m.flaky.note}`);
  if (m.flaky.legacy_flag_items) L.push(`- 参考: 旧欄 flaky=true の項目 ${m.flaky.legacy_flag_items} 件(率には入れない)`);
  L.push("");

  L.push("## 5. 項目ごと(items)");
  L.push("");
  if (m.items.length === 0) {
    L.push(`items を持つ行が無い(旧様式 ${m.missing.rows_legacy} 件)。項目ごとの集計は items の記録が始まってから。`);
  } else {
    L.push("| id | 実施 | うち SKIP 以外 | 結果 | 平均所要 | 検出 | 誤検出 | 誤検出率 | 不安定(flaky/全テスト) | 矛盾 | 欠損(所要/検出/誤検出) | 現在の status / frequency |");
    L.push("|---|---|---|---|---|---|---|---|---|---|---|---|");
    for (const it of m.items) {
      const mn = it.menu ? `${it.menu.status ?? "?"} / ${it.menu.frequency ?? "?"}` : (m.menu ? "(メニューに無い)" : "—");
      const fl = it.tests_total > 0 ? `${it.flaky_tests}/${it.tests_total}` : "—";
      L.push(`| \`${it.id}\` | ${it.runs} | ${it.executed} | ${kv(it.by_result)} | ${fmtMin(it.avg_minutes)} | ${it.findings} | ${it.false_alarms} | ${fmtPct(it.false_alarm_rate)} | ${fl} | ${it.inconsistent} | ${it.missing.minutes}/${it.missing.findings}/${it.missing.false_alarms} | ${mn} |`);
    }
  }
  L.push("");

  L.push("## 6. 漏れた欠陥(escaped)");
  L.push("");
  L.push(`- 合計 ${m.escaped.total} 件: QA で拾えたはず ${m.escaped.caughtable} / ${NOT_APPLICABLE} ${m.escaped.not_applicable} / 即時対応あり ${m.escaped.hotfix_true} / なし ${m.escaped.hotfix_false}`);
  L.push(`- 拾うべきだった項目: ${kv(m.escaped.by_should_have_caught)}`);
  L.push(`- 見つけた人: ${kv(m.escaped.by_found_by)} / 重さ: ${kv(m.escaped.by_severity)} / アプリ: ${kv(m.escaped.by_app)}`);
  if (m.escaped.not_in_qa_log.length) {
    L.push(`- **注意: release_commit が qa-log に無い ${m.escaped.not_in_qa_log.length} 件(QA を通さずに出た可能性)**: ${m.escaped.not_in_qa_log.map((e) => `${e.app ?? "?"}@${e.release_commit}(${e.line} 行目)`).join("、")}`);
  }
  if (m.escaped.not_in_releases.length) {
    L.push(`- **変更失敗率に入れなかった漏れ ${m.escaped.not_in_releases.length} 件(分母の全リリースに当たらない)**:`);
    for (const e of m.escaped.not_in_releases) L.push(`  - ${e.app ?? "?"}@${e.release_commit ?? "(欠損)"}(${e.line} 行目${e.caughtable ? "・拾えたはず" : ""}${e.hotfix ? "・hotfix" : ""}): ${e.reason}`);
  }
  L.push("");

  L.push("## 7. 昇格・降格・頻度降格・強化の候補(提案。qa-menu.json は書き換えていない)");
  L.push("");
  const c = m.candidates;
  L.push(`- しきい値(暫定の自社基準): 昇格=直近 ${m.rules.promote.runs} 回の誤検出 0 / 降格=誤検出率 ${m.rules.demote.rate * 100}% 超が ${m.rules.demote.consecutive} 回連続 / 頻度降格=直近 ${m.rules.freq.runs} 回の検出 0 かつ平均 ${m.rules.freq.avgMinutes} 分超`);
  if (m.menu) L.push(`- --menu あり: 昇格・頻度降格の候補は status が warn / promoting の項目だけ(fail は昇格済み、record / measure / procedure は検査でないので出さない)`);
  const section = (title, arr, line) => {
    L.push(`- **${title}**: ${arr.length === 0 ? "なし" : ""}`);
    for (const x of arr) L.push(`  - ${line(x)}`);
  };
  section("昇格候補(所見 → FAIL 可)", c.promote, (x) => `\`${x.id}\`${x.status ? `(現在 ${x.status})` : ""}: ${x.reason}`);
  section("降格候補(FAIL 可 → 所見、または設定の見直し)", c.demote, (x) => `\`${x.id}\`${x.status ? `(現在 ${x.status})` : ""}: ${x.reason}`);
  section("頻度降格候補(毎回 → 四半期、または削除候補)", c.frequency_down, (x) => `\`${x.id}\`${x.frequency ? `(現在 ${x.frequency})` : ""}: ${x.reason}`);
  section("強化候補(漏れた欠陥が紐づいた項目)", c.reinforce, (x) => `\`${x.id}\`${x.in_menu === false ? "(**メニューに無い id**)" : x.status ? `(現在 ${x.status})` : ""}: ${x.reason} — ${x.escaped.map((e) => `${e.date ?? "日付なし"} ${e.app ?? "?"} ${e.severity ?? "?"}${e.hotfix === true ? " hotfix" : ""}`).join("、")}`);
  section("判定できなかったもの(欠損・記録の矛盾のため)", c.undeterminable, (x) => `\`${x.id}\`(${x.rule}): ${x.reason}`);
  if (m.menu) section("メニューに無い id(候補に出していない)", c.not_in_menu, (x) => `\`${x.id}\`(${x.runs} 回): ${x.reason}`);
  L.push("");

  L.push("## 8. 欠損・注意(落とさずに数えたもの)");
  L.push("");
  const ms = m.missing;
  L.push(`- 旧様式の行(phase / minutes / items のどれかが無い): ${ms.rows_legacy} 件(phase 無し ${ms.rows_missing_phase} / minutes 無し ${ms.rows_missing_minutes} / items 無し ${ms.rows_missing_items})。件数(§1)には入るが項目ごと(§5)・不安定率(§4)には入らない`);
  L.push(`- items の欄の欠損: 形が不正 ${ms.items_invalid} / minutes 無し ${ms.items_missing_minutes} / findings 無し ${ms.items_missing_findings} / false_alarms 無し ${ms.items_missing_false_alarms}`);
  L.push(`- items の記録の矛盾(false_alarms > findings): ${ms.items_inconsistent} 件(その項目は候補の判定をしていない。§7「判定できなかったもの」)`);
  L.push(`- build-test の flaky_tests / tests_total 無し: ${ms.build_test_missing_flaky_fields} 回(不安定率の分母に入らない)`);
  L.push(`- escaped の欠損: hotfix 無し ${ms.escaped_missing_hotfix} / should_have_caught 無し ${ms.escaped_missing_should_have_caught} / 必須欄(date・app・release_commit・release_level・type・severity)のどれかが無い ${ms.escaped_missing_fields}`);
  const lineList = (arr) => (arr.length ? `(${arr.map((u) => `${u.line} 行目`).join("・")})` : "");
  L.push(`- JSON として読めない行: qa-log ${ms.unparsable_qa_log}${lineList(m.unparsable_lines.qa_log)} / escaped ${ms.unparsable_escaped}${lineList(m.unparsable_lines.escaped)}`);
  if (ms.bad_date_qa_log || ms.bad_date_escaped) L.push(`- date が YYYY-MM-DD でない行: qa-log ${ms.bad_date_qa_log} / escaped ${ms.bad_date_escaped}`);
  if (m.period.since || m.period.until) L.push(`- 期間指定があるため date の無い(または読めない)行を除外: qa-log ${ms.no_date_excluded_qa_log} / escaped ${ms.no_date_excluded_escaped}`);
  if (ms.escaped_file_missing.length) L.push(`- **escaped.jsonl が無い**: ${ms.escaped_file_missing.map((p) => `\`${p}\``).join("、")}(DDP・変更失敗率は算出不可)`);
  L.push("");
  return L.join("\n");
}

// ---------- main ----------
function usage() {
  return [
    "使い方: node qa-metrics.mjs --ledger <基盤>/ledger [--ledger ...] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--menu <基盤>/qa-menu.json] [--format md|json]",
    "  qa-log.jsonl と escaped.jsonl を読んで、QA 件数・DDP・変更失敗率・不安定率・項目ごとの集計・昇格/降格の候補・欠損を出す。",
    "  候補は提案だけで、qa-menu.json は書き換えない。",
  ].join("\n");
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (isMain) {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`エラー: ${e.message}\n${usage()}`);
    process.exit(2);
  }
  if (opts.help) { console.log(usage()); process.exit(0); }
  try {
    const menu = readMenu(opts.menu);
    const m = computeMetrics({ ledgers: opts.ledgers, since: opts.since, until: opts.until, menu });
    process.stdout.write(opts.format === "json" ? `${JSON.stringify(m, null, 2)}\n` : `${renderMd(m)}\n`);
  } catch (e) {
    console.error(`エラー: ${e.message}`);
    process.exit(2);
  }
}
