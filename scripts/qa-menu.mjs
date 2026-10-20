#!/usr/bin/env node
/**
 * qa-menu.mjs — その回の QA メニュー(基本項目+条件付き項目)を、レベル×フェーズ×特性から決定論的に出す。
 *
 * 正本: ~/qa-standard/docs/qa-profile-standard.md(QA プロファイル基準)§2・§3・§8。
 * 入力は基盤ごとの qa-menu.json(~/yosage-webqa/qa-menu.json / ~/yosage-appqa/qa-menu.json)。
 *
 * 使い方:
 *   node qa-menu.mjs --menu <基盤>/qa-menu.json --level S2 \
 *     [--config <repo>/qa.config] [--phase build|launch|scale|proto] [--traits payments,tenant] [--format md|json]
 *
 * 決め方(基準 §2):
 *   - 基本項目(kind=base)はレベルだけで決まる。フェーズでは減らさない
 *   - 条件付き項目(kind=conditional)はフェーズ(phases.<phase> が null なら実施しない)、
 *     そのフェーズでのレベル、特性(traits: ["any"] か、どれか1つでも当たる特性の列)で決まる
 *   - 対象外になった条件付き項目は理由つきで出す(黙って落とさない)
 *   - フェーズ未指定は launch(安全側)。未知のフェーズ・レベル・特性は終了コード 2 で止める(黙って既定にしない)。
 *     特性の一覧 traits_known は qa-menu.json の必須項目(無いと打ち間違いが黙って通るので、validateMenu で止める)
 *   - proto はメニュー空+「QA 対象外」
 *   - 条件付き項目は qa-menu.json の並び順 = 実施順(安い・FAIL 可 → 記録 → 前提確認 → 探索 → ツール系)。
 *     上限に当たったら以降を「未実施(時間上限)」と記録する(基準 §3)
 *   - 項目ごとの上限(minutes × count)の合計 budget_minutes を出し、全体の上限と並べて md に出す(基本項目に残る時間が見えるように)。
 *     shares_minutes_with を持つ項目(例 attacker-charter は charter の 2 本のうち 1 本)は、指す先がメニューにあれば合計に足さない
 *   - status precheck(前提確認)は「存在・稼働を確かめるだけで実施はしない。無ければ所見」。運用・法務側の手順(本番監視・漏洩対応・訓練)を
 *     実行係が実行しないための印(2026-10-20 レン指摘の切り分け・基準 §5-2)
 *
 * 出力: md(実行係がそのまま読む。先頭にラベルの説明、末尾に全体の時間上限・項目上限の合計・機械可読の QA_MENU=<id,...>)/ json(--format json)。
 * 自己テストは qa-menu.test.mjs(npm test に含む。固定資料でスクリプトの論理を常に検証+両基盤の json の基準適合は無ければ skip)。
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const PHASES = ["proto", "build", "launch", "scale"];
export const STATUSES = ["fail", "warn", "promoting", "procedure", "record", "measure", "precheck"];
// frequency: every=毎回 / quarterly=四半期(前回の実施日を台帳で確かめる)/ first=初回 1 回。
// daily は 2026-10-20 に削除(日次の実施は運用側の仕事で QA の頻度ではない。前提確認は every で「回っているか」を見る)
export const FREQUENCIES = ["every", "quarterly", "first"];
export const STATUS_LABEL = {
  fail: "[必須]",       // FAIL 判定可(落とせる)
  warn: "[所見]",       // レポートに載るが、それだけでは落とさない(基準 §4)
  promoting: "[昇格中]", // 所見 → FAIL 可へ移行中(直近 3 回の誤検出 0 を待つ)
  procedure: "[手順]",  // 手順書どおりに実施したことを記録する
  record: "[記録]",     // 台帳に記録する
  measure: "[測定]",    // 数字を取る(目標にはしない)
  precheck: "[前提確認]", // 存在・稼働を確かめるだけ。実施はしない。無ければ所見(基準 §2 の「前提確認」。運用・法務側の手順を QA が実行しない)
};
/** 実行係が md の先頭で読むラベルの説明(基準 §6: 実行係は出力と指された節だけ読むので、ラベルの意味は出力に載せる) */
export const STATUS_LEGEND =
  "ラベル: [必須]=赤なら落とす / [所見]=載せるが落とさない / [昇格中]=所見→必須へ移行中 / [手順]=手順書どおり実施して記録 / " +
  "[記録]=台帳に書く / [測定]=数字を取る(目標にしない) / [前提確認]=存在・稼働を確かめるだけで実施はしない(無ければ所見)";
const FREQ_LABEL = { every: "毎回", quarterly: "四半期", first: "初回 1 回" };

// ---------- qa.config(shell 形式 KEY="value") ----------
/** `KEY="value"` / `KEY='value'` / `KEY=value` の行を読む。# はコメント、export は無視。値の前後の空白は落とす */
export function parseConfig(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    const q = v.match(/^"(.*)"\s*(?:#.*)?$/) || v.match(/^'(.*)'\s*(?:#.*)?$/);
    if (q) v = q[1];
    else v = v.replace(/\s+#.*$/, "").trim();
    out[m[1]] = v;
  }
  return out;
}

/** "a, b,,c" → ["a","b","c"]。空文字は [] */
export function parseTraits(s) {
  return String(s || "").split(",").map((t) => t.trim()).filter(Boolean);
}

// ---------- 入力の検証(壊れた json を黙って通さない) ----------
export class MenuError extends Error {
  constructor(msg) { super(msg); this.name = "MenuError"; }
}

export function validateMenu(menu) {
  const err = (m) => { throw new MenuError(`qa-menu.json: ${m}`); };
  if (!menu || typeof menu !== "object") err("オブジェクトではない");
  if (!Array.isArray(menu.levels) || menu.levels.length === 0) err("levels が無い");
  if (!Array.isArray(menu.items)) err("items が無い");
  if (!menu.caps || typeof menu.caps !== "object") err("caps が無い");
  // traits_known は必須(無いと打ち間違いの特性が黙って通り、dual-judge 等が静かに消える=基準 §1-2 に反する)
  if (!Array.isArray(menu.traits_known) || menu.traits_known.length === 0) err("traits_known が無い(特性の一覧。空にしない)");
  const known = menu.traits_known;
  const ids = new Set();
  const posInt = (v) => Number.isInteger(v) && v > 0;
  for (const it of menu.items) {
    const where = `項目 ${it && it.id ? it.id : "(id なし)"}`;
    if (!it.id || !/^[a-z][a-z0-9-]*$/.test(it.id)) err(`${where}: id は英小文字とハイフン`);
    if (ids.has(it.id)) err(`${where}: id が重複`);
    ids.add(it.id);
    if (!it.title) err(`${where}: title が無い`);
    if (!["base", "conditional"].includes(it.kind)) err(`${where}: kind は base|conditional`);
    if (!Array.isArray(it.levels) || it.levels.some((l) => !menu.levels.includes(l))) err(`${where}: levels が levels の範囲外`);
    if (!STATUSES.includes(it.status)) err(`${where}: status が不正 (${it.status})`);
    if (!FREQUENCIES.includes(it.frequency)) err(`${where}: frequency が不正 (${it.frequency})`);
    if (!it.doc) err(`${where}: doc(根拠の節)が無い`);
    if (!it.evidence) err(`${where}: evidence(証跡の形)が無い`);
    if (!Array.isArray(it.traits) || it.traits.length === 0) err(`${where}: traits が無い(["any"] か特性の列)`);
    for (const t of it.traits) if (t !== "any" && !known.includes(t)) err(`${where}: 未知の特性 ${t}`);
    if ("minutes" in it && !posInt(it.minutes)) err(`${where}: minutes は正の整数`);
    if ("count" in it && !posInt(it.count)) err(`${where}: count は正の整数`);
    if (it.kind === "conditional") {
      if (!it.phases || typeof it.phases !== "object") err(`${where}: 条件付き項目には phases が要る`);
      for (const p of ["build", "launch", "scale"]) {
        if (!(p in it.phases)) err(`${where}: phases.${p} が無い(実施しないなら null)`);
        const ph = it.phases[p];
        if (ph === null) continue;
        if (typeof ph !== "object") err(`${where}: phases.${p} はオブジェクトか null`);
        if (ph.levels && ph.levels.some((l) => !menu.levels.includes(l))) err(`${where}: phases.${p}.levels が範囲外`);
        if (ph.status && !STATUSES.includes(ph.status)) err(`${where}: phases.${p}.status が不正`);
        if (ph.frequency && !FREQUENCIES.includes(ph.frequency)) err(`${where}: phases.${p}.frequency が不正`);
        if ("minutes" in ph && !posInt(ph.minutes)) err(`${where}: phases.${p}.minutes は正の整数`);
        if ("count" in ph && !posInt(ph.count)) err(`${where}: phases.${p}.count は正の整数`);
      }
    }
    if (!Array.isArray(it.history)) err(`${where}: history が無い`);
  }
  // shares_minutes_with: 別の項目の分数の中で行う(例 attacker-charter は charter の 2 本のうち 1 本)。指す先が実在すること
  for (const it of menu.items) {
    if (it.shares_minutes_with === undefined) continue;
    if (!ids.has(it.shares_minutes_with) || it.shares_minutes_with === it.id) err(`項目 ${it.id}: shares_minutes_with が指す項目が無い (${it.shares_minutes_with})`);
  }
  for (const l of menu.levels) {
    if (!(l in menu.caps)) err(`caps.${l} が無い(上限なしなら null)`);
    const c = menu.caps[l];
    if (c === null) continue;
    for (const p of ["build", "launch", "scale"]) {
      if (!(p in c)) err(`caps.${l}.${p} が無い`);
      if (c[p] !== null && !(Number.isInteger(c[p]) && c[p] > 0)) err(`caps.${l}.${p} は正の整数か null`);
    }
  }
  return true;
}

export function loadMenu(path) {
  if (!existsSync(path)) throw new MenuError(`qa-menu.json が無い: ${path}`);
  let menu;
  try { menu = JSON.parse(readFileSync(path, "utf8")); }
  catch (e) { throw new MenuError(`qa-menu.json のパースに失敗: ${e.message}`); }
  validateMenu(menu);
  return menu;
}

// ---------- メニューの決定 ----------
/**
 * @param menu  qa-menu.json の中身(validateMenu 済み)
 * @param opts  { level, phase, traits: string[] }
 * @returns { base, level, phase, traits, cap_minutes, items, excluded, note }
 */
export function buildMenu(menu, { level, phase = "launch", traits = [] }) {
  if (!PHASES.includes(phase)) throw new MenuError(`未知のフェーズ: ${phase}(${PHASES.join("|")})`);
  if (!menu.levels.includes(level)) throw new MenuError(`未知のレベル: ${level}(${menu.levels.join("|")})`);
  const known = menu.traits_known; // validateMenu で必須(黙って既定にしない)
  const unknownTraits = traits.filter((t) => !known.includes(t));
  if (unknownTraits.length) {
    throw new MenuError(`未知の特性: ${unknownTraits.join(",")}(${known.join("|")})`);
  }
  const uniqTraits = [...new Set(traits)];
  const head = { base: menu.base, level, phase, traits: uniqTraits, generated_from: menu.updated || null };

  if (phase === "proto") {
    return { ...head, cap_minutes: null, budget_minutes: 0, items: [], excluded: [], note: "QA 対象外(フェーズ proto: 触れる試作で、外部の利用者がいない)" };
  }

  const cap = menu.caps[level] === null ? null : menu.caps[level][phase];
  const items = [];
  const excluded = [];
  const traitHit = (it) => it.traits.includes("any") || it.traits.some((t) => uniqTraits.includes(t));
  const traitLabel = (it) => it.traits.filter((t) => t !== "any").join("/");

  for (const it of menu.items) {
    if (it.kind === "base") {
      if (!it.levels.includes(level)) continue; // 基本項目はレベルで決まる。レベル外は「対象外」にも出さない(そもそも別レベルの項目)
      items.push(resolve_(it, null));
      continue;
    }
    // 条件付き項目
    const ph = it.phases[phase];
    if (ph === null || ph === undefined) {
      excluded.push({ id: it.id, title: it.title, reason: `フェーズ ${phase} では実施しない` });
      continue;
    }
    const lv = ph.levels || it.levels;
    if (!lv.includes(level)) {
      excluded.push({ id: it.id, title: it.title, reason: `レベル ${level} は対象外(${phase} では ${lv.join("/")})` });
      continue;
    }
    if (!traitHit(it)) {
      excluded.push({ id: it.id, title: it.title, reason: `特性 ${traitLabel(it)} のいずれも無い` });
      continue;
    }
    items.push(resolve_(it, ph));
  }
  // 項目ごとの上限(minutes)の合計。別の項目の分数の中で行う項目(shares_minutes_with)は、その項目がメニューにあれば足さない
  const inMenu = new Set(items.map((x) => x.id));
  const budget = items.reduce((sum, x) => {
    if (x.total_minutes === null) return sum;
    if (x.shares_minutes_with && inMenu.has(x.shares_minutes_with)) return sum;
    return sum + x.total_minutes;
  }, 0);
  return { ...head, cap_minutes: cap, budget_minutes: budget, items, excluded, note: null };
}

/** 項目とフェーズ側の上書きを 1 つにまとめる(出力の形は基準 §8 の json) */
function resolve_(it, ph) {
  const p = ph || {};
  const count = p.count ?? it.count ?? null;
  const minutes = p.minutes ?? it.minutes ?? null;
  return {
    id: it.id,
    title: it.title,
    kind: it.kind,
    status: p.status || it.status,
    minutes,
    count,
    total_minutes: minutes !== null && count !== null ? minutes * count : minutes,
    doc: it.doc,
    evidence: it.evidence,
    frequency: p.frequency || it.frequency,
    note: [it.note, p.note].filter(Boolean).join("。") || null,
    traits: it.traits,
    shares_minutes_with: it.shares_minutes_with ?? null,
  };
}

// ---------- 出力(md) ----------
function minutesLabel(x) {
  if (x.minutes === null) return "—(項目の上限なし。全体の上限内)";
  const shared = x.shares_minutes_with ? `。\`${x.shares_minutes_with}\` の分数の中で行う(別枠で足さない)` : "";
  if (x.count !== null) return `${x.total_minutes} 分(${x.count} 本 × ${x.minutes} 分)${shared}`;
  return `${x.minutes} 分${shared}`;
}
function itemLines(x) {
  const head = `- ${STATUS_LABEL[x.status]} \`${x.id}\` — ${x.title}${x.count !== null && x.minutes === null ? `(最大 ${x.count})` : ""}`;
  const lines = [head];
  if (x.note) lines.push(`  条件: ${x.note}`);
  lines.push(`  時間上限: ${minutesLabel(x)}`);
  lines.push(`  根拠: ${x.doc}`);
  lines.push(`  証跡: ${x.evidence}`);
  if (x.frequency !== "every") lines.push(`  頻度: ${FREQ_LABEL[x.frequency]}(前回の実施日を台帳で確かめ、期限内なら「実施済み(日付)」と記録)`);
  return lines;
}

export function renderMd(result) {
  const traits = result.traits.length ? result.traits.join(",") : "(なし)";
  const out = [];
  out.push(`# QA メニュー — ${result.base} / ${result.level} / ${result.phase} / 特性: ${traits}`);
  out.push(`生成: qa-menu.mjs(正本 ~/qa-standard/docs/qa-profile-standard.md §2・§3。入力 qa-menu.json${result.generated_from ? ` ${result.generated_from}` : ""})`);
  out.push(STATUS_LEGEND);
  out.push("");
  if (result.phase === "proto") {
    out.push(result.note);
    out.push("");
    out.push("QA_MENU=");
    return out.join("\n") + "\n";
  }
  const base = result.items.filter((x) => x.kind === "base");
  const cond = result.items.filter((x) => x.kind === "conditional");
  out.push("## 基本項目(レベルで決まる。フェーズでは減らさない・時間上限でも落とさない)");
  if (base.length === 0) out.push("- (なし)");
  for (const x of base) out.push(...itemLines(x));
  out.push("");
  out.push("## 条件付き項目(フェーズ × 特性で決まる。上から順に実施。上限に当たったら以降を「未実施(時間上限)」と記録)");
  if (cond.length === 0) out.push("- (この回は条件付き項目なし)");
  for (const x of cond) out.push(...itemLines(x));
  out.push("");
  out.push("## 対象外の条件付き項目(この回は実施しない。黙って落とさないための一覧)");
  if (result.excluded.length === 0) out.push("- (なし)");
  for (const e of result.excluded) out.push(`- \`${e.id}\` — ${e.title}: ${e.reason}`);
  out.push("");
  const capLine = result.cap_minutes === null
    ? `## 全体の時間上限: なし(${result.level} × ${result.phase}。項目ごとの上限のみ)`
    : `## 全体の時間上限: ${result.cap_minutes} 分(${result.level} × ${result.phase})`;
  out.push(capLine);
  // 項目ごとの上限の合計と、全体の上限との関係(基本項目に残る時間が見えるように)
  if (result.budget_minutes > 0) {
    if (result.cap_minutes === null) {
      out.push(`項目上限の合計: ${result.budget_minutes} 分(全体の上限なし)`);
    } else if (result.budget_minutes >= result.cap_minutes) {
      out.push(`注意: 項目上限の合計 ${result.budget_minutes} 分 ≥ 全体 ${result.cap_minutes} 分。基本項目を先に終え、条件付き項目は上から順に、上限に当たった時点で打ち切る`);
    } else {
      out.push(`項目上限の合計: ${result.budget_minutes} 分(基本項目に残るのは ${result.cap_minutes - result.budget_minutes} 分。足りなければ条件付き項目を上から順に打ち切る)`);
    }
  }
  out.push("上限に当たったら、残りの条件付き項目は「未実施(時間上限)」と記録し、所見に「落とした項目」を列挙する。基本項目は落とさない(基準 §3)。ツールが無い項目も「未実施(ツール不在: <名前>)」で記録する(実行係は入れない。導入はメインへ)。");
  out.push("");
  out.push(`QA_MENU=${result.items.map((x) => x.id).join(",")}`);
  return out.join("\n") + "\n";
}

export function renderJson(result) {
  const { base, level, phase, traits, cap_minutes, budget_minutes, items, excluded, note } = result;
  return JSON.stringify({ base, level, phase, traits, cap_minutes, budget_minutes, items, excluded, note }, null, 2) + "\n";
}

// ---------- CLI ----------
const HELP = `qa-menu.mjs — その回の QA メニューをレベル×フェーズ×特性から出す(正本: ~/qa-standard/docs/qa-profile-standard.md)

使い方:
  node qa-menu.mjs --menu <基盤>/qa-menu.json --level S2 [--config <repo>/qa.config]
                   [--phase build|launch|scale|proto] [--traits payments,tenant] [--format md|json]

  --menu     基盤の qa-menu.json(必須)。~/yosage-webqa/qa-menu.json か ~/yosage-appqa/qa-menu.json
  --level    judge_level.sh が出したレベル(S0-S3 / M0-M3)(必須)
  --config   アプリの qa.config(shell 形式)。QA_PHASE / QA_TRAITS を読む
  --phase    フェーズの明示指定(--config より優先)。未指定・未記入は launch(安全側)
  --traits   特性の明示指定(--config より優先)。カンマ区切り
  --format   md(既定)| json

終了コード: 0=出力した / 2=入力の誤り(未知のフェーズ・レベル・特性、ファイルなし、json の不備)。黙って既定にはしない。
`;

export function main(argv) {
  const args = argv.slice(2);
  const opt = (name, def = null) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith("--") ? args[i + 1] : def;
  };
  if (args.includes("--help") || args.includes("-h")) { process.stdout.write(HELP); return 0; }

  const menuPath = opt("menu");
  const level = opt("level");
  const configPath = opt("config");
  const format = opt("format", "md");
  if (!menuPath || !level) { process.stderr.write("ERROR: --menu と --level は必須\n\n" + HELP); return 2; }
  if (!["md", "json"].includes(format)) { process.stderr.write(`ERROR: --format は md|json(${format})\n`); return 2; }

  try {
    const menu = loadMenu(resolve(menuPath));
    let phase = null;
    let traits = null;
    if (configPath) {
      const p = resolve(configPath);
      if (!existsSync(p)) throw new MenuError(`qa.config が無い: ${p}`);
      const cfg = parseConfig(readFileSync(p, "utf8"));
      if ("QA_PHASE" in cfg && cfg.QA_PHASE !== "") phase = cfg.QA_PHASE;
      if ("QA_TRAITS" in cfg) traits = parseTraits(cfg.QA_TRAITS);
    }
    const phaseOpt = opt("phase");
    const traitsOpt = opt("traits");
    if (phaseOpt !== null) phase = phaseOpt;          // 明示指定が優先
    if (traitsOpt !== null) traits = parseTraits(traitsOpt);
    if (phase === null) phase = "launch";              // 未指定は安全側
    if (traits === null) traits = [];

    const result = buildMenu(menu, { level, phase, traits });
    process.stdout.write(format === "json" ? renderJson(result) : renderMd(result));
    return 0;
  } catch (e) {
    if (e instanceof MenuError) { process.stderr.write(`ERROR: ${e.message}\n`); return 2; }
    throw e;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exit(main(process.argv));
}
