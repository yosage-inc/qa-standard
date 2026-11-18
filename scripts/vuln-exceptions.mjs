#!/usr/bin/env node
/**
 * vuln-exceptions.mjs — 修正版のない依存脆弱性の「期限つき例外」を、security-deep(qa.yml)と
 * dependency-scan(security-weekly.yml)の OSV-Scanner と npm audit に効かせる道具。
 *
 * 正本: ~/qa-standard/docs/qa-policy.md §4-7(2026-11-18 レン決定)。台帳は config/vuln-exceptions.json の1か所。
 * ワークフローはこの1ファイルと台帳だけを $RUNNER_TEMP に写して使うので、ほかのファイルを import しない(標準ライブラリだけ)。
 *
 * 使い方:
 *   node vuln-exceptions.mjs prepare --ledger <台帳.json> --osv-config <出力.toml> --active-out <出力.json>
 *                                    [--today YYYY-MM-DD] [--osv-fixture-dir <dir>]
 *   node vuln-exceptions.mjs npm-audit --input <npm audit --json の出力> --active <prepare の active-out>
 *
 * prepare:
 *   1. 台帳を検証(validateLedger)。不正なら理由を全部出して終了コード 2(出力ファイルは作らない)
 *      「今日」は日本時間の日付(台帳の日付も日本時間で書く)。--today で上書きできる
 *   2. 期限内の行ごとに OSV API(https://api.osv.dev/v1/vulns/<id>。1回15秒・最大3回)で「修正版が無いこと」を確かめる。
 *      --osv-fixture-dir があればネットワークに出ず <dir>/<id>.json を読む(無ければ取得失敗)
 *      - 台帳の package が応答の affected に無い → 書き間違い。終了コード 2(出力なし)
 *      - 修正版あり → 適用しない(fix_available)/ 取得失敗 → 適用しない(fix_check_failed)。どちらも ::warning を出し終了コード 0
 *        (例外が効かないので後ろの検査が落ちる=安全側)
 *   3. 適用する行だけで osv-scanner の設定(TOML)を書く。ignoreUntil は expires の翌日(expires 当日まで効かせる)。0件でもコメントだけのファイルを書く
 *   4. --active-out に { today, applied: [{id, package, expires, reason}], not_applied: [{id, why}] } を書く
 *   5. 適用した行ごとに ::warning title=脆弱性の例外を適用中:: を1行出す
 *
 * npm-audit:
 *   - 判定対象 = vulnerabilities[*].via[] のうちオブジェクトのもの(公表そのもの)で severity が high / critical
 *     (npm audit --audit-level=high と同じ線)。同じ公表は1つにまとめる
 *   - 通すのは「severity が high」かつ「url 末尾の GHSA ID が applied にある」ものだけ。critical・ID を読めないものは通さない
 *   - severity が info / low / moderate / high / critical のどれでもない公表 → 読めないので通さない
 *   - high 以上と報告された部品から via をたどって、判定した公表に行き着かない → 形式を読めないので通さない
 *   - metadata.vulnerabilities.high + critical > 0 なのに判定対象が0件 → 形式を読めないので通さない(終了コード 1)
 *   - 読めない入力(JSON でない・最上位に error・vulnerabilities がオブジェクトでない)→ 終了コード 2
 *
 * 終了コード: 0=通す / 1=止める(npm-audit) / 2=入力・台帳の誤り。
 * 自己テストは vuln-exceptions.test.mjs(npm test に含む)。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

export const SCHEMA = 1;
/** コード側の期限の上限(日)。台帳の max_days はこれを超えられない(2026-11-18 レン決定「期限30日」) */
export const MAX_DAYS_CAP = 30;
export const ALLOWED_KEYS = ["id", "aliases", "ecosystem", "package", "summary", "reason", "approved_by", "approved_on", "expires"];
export const REQUIRED_KEYS = ["id", "ecosystem", "package", "reason", "approved_by", "approved_on", "expires"];
export const ECOSYSTEMS = ["npm"];
export const APPROVERS = ["レン"];
export const REASON_MIN_CHARS = 30;
export const ID_RE = /^GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** npm audit の severity のうち、high 未満と分かっているもの(これ以外で high / critical でもない値は「読めない」として止める) */
const BELOW_HIGH = new Set(["info", "low", "moderate"]);
const URL_GHSA_RE = /(GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4})$/i;
const OSV_API = "https://api.osv.dev/v1/vulns/";
const FETCH_TIMEOUT_MS = 15000;
const FETCH_TRIES = 3;

// ---------- 日付(暦日だけを扱う。時刻は持たない。「今日」は日本時間) ----------
/** YYYY-MM-DD の実在する日付なら、1970-01-01 からの日数を返す。そうでなければ null */
export function dayNumber(s) {
  if (typeof s !== "string") return null;
  const m = s.match(DATE_RE);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return t / 86400000;
}
/** 日数を YYYY-MM-DD に戻す */
export function fromDayNumber(n) {
  return new Date(n * 86400000).toISOString().slice(0, 10);
}
/** YYYY-MM-DD の翌日 */
export function nextDay(s) {
  const n = dayNumber(s);
  if (n === null) throw new Error(`日付ではない: ${s}`);
  return fromDayNumber(n + 1);
}
/**
 * 今日(日本時間の日付)。台帳の approved_on・expires は日本時間の日付で書くので、同じ暦で比べる
 * (UTC で比べると、日本時間 0:00〜8:59 に書いた当日の承認が「未来日の承認」になって落ちる)。
 * osv-scanner 側の ignoreUntil は expires の翌日(コンテナは UTC)なので、ここで期限内と判定した行が向こうで先に切れることはない。
 */
export function todayJst(now = new Date()) {
  return new Date(now.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

// ---------- 台帳の検証 ----------
/** 台帳を検証してエラー文字列の配列を返す(空なら正しい)。期限切れは不正ではない(履歴として残る) */
export function validateLedger(ledger, today) {
  const errs = [];
  const todayN = dayNumber(today);
  if (todayN === null) errs.push(`today が YYYY-MM-DD の実在する日付ではない: ${JSON.stringify(today)}`);
  if (ledger === null || typeof ledger !== "object" || Array.isArray(ledger)) {
    errs.push("台帳の最上位がオブジェクトではない");
    return errs;
  }
  if (ledger.schema !== SCHEMA) errs.push(`schema は ${SCHEMA} だけ(${JSON.stringify(ledger.schema)})`);
  const maxDaysOk = Number.isInteger(ledger.max_days) && ledger.max_days >= 1 && ledger.max_days <= MAX_DAYS_CAP;
  if (!maxDaysOk) errs.push(`max_days は 1〜${MAX_DAYS_CAP} の整数(${JSON.stringify(ledger.max_days)})`);
  const maxDays = maxDaysOk ? ledger.max_days : MAX_DAYS_CAP;
  if (!Array.isArray(ledger.exceptions)) {
    errs.push("exceptions が配列ではない");
    return errs;
  }
  const seen = new Set();
  ledger.exceptions.forEach((row, i) => {
    const at = `exceptions[${i}]`;
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      errs.push(`${at}: オブジェクトではない`);
      return;
    }
    const label = typeof row.id === "string" ? `${at}(${row.id})` : at;
    for (const k of Object.keys(row)) {
      if (!ALLOWED_KEYS.includes(k)) errs.push(`${label}: 知らないキー ${JSON.stringify(k)}(使えるのは ${ALLOWED_KEYS.join(" ")})`);
    }
    for (const k of REQUIRED_KEYS) {
      if (!(k in row)) errs.push(`${label}: ${k} が無い`);
    }
    if ("id" in row) {
      if (typeof row.id !== "string" || !ID_RE.test(row.id)) errs.push(`${label}: id の形が GHSA-xxxx-xxxx-xxxx(小文字英数)ではない`);
      else if (seen.has(row.id)) errs.push(`${label}: id が台帳の中で重複している`);
      else seen.add(row.id);
    }
    if ("aliases" in row && !(Array.isArray(row.aliases) && row.aliases.every((a) => typeof a === "string"))) {
      errs.push(`${label}: aliases は文字列の配列`);
    }
    if ("summary" in row && typeof row.summary !== "string") errs.push(`${label}: summary は文字列`);
    if ("ecosystem" in row && !ECOSYSTEMS.includes(row.ecosystem)) {
      errs.push(`${label}: ecosystem ${JSON.stringify(row.ecosystem)} は未対応(対応は ${ECOSYSTEMS.join(" ")} だけ)`);
    }
    if ("package" in row && !(typeof row.package === "string" && row.package.length > 0)) errs.push(`${label}: package は空でない文字列`);
    if ("reason" in row) {
      const len = typeof row.reason === "string" ? [...row.reason.trim()].length : -1;
      if (len < REASON_MIN_CHARS) errs.push(`${label}: reason は前後の空白を除いて ${REASON_MIN_CHARS} 文字以上(${len < 0 ? "文字列でない" : len + " 文字"})`);
    }
    if ("approved_by" in row && !APPROVERS.includes(row.approved_by)) {
      errs.push(`${label}: approved_by は ${APPROVERS.join(" ")} だけ(${JSON.stringify(row.approved_by)})`);
    }
    const ap = "approved_on" in row ? dayNumber(row.approved_on) : null;
    const ex = "expires" in row ? dayNumber(row.expires) : null;
    if ("approved_on" in row && ap === null) errs.push(`${label}: approved_on が YYYY-MM-DD の実在する日付ではない(${JSON.stringify(row.approved_on)})`);
    if ("expires" in row && ex === null) errs.push(`${label}: expires が YYYY-MM-DD の実在する日付ではない(${JSON.stringify(row.expires)})`);
    if (ap !== null && todayN !== null && ap > todayN) errs.push(`${label}: approved_on(${row.approved_on})が今日(${today})より後=未来日の承認`);
    if (ap !== null && ex !== null) {
      if (ex < ap) errs.push(`${label}: expires(${row.expires})が approved_on(${row.approved_on})より前`);
      else if (ex - ap > maxDays) errs.push(`${label}: 期限が承認日から ${ex - ap} 日=上限 ${maxDays} 日を超える`);
    }
  });
  return errs;
}

/** 検証済みの台帳を、今日の時点で期限内(active)と期限切れ(expired)に分ける。expires 当日までは期限内 */
export function splitByDate(ledger, today) {
  const t = dayNumber(today);
  const active = [];
  const expired = [];
  for (const row of ledger.exceptions) {
    if (dayNumber(row.expires) >= t) active.push(row);
    else expired.push(row);
  }
  return { active, expired };
}

// ---------- OSV の応答 ----------
/**
 * OSV の脆弱性の応答に、台帳の行の部品の修正版があるか。
 * true=修正版あり / false=修正版なし / null=応答の affected に台帳の ecosystem・package が無い(台帳の書き間違い)
 */
export function hasFix(osvVuln, { ecosystem, package: pkg }) {
  const affected = Array.isArray(osvVuln?.affected) ? osvVuln.affected : [];
  const hits = affected.filter((a) => a?.package?.ecosystem === ecosystem && a?.package?.name === pkg);
  if (hits.length === 0) return null;
  for (const a of hits) {
    for (const r of Array.isArray(a.ranges) ? a.ranges : []) {
      for (const ev of Array.isArray(r?.events) ? r.events : []) {
        if (ev && typeof ev === "object" && "fixed" in ev) return true;
      }
    }
  }
  return false;
}

// ---------- osv-scanner の設定 ----------
/** TOML の基本文字列("…")として書く */
export function tomlString(s) {
  let out = "";
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    if (ch === "\\") out += "\\\\";
    else if (ch === '"') out += '\\"';
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (c < 0x20 || c === 0x7f) out += "\\u" + c.toString(16).toUpperCase().padStart(4, "0");
    else out += ch;
  }
  return `"${out}"`;
}

/** 適用する行([{id, expires, reason}])から osv-scanner の設定を作る。0件ならコメントだけ */
export function toOsvToml(applied) {
  const lines = [
    "# qa-standard の脆弱性の例外台帳(config/vuln-exceptions.json)から vuln-exceptions.mjs prepare が書いた。手で直さない。",
    "# ignoreUntil は台帳の expires の翌日(expires 当日まで効かせる)。",
  ];
  if (applied.length === 0) lines.push("# 適用する例外は0件。");
  for (const a of applied) {
    lines.push("", "[[IgnoredVulns]]", `id = ${tomlString(a.id)}`, `ignoreUntil = ${nextDay(a.expires)}`, `reason = ${tomlString(a.reason)}`);
  }
  return lines.join("\n") + "\n";
}

// ---------- npm audit ----------
/** url の末尾の GHSA ID を GHSA-xxxx-xxxx-xxxx(本体は小文字)にそろえて返す(読めなければ null) */
export function ghsaFromUrl(url) {
  if (typeof url !== "string") return null;
  const m = url.trim().match(URL_GHSA_RE);
  return m ? "GHSA-" + m[1].slice(5).toLowerCase() : null;
}

/**
 * npm audit --json の出力を判定する。
 * 戻り値: { code: 0|1|2, passed: [...], blocked: [...], error?: string }
 *   passed / blocked の要素は { id, severity, title, url, package, why? }
 */
export function evaluateNpmAudit(audit, appliedIds) {
  if (audit === null || typeof audit !== "object" || Array.isArray(audit)) return { code: 2, passed: [], blocked: [], error: "npm audit の出力がオブジェクトではない" };
  if ("error" in audit) return { code: 2, passed: [], blocked: [], error: `npm audit がエラーを返した: ${JSON.stringify(audit.error)}` };
  const vulns = audit.vulnerabilities;
  if (vulns === null || typeof vulns !== "object" || Array.isArray(vulns)) return { code: 2, passed: [], blocked: [], error: "vulnerabilities がオブジェクトではない" };

  const applied = new Set([...appliedIds].map((x) => String(x).toLowerCase()));
  const advisories = new Map();
  for (const [name, v] of Object.entries(vulns)) {
    for (const via of Array.isArray(v?.via) ? v.via : []) {
      if (via === null || typeof via !== "object") continue; // 文字列は「別の部品経由」の印
      const key = via.source !== undefined ? `source:${via.source}` : via.url !== undefined ? `url:${via.url}` : `obj:${JSON.stringify(via)}`;
      if (!advisories.has(key)) advisories.set(key, { via, package: via.name ?? name });
    }
  }
  const passed = [];
  const blocked = [];
  for (const { via, package: pkg } of advisories.values()) {
    const severity = via.severity;
    if (BELOW_HIGH.has(severity)) continue; // high 未満と分かっているものだけ判定から外す
    const id = ghsaFromUrl(via.url);
    const item = { id, severity: severity ?? null, title: via.title ?? "", url: via.url ?? null, package: pkg };
    if (severity !== "high" && severity !== "critical") blocked.push({ ...item, why: "severity を読めない(high 未満と確かめられない)" });
    else if (severity === "critical") blocked.push({ ...item, why: "critical は例外の対象外" });
    else if (id === null) blocked.push({ ...item, why: "url から GHSA ID を読めない" });
    else if (!applied.has(id.toLowerCase())) blocked.push({ ...item, why: "例外台帳で適用中ではない" });
    else passed.push(item);
  }
  // 形式ずれの守り(部品ごと): high 以上と報告された部品は、via をたどると判定した公表に行き着くはず。
  // 行き着かない部品が1つでもあれば、その部品が high 以上になっている理由を読めていない=通さない
  const reachesJudged = (name, seen) => {
    if (seen.has(name)) return false;
    seen.add(name);
    for (const via of Array.isArray(vulns[name]?.via) ? vulns[name].via : []) {
      if (via !== null && typeof via === "object") { if (!BELOW_HIGH.has(via.severity)) return true; }
      else if (typeof via === "string" && reachesJudged(via, seen)) return true;
    }
    return false;
  };
  for (const [name, v] of Object.entries(vulns)) {
    if (v?.severity !== "high" && v?.severity !== "critical") continue;
    if (!reachesJudged(name, new Set())) {
      blocked.push({ id: null, severity: v.severity, title: "", url: null, package: name, why: "high 以上の理由になっている公表をたどれない(形式を読めない)" });
    }
  }
  const mv = audit.metadata?.vulnerabilities;
  const declared = (Number(mv?.high) || 0) + (Number(mv?.critical) || 0);
  if (declared > 0 && passed.length + blocked.length === 0) {
    return { code: 1, passed, blocked, error: `形式を読めない: metadata では high+critical が ${declared} 件なのに、判定できる公表が0件` };
  }
  return { code: blocked.length === 0 ? 0 : 1, passed, blocked };
}

// ---------- GitHub の注記 ----------
/** ワークフローコマンドの本文を1行にする(% と改行をエスケープ) */
export function annotationData(s) {
  return String(s).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}
/** 注記の題(本文の規則に加えて : と , もエスケープ) */
function annotationTitle(s) {
  return annotationData(s).replace(/:/g, "%3A").replace(/,/g, "%2C");
}
function warning(title, body) {
  return `::warning title=${annotationTitle(title)}::${annotationData(body)}`;
}
function head(s, n = 60) {
  const chars = [...String(s).replace(/\s+/g, " ").trim()];
  return chars.length > n ? chars.slice(0, n).join("") + "…" : chars.join("");
}

// ---------- OSV の取得(外へ出る読み取り。--osv-fixture-dir でファイルに差し替える) ----------
async function fetchOsv(id, fixtureDir) {
  if (fixtureDir) {
    const p = join(fixtureDir, `${id}.json`);
    if (!existsSync(p)) return { ok: false, error: `fixture が無い: ${p}` };
    try { return { ok: true, body: JSON.parse(readFileSync(p, "utf8")) }; }
    catch (e) { return { ok: false, error: `fixture を読めない: ${e.message}` }; }
  }
  let last = "";
  for (let i = 1; i <= FETCH_TRIES; i++) {
    try {
      const res = await fetch(OSV_API + encodeURIComponent(id), { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (res.ok) return { ok: true, body: await res.json() };
      last = `HTTP ${res.status}`;
    } catch (e) {
      last = e?.message ?? String(e);
    }
  }
  return { ok: false, error: `${FETCH_TRIES} 回とも失敗(最後: ${last})` };
}

// ---------- CLI ----------
const HELP = `vuln-exceptions.mjs — 修正版のない脆弱性の期限つき例外(正本: ~/qa-standard/docs/qa-policy.md §4-7)

使い方:
  node vuln-exceptions.mjs prepare --ledger <台帳.json> --osv-config <出力.toml> --active-out <出力.json>
                                   [--today YYYY-MM-DD] [--osv-fixture-dir <dir>]
  node vuln-exceptions.mjs npm-audit --input <npm audit --json の出力> --active <prepare の active-out>

終了コード: 0=通す / 1=止める(npm-audit) / 2=入力・台帳の誤り
`;

function parseArgs(args) {
  const o = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const v = args[i + 1];
      if (v === undefined || v.startsWith("--")) o[a.slice(2)] = true;
      else { o[a.slice(2)] = v; i++; }
    }
  }
  return o;
}

function readJson(path, what) {
  let text;
  try { text = readFileSync(resolve(path), "utf8"); }
  catch (e) { return { ok: false, error: `${what} を読めない: ${path}(${e.code ?? e.message})` }; }
  try { return { ok: true, value: JSON.parse(text) }; }
  catch (e) { return { ok: false, error: `${what} が JSON ではない: ${path}(${e.message})` }; }
}

async function cmdPrepare(o, out, err) {
  for (const k of ["ledger", "osv-config", "active-out"]) {
    if (typeof o[k] !== "string") { err(`ERROR: --${k} は必須\n\n` + HELP); return 2; }
  }
  const today = o.today === undefined ? todayJst() : o.today;
  if (dayNumber(today) === null) { err(`ERROR: --today が YYYY-MM-DD の実在する日付ではない: ${today}\n`); return 2; }
  const fixtureDir = typeof o["osv-fixture-dir"] === "string" ? resolve(o["osv-fixture-dir"]) : null;

  const r = readJson(o.ledger, "台帳");
  if (!r.ok) { err(`ERROR: ${r.error}\n`); return 2; }
  const ledger = r.value;
  const errs = validateLedger(ledger, today);
  if (errs.length) {
    err(`ERROR: 脆弱性の例外台帳が不正(${errs.length} 件)。例外は1件も通さない:\n` + errs.map((e) => `  - ${e}\n`).join(""));
    return 2;
  }

  const { active, expired } = splitByDate(ledger, today);
  const applied = [];
  const notApplied = expired.map((row) => ({ id: row.id, why: "expired" }));
  const warnings = [];
  const mismatches = [];
  for (const row of active) {
    const got = await fetchOsv(row.id, fixtureDir);
    if (!got.ok) {
      notApplied.push({ id: row.id, why: "fix_check_failed" });
      warnings.push(warning("修正版の確認に失敗したので例外を適用しない", `${row.id}(${row.package})OSV の取得に失敗: ${got.error}。例外なしで検査する`));
      continue;
    }
    const fix = hasFix(got.body, { ecosystem: row.ecosystem, package: row.package });
    if (fix === null) {
      mismatches.push(`${row.id}: OSV の応答の affected に ${row.ecosystem} の ${row.package} が無い(台帳の package の書き間違い)`);
      continue;
    }
    if (fix) {
      notApplied.push({ id: row.id, why: "fix_available" });
      warnings.push(warning("修正版が出たので例外は切れた", `${row.id}(${row.package})に修正版が出た。部品を更新すること。台帳の行は四半期見直しで消す`));
      continue;
    }
    applied.push(row);
  }
  if (mismatches.length) {
    err(`ERROR: 脆弱性の例外台帳が不正(${mismatches.length} 件)。例外は1件も通さない:\n` + mismatches.map((e) => `  - ${e}\n`).join(""));
    return 2;
  }

  const appliedOut = applied.map((a) => ({ id: a.id, package: a.package, expires: a.expires, reason: a.reason }));
  writeFileSync(resolve(o["osv-config"]), toOsvToml(appliedOut));
  writeFileSync(resolve(o["active-out"]), JSON.stringify({ today, applied: appliedOut, not_applied: notApplied }, null, 2) + "\n");

  const t = dayNumber(today);
  for (const a of applied) {
    const left = dayNumber(a.expires) - t;
    out(warning("脆弱性の例外を適用中", `${a.id}(${a.package})期限 ${a.expires}・残り ${left} 日。${head(a.summary ?? a.reason)}`) + "\n");
  }
  for (const w of warnings) out(w + "\n");
  for (const row of expired) out(`期限切れの例外(適用しない・四半期見直しで台帳から消す): ${row.id}(${row.package})期限 ${row.expires}\n`);
  out(`脆弱性の例外: 適用 ${applied.length} 件 / 適用しない ${notApplied.length} 件(台帳 ${ledger.exceptions.length} 件・今日 ${today})\n`);
  return 0;
}

function cmdNpmAudit(o, out, err) {
  for (const k of ["input", "active"]) {
    if (typeof o[k] !== "string") { err(`ERROR: --${k} は必須\n\n` + HELP); return 2; }
  }
  const a = readJson(o.active, "active");
  if (!a.ok) { err(`ERROR: ${a.error}\n`); return 2; }
  if (!Array.isArray(a.value?.applied)) { err("ERROR: active の applied が配列ではない\n"); return 2; }
  const expiresOf = new Map(a.value.applied.map((x) => [String(x.id).toLowerCase(), x.expires]));
  const r = readJson(o.input, "npm audit の出力");
  if (!r.ok) { err(`ERROR: ${r.error}\n`); return 2; }
  const res = evaluateNpmAudit(r.value, [...expiresOf.keys()]);
  if (res.code === 2) { err(`ERROR: ${res.error}(読めないものは通さない)\n`); return 2; }
  for (const p of res.passed) out(`通した(例外・期限 ${expiresOf.get(p.id.toLowerCase())}): ${p.id} ${p.severity} ${p.package} ${p.title}\n`);
  for (const b of res.blocked) out(`止めた(${b.why}): ${b.id ?? "(ID なし)"} ${b.severity} ${b.package} ${b.title}${b.url ? " " + b.url : ""}\n`);
  if (res.error) out(`止めた: ${res.error}\n`);
  out(`npm audit(high 以上): 通した ${res.passed.length} 件 / 止めた ${res.blocked.length} 件 → ${res.code === 0 ? "合格" : "不合格"}\n`);
  return res.code;
}

export async function main(argv, { out = (s) => process.stdout.write(s), err = (s) => process.stderr.write(s) } = {}) {
  const [sub, ...rest] = argv.slice(2);
  if (!sub || sub === "--help" || sub === "-h") { out(HELP); return sub ? 0 : 2; }
  const o = parseArgs(rest);
  if (sub === "prepare") return cmdPrepare(o, out, err);
  if (sub === "npm-audit") return cmdNpmAudit(o, out, err);
  err(`ERROR: 知らないサブコマンド: ${sub}\n\n` + HELP);
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv);
}
