#!/usr/bin/env node
/**
 * qa-menu.test.mjs — qa-menu.mjs の自己テスト(依存ゼロ: node:test / node:assert / node:fs / node:path)。
 *
 * 2 層に分ける(2026-10-20 レビュー反映):
 *   (A) スクリプトの論理 — この file の中の小さな固定資料(fixture)で常に実行する。
 *       proto 空 / phase null の除外 / レベル・特性の絞り込み / phases の status・frequency 上書き / 上限 / 項目上限の合計と shares_minutes_with /
 *       md の体裁(ラベル・対象外の節・QA_MENU 行)/ CLI の終了コード / validateMenu。
 *       公開リポジトリの clean checkout や CI でも守る力がゼロにならない。
 *   (B) データ適合 — ~/yosage-webqa/qa-menu.json と ~/yosage-appqa/qa-menu.json(別リポジトリ・非公開)が基準 §2・§3 の表どおりか。
 *       無ければ理由つきで skip(偽合格にしない)。基準 §8 の 6 ケースはこちら。
 *       四半期の見直しで json の値を変えたら、赤になるのはこの層だけ(スクリプトの検証と混ざった誤報にしない)。
 * 期待値は基準 §2・§3 の表から決めた値で書く(実装の式を写さない。test-quality-standard.md §3-2)。
 *
 * 壊して赤を見た記録(test-quality-standard.md §3-6。2026-10-20、qa-menu.mjs を 1 か所ずつ壊して node scripts/qa-menu.test.mjs。赤になったテスト名):
 *   m1 phase null の excluded.push を消す            → 赤(A2・B2)
 *   m2 traitHit を常に true                          → 赤(A4・A7・A8・A9・B3・B11)
 *   m3 resolve_ の status 上書き(p.status)を無視    → 赤(A5)
 *   m4 resolve_ の frequency 上書きを無視            → 赤(A5・A8)
 *   m5 renderMd の「対象外の条件付き項目」節を消す     → 赤(A2・A8・B2)
 *   m6 budget で shares_minutes_with を無視          → 赤(A7・B14)
 *   m7 validateMenu の traits_known 必須を外す       → 赤(A9・A10)
 *   m8 caps の正整数検証を外す                       → 赤(A10)
 *   m9 renderMd の「上から順に実施」を消す           → 赤(A8)
 *   m10 QA_MENU 行の順序を逆にする                   → 赤(A8・A9・B4・B10)
 *   レビュー(2026-10-20)の実測では是正前の自己テストは 20 変異中 6 変異が緑のまま(m3・m4・m5 相当を含む)。
 *   是正後は上の 10 変異すべて赤、元に戻して 26 件緑。
 *
 *   node scripts/qa-menu.test.mjs   (npm test に含む)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildMenu, loadMenu, parseConfig, parseTraits, renderMd, renderJson, validateMenu, MenuError, STATUSES, FREQUENCIES, STATUS_LABEL } from "./qa-menu.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "qa-menu.mjs");
const WEB = process.env.QA_MENU_WEB || join(homedir(), "yosage-webqa", "qa-menu.json");
const APP = process.env.QA_MENU_APP || join(homedir(), "yosage-appqa", "qa-menu.json");

// (B) 基盤の json が手元に無い環境(CI 等)では、その json を使うケースだけ理由つきで skip する(偽合格にしない)
const haveWeb = existsSync(WEB);
const haveApp = existsSync(APP);
const skipWeb = haveWeb ? false : `webqa の qa-menu.json が無い: ${WEB}`;
const skipApp = haveApp ? false : `appqa の qa-menu.json が無い: ${APP}`;

const ids = (r) => r.items.map((x) => x.id);
const find = (r, id) => r.items.find((x) => x.id === id);
const condIds = (r) => r.items.filter((x) => x.kind === "conditional").map((x) => x.id);

/** CLI を子プロセスで実行し、終了コードと標準出力・標準エラーを返す(終了コードの確認用) */
function runCli(args) {
  try {
    const stdout = execFileSync("node", [CLI, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    return { code: e.status, stdout: e.stdout || "", stderr: e.stderr || "" };
  }
}

/** 一時ディレクトリで f(dir) を実行し、後始末する */
function withTmp(f) {
  const dir = mkdtempSync(join(tmpdir(), "qa-menu-test-"));
  try { return f(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

// =====================================================================
// (A) スクリプトの論理 — 固定資料(基盤の json に依らない)
// =====================================================================

/** 小さな固定資料。レベル S0-S3、特性 pii/tenant、上限は基準 §3 の S の表(S0 は暫定 5 分) */
function fixture() {
  const item = (o) => ({ traits: ["any"], status: "warn", since: "2026-10-20", frequency: "every", doc: "d", evidence: "e", history: [{ date: "2026-10-20", change: "fixture" }], ...o });
  return {
    base: "fx", updated: "2026-10-20",
    levels: ["S0", "S1", "S2", "S3"],
    traits_known: ["pii", "tenant"],
    caps: {
      S0: { build: 5, launch: 5, scale: 5 },
      S1: { build: 15, launch: 15, scale: 15 },
      S2: { build: 60, launch: 90, scale: 90 },
      S3: { build: null, launch: null, scale: null },
    },
    items: [
      item({ id: "static", title: "静的", kind: "base", levels: ["S0", "S1", "S2", "S3"], status: "fail" }),
      item({ id: "flows", title: "フロー", kind: "base", levels: ["S2", "S3"], status: "fail" }),
      // 条件付き: 安い記録(S1+・全フェーズ)
      item({ id: "cheap", title: "記録", kind: "conditional", levels: ["S1", "S2", "S3"], phases: { build: {}, launch: {}, scale: {} }, status: "record" }),
      // build では実施しない。scale で status が fail に上書き
      item({ id: "late", title: "後から", kind: "conditional", levels: ["S2", "S3"], phases: { build: null, launch: {}, scale: { status: "fail" } } }),
      // tenant のときだけ・S3 のみ
      item({ id: "tenant-only", title: "テナント", kind: "conditional", levels: ["S3"], phases: { build: null, launch: {}, scale: {} }, traits: ["tenant"], status: "fail" }),
      // 探索: build 1 本 × 20 分、launch/scale 2 本 × 25 分
      item({ id: "explore", title: "探索", kind: "conditional", levels: ["S2", "S3"], phases: { build: { count: 1, minutes: 20 }, launch: { count: 2, minutes: 25 }, scale: { count: 2, minutes: 25 } } }),
      // 探索 2 本のうちの 1 本(合計に足さない)。pii/tenant のときだけ
      item({ id: "attack", title: "攻撃者視点", kind: "conditional", levels: ["S2", "S3"], phases: { build: null, launch: {}, scale: {} }, traits: ["pii", "tenant"], count: 1, minutes: 25, shares_minutes_with: "explore" }),
      // 15 分の固定枠。pii のときだけ
      item({ id: "model", title: "脅威モデル", kind: "conditional", levels: ["S2", "S3"], phases: { build: {}, launch: {}, scale: {} }, traits: ["pii"], minutes: 15 }),
      // 前提確認。build は frequency/status を上書き
      item({ id: "drill", title: "訓練の基準値", kind: "conditional", levels: ["S1", "S2", "S3"], phases: { build: { frequency: "first", status: "fail" }, launch: { frequency: "quarterly" }, scale: { frequency: "quarterly" } }, status: "precheck" }),
    ],
  };
}
const fx = () => { const m = fixture(); validateMenu(m); return m; };

test("A1 proto はメニュー空+「QA 対象外」。cap も budget も空", () => {
  const r = buildMenu(fx(), { level: "S2", phase: "proto", traits: ["tenant"] });
  assert.deepEqual(r.items, []);
  assert.deepEqual(r.excluded, []);
  assert.equal(r.cap_minutes, null);
  assert.equal(r.budget_minutes, 0);
  assert.match(r.note, /QA 対象外/);
  const md = renderMd(r);
  assert.match(md, /QA 対象外/);
  assert.match(md, /^QA_MENU=$/m);
  assert.ok(!/## 基本項目/.test(md), "proto に項目の節は出ない");
});

test("A2 phases.<phase> が null の項目は実施せず、対象外の一覧に理由つきで出る(md にも出る)", () => {
  const r = buildMenu(fx(), { level: "S2", phase: "build", traits: [] });
  assert.ok(!ids(r).includes("late"));
  const ex = r.excluded.find((e) => e.id === "late");
  assert.ok(ex, "対象外の一覧に late が無い(黙って落ちている)");
  assert.match(ex.reason, /build/);
  assert.match(renderMd(r), /## 対象外の条件付き項目[\s\S]*`late` — 後から: .*build/);
  // launch では出る
  assert.ok(ids(buildMenu(fx(), { level: "S2", phase: "launch", traits: [] })).includes("late"));
});

test("A3 レベルで絞る: 基本項目はレベル外なら出ない(対象外にも出ない)、条件付きはレベル外なら理由つきで対象外", () => {
  const r = buildMenu(fx(), { level: "S1", phase: "launch", traits: [] });
  assert.deepEqual(ids(r), ["static", "cheap", "drill"]);
  assert.ok(!r.excluded.some((e) => e.id === "flows"), "基本項目 flows は別レベルの項目なので対象外の一覧にも出ない");
  const ex = r.excluded.find((e) => e.id === "explore");
  assert.match(ex.reason, /レベル S1/);
  assert.match(ex.reason, /S2\/S3/);
});

test("A4 特性で絞る: tenant のときだけの項目は、特性なし・pii では消え(理由に特性名)、tenant で出る", () => {
  const none = buildMenu(fx(), { level: "S3", phase: "launch", traits: [] });
  assert.ok(!ids(none).includes("tenant-only"));
  assert.match(none.excluded.find((e) => e.id === "tenant-only").reason, /tenant/);
  const pii = buildMenu(fx(), { level: "S3", phase: "launch", traits: ["pii"] });
  assert.ok(!ids(pii).includes("tenant-only"));
  assert.ok(ids(pii).includes("model"), "model は pii で出る");
  const tenant = buildMenu(fx(), { level: "S3", phase: "launch", traits: ["tenant", "tenant"] });
  assert.equal(find(tenant, "tenant-only").status, "fail");
  assert.deepEqual(tenant.traits, ["tenant"], "特性の重複は 1 つにまとめる");
  assert.ok(!ids(tenant).includes("model"), "model は tenant だけでは出ない");
});

test("A5 phases の status / frequency の上書きが効く(build では元の値に戻る)", () => {
  const b = buildMenu(fx(), { level: "S2", phase: "build", traits: [] });
  assert.equal(find(b, "drill").status, "fail");
  assert.equal(find(b, "drill").frequency, "first");
  const l = buildMenu(fx(), { level: "S2", phase: "launch", traits: [] });
  assert.equal(find(l, "drill").status, "precheck");
  assert.equal(find(l, "drill").frequency, "quarterly");
  assert.equal(find(l, "late").status, "warn");
  const s = buildMenu(fx(), { level: "S2", phase: "scale", traits: [] });
  assert.equal(find(s, "late").status, "fail");
  assert.equal(find(s, "drill").frequency, "quarterly");
  // phase 側に無い値は項目側(every)
  assert.equal(find(l, "cheap").frequency, "every");
});

test("A6 全体の上限は caps[level][phase]。null は「上限なし」", () => {
  const cap = (level, phase) => buildMenu(fx(), { level, phase, traits: [] }).cap_minutes;
  assert.equal(cap("S0", "launch"), 5);
  assert.equal(cap("S1", "build"), 15);
  assert.equal(cap("S2", "build"), 60);
  assert.equal(cap("S2", "launch"), 90);
  assert.equal(cap("S2", "scale"), 90);
  assert.equal(cap("S3", "build"), null);
  assert.equal(cap("S3", "scale"), null);
  assert.match(renderMd(buildMenu(fx(), { level: "S3", phase: "launch", traits: [] })), /## 全体の時間上限: なし\(S3 × launch/);
  assert.match(renderMd(buildMenu(fx(), { level: "S0", phase: "launch", traits: [] })), /## 全体の時間上限: 5 分\(S0 × launch\)/);
});

test("A7 項目上限の合計: minutes × count を足し、shares_minutes_with の項目は指す先がメニューにあれば足さない。上限以上なら注意行", () => {
  // S2 launch pii: explore 2×25=50 + model 15 + attack(explore の中)0 = 65。cap 90 → 残り 25
  const r = buildMenu(fx(), { level: "S2", phase: "launch", traits: ["pii"] });
  assert.equal(find(r, "attack").total_minutes, 25, "表示用の分数はそのまま持つ");
  assert.equal(find(r, "attack").shares_minutes_with, "explore");
  assert.equal(r.budget_minutes, 65);
  assert.match(renderMd(r), /項目上限の合計: 65 分\(基本項目に残るのは 25 分/);
  // S2 build pii: explore 1×20 + model 15 = 35(attack は build で実施しない)
  assert.equal(buildMenu(fx(), { level: "S2", phase: "build", traits: ["pii"] }).budget_minutes, 35);
  // 特性なし: explore だけ 50
  assert.equal(buildMenu(fx(), { level: "S2", phase: "launch", traits: [] }).budget_minutes, 50);
  // 指す先(explore)がメニューに無ければ attack の 25 分を足す
  const m = fx(); m.items.find((x) => x.id === "explore").phases.launch = null;
  assert.equal(buildMenu(m, { level: "S2", phase: "launch", traits: ["pii"] }).budget_minutes, 40);
  // 上限以上なら注意行(cap を 60 にすると 65 ≥ 60)
  const m2 = fx(); m2.caps.S2.launch = 60;
  assert.match(renderMd(buildMenu(m2, { level: "S2", phase: "launch", traits: ["pii"] })), /注意: 項目上限の合計 65 分 ≥ 全体 60 分/);
  // 上限なし(S3)でも合計は出る
  assert.match(renderMd(buildMenu(fx(), { level: "S3", phase: "launch", traits: ["pii"] })), /項目上限の合計: 65 分\(全体の上限なし\)/);
  // json 出力にも載る
  assert.equal(JSON.parse(renderJson(r)).budget_minutes, 65);
});

test("A8 md の体裁: ラベルの説明・各ラベル・時間上限・根拠・証跡・頻度・実施順の見出し・対象外の節・ツール不在の注意・QA_MENU 行(順序どおり)", () => {
  const r = buildMenu(fx(), { level: "S2", phase: "launch", traits: ["pii"] });
  const md = renderMd(r);
  assert.match(md, /^ラベル: .*\[前提確認\]=存在・稼働を確かめるだけで実施はしない/m);
  assert.match(md, /- \[必須\] `static` — 静的/);
  assert.match(md, /- \[記録\] `cheap` — /);
  assert.match(md, /- \[前提確認\] `drill` — /);
  assert.match(md, /- \[所見\] `explore` — 探索\n  時間上限: 50 分\(2 本 × 25 分\)\n  根拠: d\n  証跡: e/);
  assert.match(md, /- \[所見\] `attack` — [\s\S]*?時間上限: 25 分\(1 本 × 25 分\)。`explore` の分数の中で行う\(別枠で足さない\)/);
  assert.match(md, /`model` — [\s\S]*?時間上限: 15 分\n/);
  assert.match(md, /`drill` — [\s\S]*?頻度: 四半期\(前回の実施日を台帳で確かめ/);
  assert.ok(!/`cheap` — [\s\S]*?頻度:/.test(md.split("`late`")[0]), "毎回の項目に頻度行は出ない");
  assert.match(md, /## 条件付き項目\(.*上から順に実施。上限に当たったら以降を「未実施\(時間上限\)」と記録\)/);
  assert.match(md, /## 対象外の条件付き項目[\s\S]*`tenant-only` — テナント: レベル S2 は対象外\(launch では S3\)/);
  assert.match(renderMd(buildMenu(fx(), { level: "S3", phase: "launch", traits: [] })), /## 対象外の条件付き項目[\s\S]*`tenant-only` — テナント: 特性 tenant のいずれも無い/);
  assert.match(md, /未実施\(ツール不在: <名前>\)/);
  const menuLine = md.match(/^QA_MENU=(.*)$/m);
  assert.ok(menuLine);
  assert.deepEqual(menuLine[1].split(","), ["static", "flows", "cheap", "late", "explore", "attack", "model", "drill"], "json の並び順 = 実施順のまま出す");
  for (const s of STATUSES) assert.ok(STATUS_LABEL[s], `ラベルが無い status: ${s}`);
});

test("A9 CLI: 未知のフェーズ・レベル・特性は終了コード 2、qa.config の読み取りと優先順位、--help は 0", () => {
  withTmp((dir) => {
    const menu = join(dir, "qa-menu.json");
    writeFileSync(menu, JSON.stringify(fixture()));
    assert.equal(runCli(["--menu", menu, "--level", "S2", "--phase", "beta"]).code, 2);
    assert.equal(runCli(["--menu", menu, "--level", "S9"]).code, 2);
    assert.equal(runCli(["--menu", menu, "--level", "M2"]).code, 2, "M のレベルを S の json に渡したらエラー");
    assert.equal(runCli(["--menu", menu, "--level", "S2", "--traits", "tenants"]).code, 2, "打ち間違いの特性を黙って無視しない");
    assert.equal(runCli(["--menu", menu]).code, 2, "--level なし");
    assert.equal(runCli(["--menu", join(dir, "no-such.json"), "--level", "S2"]).code, 2, "json が無い");
    assert.equal(runCli(["--menu", menu, "--level", "S2", "--format", "xml"]).code, 2, "未知の format");
    assert.equal(runCli(["--help"]).code, 0);
    const ok = runCli(["--menu", menu, "--level", "S2", "--phase", "launch"]);
    assert.equal(ok.code, 0);
    assert.match(ok.stdout, /^QA_MENU=static,flows,cheap,late,explore,drill$/m);
    // 壊れた json(traits_known 無し)は終了コード 2
    const broken = fixture(); delete broken.traits_known;
    writeFileSync(join(dir, "broken.json"), JSON.stringify(broken));
    const b = runCli(["--menu", join(dir, "broken.json"), "--level", "S2"]);
    assert.equal(b.code, 2);
    assert.match(b.stderr, /traits_known/);

    // qa.config(shell 形式)
    const cfg = parseConfig([
      "# コメント",
      'QA_PROJECT="x.xcodeproj"',
      "QA_PHASE=\"build\"   # 行末コメント",
      "export QA_TRAITS='tenant, pii'",
      "QA_EMPTY=\"\"",
      "",
    ].join("\n"));
    assert.equal(cfg.QA_PHASE, "build");
    assert.equal(cfg.QA_TRAITS, "tenant, pii");
    assert.equal(cfg.QA_EMPTY, "");
    assert.deepEqual(parseTraits(cfg.QA_TRAITS), ["tenant", "pii"]);
    assert.deepEqual(parseTraits(""), []);

    const conf = join(dir, "qa.config");
    writeFileSync(conf, 'QA_PHASE="build"\nQA_TRAITS="tenant"\n');
    const r1 = JSON.parse(runCli(["--menu", menu, "--level", "S2", "--config", conf, "--format", "json"]).stdout);
    assert.equal(r1.phase, "build");
    assert.deepEqual(r1.traits, ["tenant"]);
    assert.equal(r1.cap_minutes, 60);
    assert.equal(r1.budget_minutes, 20);
    // 明示指定が優先
    const r2 = JSON.parse(runCli(["--menu", menu, "--level", "S2", "--config", conf, "--phase", "launch", "--traits", "pii", "--format", "json"]).stdout);
    assert.equal(r2.phase, "launch");
    assert.deepEqual(r2.traits, ["pii"]);
    assert.equal(r2.cap_minutes, 90);
    // QA_PHASE 未記入は launch(安全側)
    writeFileSync(conf, 'QA_SCHEME="x"\n');
    const r3 = JSON.parse(runCli(["--menu", menu, "--level", "S2", "--config", conf, "--format", "json"]).stdout);
    assert.equal(r3.phase, "launch");
    assert.deepEqual(r3.traits, []);
    // 未知の QA_PHASE は終了コード 2
    writeFileSync(conf, 'QA_PHASE="beta"\n');
    assert.equal(runCli(["--menu", menu, "--level", "S2", "--config", conf]).code, 2);
    // 指定した qa.config が無ければ終了コード 2(黙って既定にしない)
    assert.equal(runCli(["--menu", menu, "--level", "S2", "--config", join(dir, "nope.config")]).code, 2);
  });
});

test("A10 validateMenu: traits_known 必須・不正な status/frequency・重複 id・phases 欠落・caps 欠落/非整数・未知の特性・shares_minutes_with の先・minutes/count を拒む", () => {
  const good = () => ({
    base: "x", levels: ["S1", "S2"], traits_known: ["pii"],
    caps: { S1: { build: 15, launch: 15, scale: 15 }, S2: { build: 60, launch: 90, scale: 90 } },
    items: [
      { id: "a", title: "A", kind: "base", levels: ["S1", "S2"], traits: ["any"], status: "fail", frequency: "every", doc: "d", evidence: "e", history: [] },
      { id: "b", title: "B", kind: "conditional", levels: ["S2"], phases: { build: null, launch: { status: "fail", frequency: "quarterly" }, scale: {} }, traits: ["pii"], status: "warn", frequency: "every", doc: "d", evidence: "e", history: [] },
    ],
  });
  assert.equal(validateMenu(good()), true);
  assert.equal(validateMenu(fixture()), true);
  let m = good(); m.items[0].status = "bogus";
  assert.throws(() => validateMenu(m), /status/);
  m = good(); m.items[1].phases.launch.status = "bogus";
  assert.throws(() => validateMenu(m), /phases\.launch\.status/);
  m = good(); m.items[0].frequency = "daily";
  assert.throws(() => validateMenu(m), /frequency/, "daily は 2026-10-20 に削除(日次は運用側の仕事)");
  m = good(); m.items[1].phases.launch.frequency = "daily";
  assert.throws(() => validateMenu(m), /phases\.launch\.frequency/);
  m = good(); m.items[0].status = "precheck";
  assert.equal(validateMenu(m), true, "precheck(前提確認)は有効な status");
  m = good(); m.items[1].id = "a";
  assert.throws(() => validateMenu(m), /重複/);
  m = good(); delete m.items[1].phases.scale;
  assert.throws(() => validateMenu(m), /phases\.scale/);
  m = good(); delete m.caps.S2;
  assert.throws(() => validateMenu(m), /caps\.S2/);
  m = good(); m.caps.S2.launch = 0;
  assert.throws(() => validateMenu(m), /caps\.S2\.launch/);
  m = good(); m.caps.S2.launch = 7.5;
  assert.throws(() => validateMenu(m), /caps\.S2\.launch/);
  m = good(); m.items[1].traits = ["tenants"];
  assert.throws(() => validateMenu(m), /未知の特性/);
  m = good(); delete m.traits_known;
  assert.throws(() => validateMenu(m), /traits_known/, "traits_known が無いと打ち間違いが黙って通るので止める");
  m = good(); m.traits_known = [];
  assert.throws(() => validateMenu(m), /traits_known/);
  m = good(); m.items[0].id = "Bad_Id";
  assert.throws(() => validateMenu(m), /英小文字/);
  m = good(); m.items[1].phases.launch = { levels: ["S9"] };
  assert.throws(() => validateMenu(m), /範囲外/);
  m = good(); m.items[1].shares_minutes_with = "zzz";
  assert.throws(() => validateMenu(m), /shares_minutes_with/);
  m = good(); m.items[1].shares_minutes_with = "b";
  assert.throws(() => validateMenu(m), /shares_minutes_with/, "自分自身は指せない");
  m = good(); m.items[1].shares_minutes_with = "a";
  assert.equal(validateMenu(m), true);
  m = good(); m.items[1].minutes = 0;
  assert.throws(() => validateMenu(m), /minutes/);
  m = good(); m.items[1].phases.launch.count = "2";
  assert.throws(() => validateMenu(m), /phases\.launch\.count/);
  assert.ok(STATUSES.includes("promoting") && STATUSES.includes("precheck"));
  assert.ok(!FREQUENCIES.includes("daily"));
  // loadMenu は壊れた json を MenuError で止める
  withTmp((dir) => {
    const p = join(dir, "x.json");
    writeFileSync(p, "{ not json");
    assert.throws(() => loadMenu(p), MenuError);
    assert.throws(() => loadMenu(join(dir, "none.json")), MenuError);
  });
});

// =====================================================================
// (B) データ適合 — 両基盤の qa-menu.json が基準 §2・§3 の表どおりか(無ければ skip)
// =====================================================================

// ---------- 基準 §8 の 6 ケース ----------
test("B1 proto はメニュー空+「QA 対象外」(webqa)", { skip: skipWeb }, () => {
  const r = buildMenu(loadMenu(WEB), { level: "S2", phase: "proto", traits: ["tenant"] });
  assert.deepEqual(r.items, []);
  assert.equal(r.cap_minutes, null);
  assert.match(renderMd(r), /^QA_MENU=$/m);
});

test("B2 build の S2 に a11y-web が無い(対象外の一覧には理由つきで出る)/ launch の S2 にはある(所見)", { skip: skipWeb }, () => {
  const menu = loadMenu(WEB);
  const r = buildMenu(menu, { level: "S2", phase: "build", traits: [] });
  assert.ok(!ids(r).includes("a11y-web"));
  const ex = r.excluded.find((e) => e.id === "a11y-web");
  assert.ok(ex, "対象外の一覧に a11y-web が無い(黙って落ちている)");
  assert.match(ex.reason, /build/);
  assert.match(renderMd(r), /## 対象外の条件付き項目[\s\S]*`a11y-web`.*build/);
  const it = find(buildMenu(menu, { level: "S2", phase: "launch", traits: [] }), "a11y-web");
  assert.ok(it);
  assert.equal(it.status, "warn");
  assert.equal(it.kind, "conditional");
  assert.match(it.note, /ツール不在: @axe-core\/playwright/, "ツールが無いときの記録の形");
});

test("B3 tenant も media も無い特性では dual-judge が消え、tenant があれば S3 launch で出る", { skip: skipWeb }, () => {
  const menu = loadMenu(WEB);
  const none = buildMenu(menu, { level: "S3", phase: "launch", traits: ["payments"] });
  assert.ok(!ids(none).includes("dual-judge"));
  assert.match(none.excluded.find((e) => e.id === "dual-judge").reason, /tenant\/media/);
  const tenant = buildMenu(menu, { level: "S3", phase: "launch", traits: ["tenant"] });
  assert.equal(find(tenant, "dual-judge").status, "fail");
  const media = buildMenu(menu, { level: "S3", phase: "launch", traits: ["media"] });
  assert.ok(ids(media).includes("dual-judge"));
  assert.ok(!ids(buildMenu(menu, { level: "S2", phase: "launch", traits: ["tenant"] })).includes("dual-judge"), "S2 では出ない");
  assert.ok(!ids(buildMenu(menu, { level: "S3", phase: "build", traits: ["tenant"] })).includes("dual-judge"), "build では出ない");
});

test("B4 両基盤の json に対して未知のフェーズ・レベル・特性は MenuError(CLI は終了コード 2)", { skip: skipWeb }, () => {
  const menu = loadMenu(WEB);
  assert.throws(() => buildMenu(menu, { level: "S2", phase: "beta", traits: [] }), MenuError);
  assert.throws(() => buildMenu(menu, { level: "M2", phase: "launch", traits: [] }), MenuError);
  assert.throws(() => buildMenu(menu, { level: "S2", phase: "launch", traits: ["tenants"] }), MenuError);
  assert.equal(runCli(["--menu", WEB, "--level", "S2", "--traits", "tenants"]).code, 2);
  const ok = runCli(["--menu", WEB, "--level", "S2", "--phase", "launch"]);
  assert.equal(ok.code, 0);
  assert.match(ok.stdout, /^QA_MENU=static-checks,/m);
});

test("B5 時間上限が基準 §3 の表どおり(S。S0 は暫定 5 分)", { skip: skipWeb }, () => {
  const menu = loadMenu(WEB);
  const cap = (level, phase) => buildMenu(menu, { level, phase, traits: [] }).cap_minutes;
  assert.equal(cap("S0", "build"), 5);
  assert.equal(cap("S1", "build"), 15);
  assert.equal(cap("S1", "launch"), 15);
  assert.equal(cap("S1", "scale"), 15);
  assert.equal(cap("S2", "build"), 60);
  assert.equal(cap("S2", "launch"), 90);
  assert.equal(cap("S2", "scale"), 90);
  assert.equal(cap("S3", "build"), null);
  assert.equal(cap("S3", "launch"), null);
  assert.equal(cap("S3", "scale"), null);
});

test("B6 時間上限が基準 §3 の表どおり(M。M0 は暫定 5 分)", { skip: skipApp }, () => {
  const menu = loadMenu(APP);
  const cap = (level, phase) => buildMenu(menu, { level, phase, traits: [] }).cap_minutes;
  assert.equal(cap("M0", "launch"), 5);
  assert.equal(cap("M1", "build"), 15);
  assert.equal(cap("M1", "launch"), 15);
  assert.equal(cap("M2", "build"), 45);
  assert.equal(cap("M2", "launch"), 60);
  assert.equal(cap("M2", "scale"), 60);
  assert.equal(cap("M3", "build"), null);
  assert.equal(cap("M3", "scale"), null);
});

// ---------- 基準 §2 の表との照合 ----------
test("B7 M2 build の mobile-conditions は「変更に関係する行だけ」、launch は「全行」。Web には無い", { skip: skipApp || skipWeb }, () => {
  const app = loadMenu(APP);
  const b = find(buildMenu(app, { level: "M2", phase: "build", traits: [] }), "mobile-conditions");
  assert.ok(b);
  assert.match(b.note, /変更に関係する行だけ/);
  assert.match(renderMd(buildMenu(app, { level: "M2", phase: "build", traits: [] })), /mobile-conditions[\s\S]*?変更に関係する行だけ/);
  assert.match(find(buildMenu(app, { level: "M2", phase: "launch", traits: [] }), "mobile-conditions").note, /全行/);
  assert.ok(!find(buildMenu(app, { level: "M1", phase: "launch", traits: [] }), "mobile-conditions"), "M1 では出ない");
  const web = loadMenu(WEB);
  assert.ok(!web.items.some((x) => x.id === "mobile-conditions"), "Web の json に mobile-conditions は無い");
  assert.ok(!app.items.some((x) => x.id === "api-fuzz" || x.id === "a11y-web"), "M の json に api-fuzz / a11y-web は無い");
  // mutation-probe の note は固定の分数でなく全体の上限を指す(M2 launch は 60 分)
  assert.match(find(buildMenu(app, { level: "M2", phase: "launch", traits: [] }), "mutation-probe").note, /全体の時間上限/);
  assert.ok(!/45 分/.test(find(buildMenu(app, { level: "M2", phase: "launch", traits: [] }), "mutation-probe").note));
});

test("B8 基本項目はフェーズで減らない。test-diff-review(S1+)と mutation-probe(S2+)は base で status=fail", { skip: skipWeb }, () => {
  const menu = loadMenu(WEB);
  const baseIds = (phase) => buildMenu(menu, { level: "S2", phase, traits: [] }).items.filter((x) => x.kind === "base").map((x) => x.id);
  assert.deepEqual(baseIds("build"), baseIds("launch"));
  assert.deepEqual(baseIds("launch"), baseIds("scale"));
  const s1 = buildMenu(menu, { level: "S1", phase: "build", traits: [] });
  assert.equal(find(s1, "test-diff-review").kind, "base");
  assert.equal(find(s1, "test-diff-review").status, "fail");
  assert.ok(!find(s1, "mutation-probe"), "S1 に変異プローブは無い");
  const s2 = buildMenu(menu, { level: "S2", phase: "build", traits: [] });
  assert.equal(find(s2, "mutation-probe").kind, "base");
  assert.equal(find(s2, "mutation-probe").status, "fail");
  assert.equal(find(s2, "mutation-probe").count, 3);
  // S0 は静的検査とビルドだけ
  const s0 = buildMenu(menu, { level: "S0", phase: "build", traits: [] });
  assert.deepEqual(s0.items.filter((x) => x.kind === "base").map((x) => x.id), ["static-checks", "build-test"]);
});

test("B9 S0/M0(資材のみ)の条件付き項目は escaped-ledger(記録)だけ。launch pii でも同じ", { skip: skipWeb || skipApp }, () => {
  const web = buildMenu(loadMenu(WEB), { level: "S0", phase: "launch", traits: ["pii", "tenant"] });
  assert.deepEqual(condIds(web), ["escaped-ledger"]);
  assert.equal(web.cap_minutes, 5);
  assert.ok(!/上限: なし/.test(renderMd(web)), "一番軽いレベルが「上限なし」と読めてはいけない");
  const app = buildMenu(loadMenu(APP), { level: "M0", phase: "launch", traits: ["media", "store"] });
  assert.deepEqual(condIds(app), ["escaped-ledger"]);
  assert.equal(app.cap_minutes, 5);
});

test("B10 charter は build 1 本 × 20 分、launch 2 本 × 25 分。md に [所見]・時間上限・根拠・証跡・上限行・QA_MENU 行が出る", { skip: skipWeb }, () => {
  const menu = loadMenu(WEB);
  const b = find(buildMenu(menu, { level: "S2", phase: "build", traits: [] }), "charter");
  assert.equal(b.count, 1);
  assert.equal(b.minutes, 20);
  const r = buildMenu(menu, { level: "S2", phase: "launch", traits: ["tenant", "pii"] });
  const l = find(r, "charter");
  assert.equal(l.count, 2);
  assert.equal(l.minutes, 25);
  assert.match(l.note, /attacker-charter/, "charter 側にも 1 本を attacker-charter に充てる旨");
  assert.match(l.note, /本番・Version URL/, "本番・Version URL に向けない(基準 §5)");
  const md = renderMd(r);
  assert.match(md, /- \[所見\] `charter` — /);
  assert.match(md, /時間上限: 50 分\(2 本 × 25 分\)/);
  assert.match(md, /根拠: templates\/charter-template\.md/);
  assert.match(md, /証跡: チャーター文/);
  assert.match(md, /- \[必須\] `authz-matrix` — /);
  assert.match(md, /- \[前提確認\] `prod-monitor` — /);
  assert.match(md, /- \[前提確認\] `breach-runbook` — /);
  assert.match(md, /- \[前提確認\] `seeded-drill` — /);
  assert.match(md, /- \[記録\] `escaped-ledger` — /);
  assert.match(md, /## 全体の時間上限: 90 分\(S2 × launch\)/);
  const menuLine = md.match(/^QA_MENU=(.*)$/m);
  assert.ok(menuLine);
  assert.deepEqual(menuLine[1].split(","), ids(r));
});

test("B11 セキュリティ行は pii/tenant のときだけ(dep-alerts は両方・特性不問)", { skip: skipWeb }, () => {
  const menu = loadMenu(WEB);
  const none = buildMenu(menu, { level: "S2", phase: "launch", traits: [] });
  for (const id of ["threat-model", "attacker-charter", "prod-monitor", "breach-runbook", "pii-inventory"]) {
    assert.ok(!ids(none).includes(id), `${id} は特性なしでは出ない`);
  }
  assert.ok(ids(none).includes("dep-alerts"), "dep-alerts は特性に依らず S1+ launch で出る");
  const pii = buildMenu(menu, { level: "S2", phase: "launch", traits: ["pii"] });
  for (const id of ["threat-model", "attacker-charter", "prod-monitor", "breach-runbook", "pii-inventory"]) {
    assert.ok(ids(pii).includes(id), `${id} は pii で出る`);
  }
  // build では threat-model(S2+・該当時)だけ。pii-inventory と dep-alerts は S3 のみ
  const b2 = buildMenu(menu, { level: "S2", phase: "build", traits: ["pii"] });
  assert.ok(ids(b2).includes("threat-model"));
  assert.ok(!ids(b2).includes("pii-inventory"));
  assert.ok(!ids(b2).includes("dep-alerts"));
  const b3 = buildMenu(menu, { level: "S3", phase: "build", traits: ["pii"] });
  assert.ok(ids(b3).includes("pii-inventory"));
  assert.ok(ids(b3).includes("dep-alerts"));
  // api-fuzz は build では S3 のみ、launch では S2+。launch はスキーマ未導入時の記録の形を持つ
  assert.ok(!ids(b2).includes("api-fuzz"));
  assert.ok(ids(b3).includes("api-fuzz"));
  assert.match(find(pii, "api-fuzz").note, /スキーマ未導入/);
  assert.match(find(pii, "api-fuzz").note, /ツール不在: schemathesis/);
});

test("B12 前提確認(prod-monitor・breach-runbook・seeded-drill)は precheck で、運用側の手順を実行係にやらせない。prod-monitor/breach-runbook は S2+ のみ", { skip: skipWeb }, () => {
  const menu = loadMenu(WEB);
  const s1 = buildMenu(menu, { level: "S1", phase: "launch", traits: ["pii"] });
  for (const id of ["prod-monitor", "breach-runbook"]) {
    assert.ok(!ids(s1).includes(id), `${id} は S1 では出ない(基準 §2「S2+ で確認」)`);
    assert.match(s1.excluded.find((e) => e.id === id).reason, /レベル S1/);
  }
  const s2 = buildMenu(menu, { level: "S2", phase: "launch", traits: ["pii"] });
  const pm = find(s2, "prod-monitor");
  assert.equal(pm.status, "precheck");
  assert.equal(pm.frequency, "every");
  assert.match(pm.note, /QA は手順を実行しない/);
  assert.ok(!/24 時間/.test(pm.note), "日次の手順そのもの(デプロイ後 24 時間…)は運用側の文書にだけ置く");
  assert.match(pm.evidence, /prod-monitor\.jsonl の直近 3 日/);
  const br = find(s2, "breach-runbook");
  assert.equal(br.status, "precheck");
  assert.match(br.note, /付録 B/);
  assert.ok(!/訓練/.test(br.note) && !/訓練/.test(br.evidence), "机上訓練の確認は法務側(incident-response.md §7)で QA に持ち込まない");
  const md = renderMd(s2);
  assert.match(md, /^- \[前提確認\] `prod-monitor` — /m, "md の行が [前提確認] で始まる");
  // seeded-drill は前提確認(毎回)。build の first は無い
  const sd = find(s2, "seeded-drill");
  assert.equal(sd.status, "precheck");
  assert.equal(sd.frequency, "every");
  assert.match(sd.note, /基準値未取得/);
  assert.equal(find(buildMenu(menu, { level: "S1", phase: "build", traits: [] }), "seeded-drill").frequency, "every");
  const app = loadMenu(APP === WEB ? WEB : APP);
  if (haveApp) {
    const m1 = find(buildMenu(app, { level: "M1", phase: "build", traits: [] }), "seeded-drill");
    assert.equal(m1.status, "precheck");
    assert.equal(m1.frequency, "every");
  }
});

test("B13 release-staging / restore-drill は S2+ で、doc は手順の節(release-staging.md §3 / §5)を指す。flaky-rate は再実行なしの回を区別する", { skip: skipWeb || skipApp }, () => {
  const web = loadMenu(WEB);
  const s1 = buildMenu(web, { level: "S1", phase: "launch", traits: [] });
  assert.ok(!ids(s1).includes("release-staging"));
  assert.ok(!ids(s1).includes("restore-drill"));
  const s2 = buildMenu(web, { level: "S2", phase: "launch", traits: [] });
  assert.equal(find(s2, "release-staging").doc, "docs/release-staging.md#3");
  assert.match(find(s2, "release-staging").evidence, /100% 到達時刻/);
  assert.equal(find(s2, "restore-drill").doc, "docs/release-staging.md#5");
  assert.equal(find(s2, "restore-drill").frequency, "quarterly");
  for (const menu of [web, loadMenu(APP)]) {
    const lv = menu.base === "webqa" ? "S1" : "M1";
    const fr = find(buildMenu(menu, { level: lv, phase: "launch", traits: [] }), "flaky-rate");
    assert.match(fr.note, /再実行の仕組みは無い/);
    assert.match(fr.note, /対象なし\(再実行なし\)/);
    assert.match(fr.evidence, /再実行したテスト名/);
  }
  // appqa の fixed-ui-tests は実行係が叩ける実コマンド
  const fx1 = find(buildMenu(loadMenu(APP), { level: "M1", phase: "launch", traits: [] }), "fixed-ui-tests");
  assert.match(fx1.note, /xcodebuild test .*-only-testing:/);
  assert.match(fx1.note, /固定UIテスト: 無し/);
  // perf-web は本番 URL に当てず、計測タグを遮断し、ツール不在の記録の形を持つ
  const pw = find(s2, "perf-web");
  assert.match(pw.note, /本番 URL に当てない/);
  assert.match(pw.note, /clarity\.ms/);
  assert.match(pw.note, /ツール不在: lighthouse/);
  assert.match(pw.note, /ledger\/perf\//);
});

test("B14 S2 launch pii で charter + attacker-charter の合計は 50 分(attacker-charter は charter の 2 本のうち 1 本)", { skip: skipWeb }, () => {
  const r = buildMenu(loadMenu(WEB), { level: "S2", phase: "launch", traits: ["pii"] });
  const ch = find(r, "charter");
  const ac = find(r, "attacker-charter");
  assert.equal(ac.count, 1);
  assert.equal(ac.minutes, 25);
  assert.equal(ac.shares_minutes_with, "charter");
  assert.match(ac.note, /本番・Version URL/);
  // 合計 = charter の 50 分(attacker は足さない)。threat-model 15 分と合わせて 65 分
  assert.equal(ch.total_minutes, 50);
  assert.equal(r.budget_minutes, 65);
  assert.match(renderMd(r), /`attacker-charter` — [\s\S]*?`charter` の分数の中で行う/);
});

test("B15 条件付き項目の並び順 = 実施順(安い・FAIL 可 → 記録 → 前提確認 → 探索 → ツール系)", { skip: skipWeb || skipApp }, () => {
  const order = (r) => condIds(r);
  const web = order(buildMenu(loadMenu(WEB), { level: "S3", phase: "launch", traits: ["pii", "tenant", "payments"] }));
  const before = (a, b, arr) => assert.ok(arr.indexOf(a) >= 0 && arr.indexOf(a) < arr.indexOf(b), `${a} が ${b} より前にない: ${arr.join(",")}`);
  assert.equal(web[0], "fixed-ui-tests");
  before("escaped-ledger", "prod-monitor", web);
  before("prod-monitor", "threat-model", web);
  before("threat-model", "attacker-charter", web);
  before("attacker-charter", "charter", web);
  before("charter", "a11y-web", web);
  assert.equal(web[web.length - 1], "perf-web");
  const app = order(buildMenu(loadMenu(APP), { level: "M3", phase: "launch", traits: ["media", "store"] }));
  assert.equal(app[0], "fixed-ui-tests");
  before("escaped-ledger", "seeded-drill", app);
  before("seeded-drill", "mobile-conditions", app);
  assert.equal(app[app.length - 1], "charter");
});

test("B16 両基盤の json が validateMenu を通り、_comment に四半期の見直しの注意がある。traits_known がある", { skip: skipWeb || skipApp }, () => {
  for (const p of [WEB, APP]) {
    const menu = loadMenu(p);
    assert.match(menu._comment, /四半期の見直し/);
    assert.match(menu._comment, /history/);
    assert.match(menu._comment, /precheck/);
    assert.ok(Array.isArray(menu.traits_known) && menu.traits_known.length >= 5);
    for (const it of menu.items) {
      assert.ok(it.history.length >= 1, `${it.id}: history が空`);
      assert.match(it.since, /^\d{4}-\d{2}-\d{2}$/, `${it.id}: since が日付でない`);
    }
  }
});
