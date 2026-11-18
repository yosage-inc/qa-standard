#!/usr/bin/env node
/**
 * vuln-exceptions.test.mjs — vuln-exceptions.mjs の自己テスト(依存ゼロ: node:test / node:assert / node:fs / node:path)。
 *
 * 期待値は委譲ブリーフ(~/yosage-infra/briefs/2026-11-18-vuln-exceptions-brief.md §3-1・§3-2)と qa-policy.md §4-7 の仕様から決めた値で書く
 * (実装の出力を写さない。test-quality-standard.md §3-2)。
 * 実物の fixture は scripts/fixtures/vuln-exceptions/(取得日 2026-11-18。README.md 参照):
 *   npm-audit-aisho-shindan.json = aisho-shindan の npm audit --json(公表は picomatch GHSA-fc5q-39xc-vjpf の high 1件)
 *   GHSA-fc5q-39xc-vjpf.json     = picomatch(last_affected だけ=修正版なし)
 *   GHSA-r3h5-4585-7x3w.json     = astro(fixed あり)と @astrojs/node(last_affected だけ)
 * ネットワークには出ない(prepare は --osv-fixture-dir で fixture を読む)。
 *
 * 壊して赤を見た記録(test-quality-standard.md §3-6。2026-11-18、vuln-exceptions.mjs を1か所ずつ壊して node scripts/vuln-exceptions.test.mjs。赤になったテスト):
 *   m1 splitByDate の期限の比較 >= を >(1日ずらす)      → 赤(L3・C2)
 *   m2 critical を止める分岐を外す                        → 赤(A4)
 *   m3 hasFix の fixed の判定を外す                        → 赤(H1・C5)
 *   m4 ignoreUntil を翌日でなく expires 当日               → 赤(T1・T2・T3・C1・C5)
 *   m5 max_days の上限 30 を外す                           → 赤(L2・C3)
 *   m6 未来日の承認の検査を外す                            → 赤(L2)
 *   m7 形式ずれの守り(metadata>0・公表0件)を外す          → 赤(A8)
 *   m8 TOML の \ と " のエスケープを外す                    → 赤(T4)
 *   m9 package 不一致を「修正版なし」扱い                  → 赤(H1・C6)
 *   m10 文字列の via も数える                              → 緑(等価変異: 文字列には severity が無く判定対象に入らない)
 *   元に戻して 27 件緑。
 *
 *   node scripts/vuln-exceptions.test.mjs   (npm test に含む)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validateLedger, splitByDate, hasFix, toOsvToml, evaluateNpmAudit, todayJst } from "./vuln-exceptions.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "vuln-exceptions.mjs");
const FX = join(HERE, "fixtures", "vuln-exceptions");
const LEDGER_FILE = join(HERE, "..", "config", "vuln-exceptions.json");
const readFx = (name) => JSON.parse(readFileSync(join(FX, name), "utf8"));
const clone = (x) => JSON.parse(JSON.stringify(x));

const TODAY = "2026-11-18";
const REASON = "astro・vite・tinyglobby・unstorage 経由のビルド用の部品。攻撃には攻撃者が glob の文字列を渡せることが要るが、当社サイトは自分の設定にある glob だけをビルド時に使い、公開物(静的ファイルと Worker)には picomatch が入らない";

/** ブリーフ §3-1 の台帳そのもの(正しい台帳) */
function goodLedger() {
  return {
    schema: 1,
    max_days: 30,
    exceptions: [
      {
        id: "GHSA-fc5q-39xc-vjpf",
        aliases: ["CVE-2026-112366"],
        ecosystem: "npm",
        package: "picomatch",
        summary: "picomatch 4.0.7 以下の ReDoS(1分岐の繰り返し extglob)。修正版なし",
        reason: REASON,
        approved_by: "レン",
        approved_on: "2026-11-18",
        expires: "2026-12-18",
      },
    ],
  };
}
/** 台帳の1行目を書き換えた台帳 */
function withRow(patch) {
  const l = goodLedger();
  Object.assign(l.exceptions[0], patch);
  return l;
}

function tmp() {
  return mkdtempSync(join(tmpdir(), "vuln-exc-"));
}
function run(args) {
  const r = spawnSync("node", [CLI, ...args], { encoding: "utf8" });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}
/** TOML からコメント行と空行を除いた行 */
function tomlBody(s) {
  return s.split("\n").filter((l) => l.trim() !== "" && !l.trim().startsWith("#"));
}

// ---------- 台帳の検証 ----------
test("D1 今日は日本時間の日付(UTC 15:00 で日付が変わる)", () => {
  assert.equal(todayJst(new Date("2026-11-17T14:59:59Z")), "2026-11-17");
  assert.equal(todayJst(new Date("2026-11-17T15:00:00Z")), "2026-11-18"); // 日本時間 11-18 0:00
  assert.equal(todayJst(new Date("2026-11-18T14:59:59Z")), "2026-11-18"); // 日本時間 11-18 23:59
  assert.equal(todayJst(new Date("2026-12-31T15:00:00Z")), "2027-01-01"); // 年またぎ
});

test("L0 config/vuln-exceptions.json の実物が今日(日本時間)の時点で正しい(台帳へ追記したら npm test で確かめる)", () => {
  const today = todayJst();
  assert.deepEqual(validateLedger(JSON.parse(readFileSync(LEDGER_FILE, "utf8")), today), []);
});

test("L1 ブリーフどおりの台帳は正しい", () => {
  assert.deepEqual(validateLedger(goodLedger(), TODAY), []);
  // 省略可の aliases・summary が無くても正しい
  const l = goodLedger();
  delete l.exceptions[0].aliases;
  delete l.exceptions[0].summary;
  assert.deepEqual(validateLedger(l, TODAY), []);
  // ちょうど30日(2026-11-18 → 2026-12-18)は正しい。承認日=期限日も正しい
  assert.deepEqual(validateLedger(withRow({ expires: "2026-11-18" }), TODAY), []);
  // 例外0件の台帳も正しい
  assert.deepEqual(validateLedger({ schema: 1, max_days: 30, exceptions: [] }, TODAY), []);
});

test("L2 ルールを1つずつ破ると不正になる", () => {
  const bad = {
    "schema が 2": { ...goodLedger(), schema: 2 },
    "schema が無い": (() => { const l = goodLedger(); delete l.schema; return l; })(),
    "max_days 31": { ...goodLedger(), max_days: 31 },
    "max_days 0": { ...goodLedger(), max_days: 0 },
    "max_days 小数": { ...goodLedger(), max_days: 7.5 },
    "max_days 文字列": { ...goodLedger(), max_days: "30" },
    "exceptions が配列でない": { ...goodLedger(), exceptions: {} },
    "知らないキー": withRow({ expire: "2026-12-18" }),
    "id の形(CVE)": withRow({ id: "CVE-2026-112366" }),
    "id の形(大文字の本体)": withRow({ id: "GHSA-FC5Q-39XC-VJPF" }),
    "id の形(桁不足)": withRow({ id: "GHSA-fc5q-39xc-vjp" }),
    "id の重複": (() => { const l = goodLedger(); l.exceptions.push(clone(l.exceptions[0])); return l; })(),
    "ecosystem PyPI": withRow({ ecosystem: "PyPI" }),
    "package 空": withRow({ package: "" }),
    "package 文字列でない": withRow({ package: 1 }),
    "reason 29文字": withRow({ reason: "あ".repeat(29) }),
    "reason 空白込みで30文字・中身29文字": withRow({ reason: "  " + "あ".repeat(29) + " " }),
    "reason が無い": (() => { const l = goodLedger(); delete l.exceptions[0].reason; return l; })(),
    "approved_by ロビ": withRow({ approved_by: "ロビ" }),
    "approved_on の形": withRow({ approved_on: "2026/11/18" }),
    "expires の形": withRow({ expires: "2026-12-8" }),
    "実在しない日付(11月31日)": withRow({ expires: "2026-11-31" }),
    "実在しない日付(平年の2月29日)": withRow({ approved_on: "2026-02-29", expires: "2026-03-01" }),
    "未来日の承認": withRow({ approved_on: "2026-11-19", expires: "2026-11-30" }),
    "expires < approved_on": withRow({ approved_on: "2026-11-18", expires: "2026-11-17" }),
    "31日間": withRow({ approved_on: "2026-11-18", expires: "2026-12-19" }),
    "max_days 10 で 11日間": { ...withRow({ expires: "2026-11-29" }), max_days: 10 },
    "aliases が文字列": withRow({ aliases: "CVE-2026-112366" }),
    "summary が配列": withRow({ summary: ["x"] }),
  };
  for (const [name, ledger] of Object.entries(bad)) {
    const errs = validateLedger(ledger, TODAY);
    assert.ok(Array.isArray(errs) && errs.length >= 1, `${name}: 不正にならない`);
  }
  // 境界の対照: 30文字の reason と max_days 10 で10日間は正しい
  assert.deepEqual(validateLedger(withRow({ reason: "あ".repeat(30) }), TODAY), []);
  assert.deepEqual(validateLedger({ ...withRow({ expires: "2026-11-28" }), max_days: 10 }, TODAY), []);
  // 閏年の2月29日は実在する
  assert.deepEqual(validateLedger(withRow({ approved_on: "2028-02-29", expires: "2028-03-01" }), "2028-02-29"), []);
});

test("L3 期限切れは不正ではない。expires 当日までは期限内・翌日は期限切れ", () => {
  const l = goodLedger();
  // today == expires
  assert.deepEqual(validateLedger(l, "2026-12-18"), []);
  let s = splitByDate(l, "2026-12-18");
  assert.deepEqual(s.active.map((r) => r.id), ["GHSA-fc5q-39xc-vjpf"]);
  assert.deepEqual(s.expired.map((r) => r.id), []);
  // 翌日
  assert.deepEqual(validateLedger(l, "2026-12-19"), []);
  s = splitByDate(l, "2026-12-19");
  assert.deepEqual(s.active.map((r) => r.id), []);
  assert.deepEqual(s.expired.map((r) => r.id), ["GHSA-fc5q-39xc-vjpf"]);
  // 承認日当日
  s = splitByDate(l, "2026-11-18");
  assert.deepEqual(s.active.map((r) => r.id), ["GHSA-fc5q-39xc-vjpf"]);
});

// ---------- hasFix ----------
test("H1 hasFix: picomatch=修正版なし / astro=あり / 同じ応答の @astrojs/node=なし / 応答に無い部品=不一致", () => {
  const pico = readFx("GHSA-fc5q-39xc-vjpf.json");
  const astro = readFx("GHSA-r3h5-4585-7x3w.json");
  assert.equal(hasFix(pico, { ecosystem: "npm", package: "picomatch" }), false);
  assert.equal(hasFix(astro, { ecosystem: "npm", package: "astro" }), true);
  assert.equal(hasFix(astro, { ecosystem: "npm", package: "@astrojs/node" }), false);
  // 不一致は true でも false でもない(=台帳の書き間違いとして扱える値)
  const miss = hasFix(pico, { ecosystem: "npm", package: "picomatchh" });
  assert.ok(miss !== true && miss !== false, "台帳の package が応答に無いのに修正版の有無を答えた");
  const missEco = hasFix(astro, { ecosystem: "PyPI", package: "astro" });
  assert.ok(missEco !== true && missEco !== false, "ecosystem が違うのに一致とみなした");
});

// ---------- toOsvToml ----------
test("T1 toOsvToml: 1件の完全一致(ignoreUntil は expires の翌日)", () => {
  const s = toOsvToml([{ id: "GHSA-fc5q-39xc-vjpf", package: "picomatch", expires: "2026-12-18", reason: "理由の文" }]);
  assert.deepEqual(tomlBody(s), ["[[IgnoredVulns]]", 'id = "GHSA-fc5q-39xc-vjpf"', "ignoreUntil = 2026-12-19", 'reason = "理由の文"']);
});

test("T2 toOsvToml: 月末・年末のまたぎ", () => {
  assert.ok(tomlBody(toOsvToml([{ id: "GHSA-aaaa-bbbb-cccc", package: "x", expires: "2026-12-31", reason: "r" }])).includes("ignoreUntil = 2027-01-01"));
  assert.ok(tomlBody(toOsvToml([{ id: "GHSA-aaaa-bbbb-cccc", package: "x", expires: "2026-11-30", reason: "r" }])).includes("ignoreUntil = 2026-12-01"));
  assert.ok(tomlBody(toOsvToml([{ id: "GHSA-aaaa-bbbb-cccc", package: "x", expires: "2028-02-28", reason: "r" }])).includes("ignoreUntil = 2028-02-29"));
});

test("T3 toOsvToml: 0件はコメントだけ / 2件は2ブロック", () => {
  const empty = toOsvToml([]);
  assert.deepEqual(tomlBody(empty), []);
  assert.ok(empty.trim().length > 0, "0件でも空文字ではなくコメントを書く");
  const two = tomlBody(toOsvToml([
    { id: "GHSA-aaaa-bbbb-cccc", package: "a", expires: "2026-12-01", reason: "r1" },
    { id: "GHSA-dddd-eeee-ffff", package: "b", expires: "2026-12-02", reason: "r2" },
  ]));
  assert.deepEqual(two, [
    "[[IgnoredVulns]]", 'id = "GHSA-aaaa-bbbb-cccc"', "ignoreUntil = 2026-12-02", 'reason = "r1"',
    "[[IgnoredVulns]]", 'id = "GHSA-dddd-eeee-ffff"', "ignoreUntil = 2026-12-03", 'reason = "r2"',
  ]);
});

test("T4 toOsvToml: reason の \" と \\ と改行を TOML の基本文字列としてエスケープ", () => {
  const s = toOsvToml([{ id: "GHSA-aaaa-bbbb-cccc", package: "x", expires: "2026-12-18", reason: 'a "b" \\ c\nd' }]);
  assert.ok(tomlBody(s).includes('reason = "a \\"b\\" \\\\ c\\nd"'), s);
});

// ---------- evaluateNpmAudit(実物の fixture) ----------
const AUDIT = readFx("npm-audit-aisho-shindan.json");
const PICO = "GHSA-fc5q-39xc-vjpf";
const blockedIds = (r) => r.blocked.map((b) => b.id);

test("A1 例外なし: aisho-shindan の実物は止まる(GHSA-fc5q-39xc-vjpf の1件)", () => {
  const r = evaluateNpmAudit(clone(AUDIT), []);
  assert.equal(r.code, 1);
  assert.deepEqual(blockedIds(r), [PICO]);
  assert.equal(r.passed.length, 0);
});

test("A2 picomatch を適用: 通る", () => {
  const r = evaluateNpmAudit(clone(AUDIT), [PICO]);
  assert.equal(r.code, 0);
  assert.deepEqual(r.blocked, []);
  assert.deepEqual(r.passed.map((p) => p.id), [PICO]);
  // 適用した ID が違えば通らない(戻り値が効いていることの確認)
  assert.equal(evaluateNpmAudit(clone(AUDIT), ["GHSA-aaaa-bbbb-cccc"]).code, 1);
});

test("A3 別の high の公表を足す: それだけ止まる", () => {
  const a = clone(AUDIT);
  a.vulnerabilities["evil-pkg"] = {
    name: "evil-pkg", severity: "high", isDirect: false,
    via: [{ source: 9999001, name: "evil-pkg", dependency: "evil-pkg", title: "テスト用の別の公表", url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc", severity: "high", range: "<9" }],
    effects: [], range: "<9", nodes: ["node_modules/evil-pkg"], fixAvailable: false,
  };
  a.metadata.vulnerabilities.high += 1;
  a.metadata.vulnerabilities.total += 1;
  const r = evaluateNpmAudit(a, [PICO]);
  assert.equal(r.code, 1);
  assert.deepEqual(blockedIds(r), ["GHSA-aaaa-bbbb-cccc"]);
  assert.deepEqual(r.passed.map((p) => p.id), [PICO]);
});

test("A4 適用した ID が critical: 止まる", () => {
  const a = clone(AUDIT);
  a.vulnerabilities.picomatch.via[0].severity = "critical";
  a.vulnerabilities.picomatch.severity = "critical";
  a.metadata.vulnerabilities.critical = 1;
  a.metadata.vulnerabilities.high -= 1;
  const r = evaluateNpmAudit(a, [PICO]);
  assert.equal(r.code, 1);
  assert.deepEqual(blockedIds(r), [PICO]);
  assert.equal(r.passed.length, 0);
});

test("A5 url の無い high・url から ID を読めない high: 止まる", () => {
  const a = clone(AUDIT);
  delete a.vulnerabilities.picomatch.via[0].url;
  const r = evaluateNpmAudit(a, [PICO]);
  assert.equal(r.code, 1);
  assert.equal(r.blocked.length, 1);
  assert.equal(r.passed.length, 0);
  const b = clone(AUDIT);
  b.vulnerabilities.picomatch.via[0].url = "https://example.com/advisory/1";
  assert.equal(evaluateNpmAudit(b, [PICO]).code, 1);
});

test("A6 url の ID の大文字小文字はそろえて比べる", () => {
  const a = clone(AUDIT);
  a.vulnerabilities.picomatch.via[0].url = "https://github.com/advisories/GHSA-FC5Q-39XC-VJPF";
  assert.equal(evaluateNpmAudit(a, [PICO]).code, 0);
});

test("A7 moderate だけ: 例外なしでも通る(--audit-level=high と同じ線)", () => {
  const a = clone(AUDIT);
  for (const v of Object.values(a.vulnerabilities)) v.severity = "moderate";
  a.vulnerabilities.picomatch.via[0].severity = "moderate";
  a.metadata.vulnerabilities = { info: 0, low: 0, moderate: 12, high: 0, critical: 0, total: 12 };
  const r = evaluateNpmAudit(a, []);
  assert.equal(r.code, 0);
  assert.deepEqual(r.blocked, []);
});

test("A8 metadata は high>0 なのに公表0件: 止まる(形式を読めない)", () => {
  const a = clone(AUDIT);
  a.vulnerabilities.picomatch.via = ["somewhere-else"];
  const r = evaluateNpmAudit(a, [PICO]);
  assert.equal(r.code, 1);
  assert.equal(r.passed.length, 0);
});

test("A9 読めない入力は終了コード 2: {error} / vulnerabilities がオブジェクトでない", () => {
  assert.equal(evaluateNpmAudit({ error: { code: "ENOLOCK", summary: "This command requires an existing lockfile." } }, [PICO]).code, 2);
  assert.equal(evaluateNpmAudit({ vulnerabilities: [] }, [PICO]).code, 2);
  assert.equal(evaluateNpmAudit({ metadata: {} }, [PICO]).code, 2);
  assert.equal(evaluateNpmAudit(null, [PICO]).code, 2);
});

test("A10 脆弱性0件: 通る", () => {
  const r = evaluateNpmAudit({ auditReportVersion: 2, vulnerabilities: {}, metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } } }, []);
  assert.equal(r.code, 0);
  assert.deepEqual(r.blocked, []);
});

test("A12 severity を読めない公表は止まる(high 未満と確かめられないものを黙って外さない)", () => {
  for (const sev of [undefined, null, "", "HIGH", "severe"]) {
    const audit = readFx("npm-audit-aisho-shindan.json");
    audit.vulnerabilities["mystery-pkg"] = {
      name: "mystery-pkg", severity: "high", isDirect: false, effects: [], range: "*", nodes: [], fixAvailable: false,
      via: [{ source: 999001, name: "mystery-pkg", title: "unknown severity", url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc", severity: sev, range: "*" }],
    };
    const r = evaluateNpmAudit(audit, ["GHSA-fc5q-39xc-vjpf"]);
    assert.equal(r.code, 1, `severity=${JSON.stringify(sev)}`);
    assert.deepEqual(r.blocked.map((b) => b.package), ["mystery-pkg"], `severity=${JSON.stringify(sev)}`);
    assert.deepEqual(r.passed.map((p) => p.id), ["GHSA-fc5q-39xc-vjpf"]);
  }
});

test("A13 high 以上の部品から公表をたどれない: 止まる(ほかの公表を通していても)", () => {
  const audit = readFx("npm-audit-aisho-shindan.json");
  // via が指す部品が報告に無い(形式ずれ・報告の欠け)
  audit.vulnerabilities["orphan-pkg"] = { name: "orphan-pkg", severity: "high", isDirect: false, via: ["ghost-pkg"], effects: [], range: "*", nodes: [], fixAvailable: false };
  const r = evaluateNpmAudit(audit, ["GHSA-fc5q-39xc-vjpf"]);
  assert.equal(r.code, 1);
  assert.deepEqual(r.blocked.map((b) => [b.package, b.id]), [["orphan-pkg", null]]);
  // たどった先が moderate の公表だけの high の部品も、理由を読めていないので止まる
  const audit2 = readFx("npm-audit-aisho-shindan.json");
  audit2.vulnerabilities["odd-pkg"] = {
    name: "odd-pkg", severity: "critical", isDirect: false, effects: [], range: "*", nodes: [], fixAvailable: false,
    via: [{ source: 999002, name: "odd-pkg", title: "moderate only", url: "https://github.com/advisories/GHSA-dddd-eeee-ffff", severity: "moderate", range: "*" }],
  };
  const r2 = evaluateNpmAudit(audit2, ["GHSA-fc5q-39xc-vjpf"]);
  assert.equal(r2.code, 1);
  assert.deepEqual(r2.blocked.map((b) => b.package), ["odd-pkg"]);
});

test("A14 via が輪になっていても止まらずに判定できる(輪の中に公表が無ければ両方止まる・あれば通る)", () => {
  const base = { auditReportVersion: 2, metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 2, critical: 0, total: 2 } } };
  const loop = { ...base, vulnerabilities: {
    a: { name: "a", severity: "high", via: ["b"] },
    b: { name: "b", severity: "high", via: ["a"] },
  } };
  const r = evaluateNpmAudit(loop, []);
  assert.equal(r.code, 1);
  assert.deepEqual(r.blocked.map((x) => x.package).sort(), ["a", "b"]);
  const loopWithAdvisory = { ...base, vulnerabilities: {
    a: { name: "a", severity: "high", via: ["b"] },
    b: { name: "b", severity: "high", via: ["a", { source: 1, name: "b", title: "t", url: "https://github.com/advisories/GHSA-fc5q-39xc-vjpf", severity: "high" }] },
  } };
  assert.equal(evaluateNpmAudit(loopWithAdvisory, ["GHSA-fc5q-39xc-vjpf"]).code, 0);
  assert.equal(evaluateNpmAudit(loopWithAdvisory, []).code, 1);
});

test("A11 同じ公表が2つの部品に出ても1つにまとめる", () => {
  const a = clone(AUDIT);
  a.vulnerabilities.fdir.via = [...a.vulnerabilities.fdir.via, clone(a.vulnerabilities.picomatch.via[0])];
  const r = evaluateNpmAudit(a, []);
  assert.deepEqual(blockedIds(r), [PICO]);
});

// ---------- CLI の通し ----------
/** ブリーフ §3-1 の台帳を一時ディレクトリに書いてパスを返す(実物の台帳が増えても CLI のテストは変わらない) */
function writeGoodLedger(d) {
  const p = join(d, "ledger.json");
  writeFileSync(p, JSON.stringify(goodLedger()));
  return p;
}

test("C1 prepare(fixture): osv 設定と active が仕様どおり・注記が1行・終了コード 0", () => {
  const d = tmp();
  try {
    const r = run(["prepare", "--ledger", writeGoodLedger(d), "--osv-config", join(d, "osv.toml"), "--active-out", join(d, "active.json"), "--today", TODAY, "--osv-fixture-dir", FX]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(tomlBody(readFileSync(join(d, "osv.toml"), "utf8")), [
      "[[IgnoredVulns]]", 'id = "GHSA-fc5q-39xc-vjpf"', "ignoreUntil = 2026-12-19", `reason = "${REASON}"`,
    ]);
    assert.deepEqual(JSON.parse(readFileSync(join(d, "active.json"), "utf8")), {
      today: TODAY,
      applied: [{ id: "GHSA-fc5q-39xc-vjpf", package: "picomatch", expires: "2026-12-18", reason: REASON }],
      not_applied: [],
    });
    const lines = r.stdout.split("\n").filter((l) => l.startsWith("::warning title=脆弱性の例外を適用中::"));
    assert.equal(lines.length, 1, r.stdout);
    assert.ok(lines[0].startsWith("::warning title=脆弱性の例外を適用中::GHSA-fc5q-39xc-vjpf(picomatch)期限 2026-12-18・残り 30 日。"), lines[0]);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("C2 prepare: 期限当日は残り 0 日で適用・翌日は expired で適用0件", () => {
  const d = tmp();
  try {
    const lp = writeGoodLedger(d);
    let r = run(["prepare", "--ledger", lp, "--osv-config", join(d, "o.toml"), "--active-out", join(d, "a.json"), "--today", "2026-12-18", "--osv-fixture-dir", FX]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /期限 2026-12-18・残り 0 日。/);
    assert.equal(JSON.parse(readFileSync(join(d, "a.json"), "utf8")).applied.length, 1);
    r = run(["prepare", "--ledger", lp, "--osv-config", join(d, "o.toml"), "--active-out", join(d, "a.json"), "--today", "2026-12-19", "--osv-fixture-dir", FX]);
    assert.equal(r.code, 0, r.stderr);
    const act = JSON.parse(readFileSync(join(d, "a.json"), "utf8"));
    assert.deepEqual(act.applied, []);
    assert.deepEqual(act.not_applied, [{ id: "GHSA-fc5q-39xc-vjpf", why: "expired" }]);
    assert.deepEqual(tomlBody(readFileSync(join(d, "o.toml"), "utf8")), []);
    assert.doesNotMatch(r.stdout, /::warning title=脆弱性の例外を適用中::/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("C3 prepare: 台帳が不正なら終了コード 2 で出力ファイルを作らない", () => {
  const d = tmp();
  try {
    const bad = join(d, "ledger.json");
    writeFileSync(bad, JSON.stringify({ ...goodLedger(), max_days: 31 }));
    const r = run(["prepare", "--ledger", bad, "--osv-config", join(d, "o.toml"), "--active-out", join(d, "a.json"), "--today", TODAY, "--osv-fixture-dir", FX]);
    assert.equal(r.code, 2);
    assert.equal(existsSync(join(d, "o.toml")), false);
    assert.equal(existsSync(join(d, "a.json")), false);
    // JSON でない台帳も 2
    writeFileSync(bad, "{ not json");
    assert.equal(run(["prepare", "--ledger", bad, "--osv-config", join(d, "o.toml"), "--active-out", join(d, "a.json"), "--today", TODAY, "--osv-fixture-dir", FX]).code, 2);
    assert.equal(existsSync(join(d, "o.toml")), false);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("C4 prepare: fixture が無い=fix_check_failed で適用0件・終了コード 0・警告あり", () => {
  const d = tmp();
  try {
    const r = run(["prepare", "--ledger", writeGoodLedger(d), "--osv-config", join(d, "o.toml"), "--active-out", join(d, "a.json"), "--today", TODAY, "--osv-fixture-dir", d]);
    assert.equal(r.code, 0, r.stderr);
    const act = JSON.parse(readFileSync(join(d, "a.json"), "utf8"));
    assert.deepEqual(act.applied, []);
    assert.deepEqual(act.not_applied, [{ id: "GHSA-fc5q-39xc-vjpf", why: "fix_check_failed" }]);
    assert.deepEqual(tomlBody(readFileSync(join(d, "o.toml"), "utf8")), []);
    assert.match(r.stdout, /^::warning /m);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("C5 prepare: 修正版ありの fixture=fix_available(同じ応答で修正版なしの部品は適用)", () => {
  const d = tmp();
  try {
    const l = goodLedger();
    l.exceptions = [
      { id: "GHSA-r3h5-4585-7x3w", ecosystem: "npm", package: "astro", reason: REASON, approved_by: "レン", approved_on: TODAY, expires: "2026-12-01" },
    ];
    const lp = join(d, "ledger.json");
    writeFileSync(lp, JSON.stringify(l));
    let r = run(["prepare", "--ledger", lp, "--osv-config", join(d, "o.toml"), "--active-out", join(d, "a.json"), "--today", TODAY, "--osv-fixture-dir", FX]);
    assert.equal(r.code, 0, r.stderr);
    let act = JSON.parse(readFileSync(join(d, "a.json"), "utf8"));
    assert.deepEqual(act.applied, []);
    assert.deepEqual(act.not_applied, [{ id: "GHSA-r3h5-4585-7x3w", why: "fix_available" }]);
    assert.deepEqual(tomlBody(readFileSync(join(d, "o.toml"), "utf8")), []);
    assert.match(r.stdout, /^::warning title=修正版が出たので例外は切れた::/m);

    l.exceptions[0].package = "@astrojs/node";
    writeFileSync(lp, JSON.stringify(l));
    r = run(["prepare", "--ledger", lp, "--osv-config", join(d, "o.toml"), "--active-out", join(d, "a.json"), "--today", TODAY, "--osv-fixture-dir", FX]);
    assert.equal(r.code, 0, r.stderr);
    act = JSON.parse(readFileSync(join(d, "a.json"), "utf8"));
    assert.deepEqual(act.applied.map((a) => a.id), ["GHSA-r3h5-4585-7x3w"]);
    assert.ok(tomlBody(readFileSync(join(d, "o.toml"), "utf8")).includes("ignoreUntil = 2026-12-02"));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("C6 prepare: 台帳の package が OSV の応答に無い=終了コード 2・出力なし", () => {
  const d = tmp();
  try {
    const lp = join(d, "ledger.json");
    writeFileSync(lp, JSON.stringify(withRow({ package: "picomach" })));
    const r = run(["prepare", "--ledger", lp, "--osv-config", join(d, "o.toml"), "--active-out", join(d, "a.json"), "--today", TODAY, "--osv-fixture-dir", FX]);
    assert.equal(r.code, 2);
    assert.equal(existsSync(join(d, "o.toml")), false);
    assert.equal(existsSync(join(d, "a.json")), false);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("C7 npm-audit CLI: 実物+適用あり=0 / 適用なし=1 / JSON でない入力=2", () => {
  const d = tmp();
  try {
    const input = join(FX, "npm-audit-aisho-shindan.json");
    const on = join(d, "on.json");
    const none = join(d, "none.json");
    writeFileSync(on, JSON.stringify({ today: TODAY, applied: [{ id: PICO, package: "picomatch", expires: "2026-12-18", reason: REASON }], not_applied: [] }));
    writeFileSync(none, JSON.stringify({ today: TODAY, applied: [], not_applied: [] }));
    assert.equal(run(["npm-audit", "--input", input, "--active", on]).code, 0);
    const r = run(["npm-audit", "--input", input, "--active", none]);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /GHSA-fc5q-39xc-vjpf/);
    const garbage = join(d, "garbage.json");
    writeFileSync(garbage, "npm ERR! something\n");
    assert.equal(run(["npm-audit", "--input", garbage, "--active", on]).code, 2);
    const err = join(d, "err.json");
    writeFileSync(err, JSON.stringify({ error: { code: "ENOLOCK", summary: "x" } }));
    assert.equal(run(["npm-audit", "--input", err, "--active", on]).code, 2);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
