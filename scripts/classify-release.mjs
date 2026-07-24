#!/usr/bin/env node
/**
 * classify-release.mjs — リリースの大きさ・複雑さから QA レベル (L0-L3) を自動判定する。
 *
 * 使い方:
 *   node classify-release.mjs --base <sha> --head <sha> [--policy qa-policy.json] [--override L2] [--json]
 *
 * 判定順序(上が優先):
 *   1. --override / コミットメッセージの [qa:LN] タグ
 *   2. L3 パスに1つでも触れていれば L3 (セキュリティ敏感領域)
 *   3. 全ファイルが L0 パス内なら L0 (コンテンツのみ)
 *   4. L2 パスに触れていれば L2 (テンプレート/レイアウト = 全ページ波及)
 *   5. 差分規模: しきい値以下なら L1、超えたら L2
 *
 * 出力: GITHUB_OUTPUT があれば level / reason / run_* フラグを書き込む。--json で機械可読出力。
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// ---------- 引数 ----------
const args = process.argv.slice(2);
const opt = (name, def = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : def;
};
const flag = (name) => args.includes(`--${name}`);

const BASE = opt("base", process.env.QA_BASE_SHA || "");
const HEAD = opt("head", process.env.QA_HEAD_SHA || "HEAD");
const POLICY_PATH = opt("policy", "qa-policy.json");
const OVERRIDE = (opt("override", "") || "").toUpperCase();
const AS_JSON = flag("json");
const CWD = opt("cwd", process.cwd());

// ---------- ポリシー ----------
const DEFAULT_POLICY = {
  version: 1,
  // L3: 認証・決済・セッション・DB・依存関係・CI・ヘッダ等、事故ったとき影響が最大の領域
  l3_paths: [
    "**/auth/**", "**/*auth*", "**/login/**", "**/session*", "**/middleware*",
    "**/payment*", "**/billing*", "**/checkout*",
    "**/migrations/**", "**/*.sql", "**/schema*", "**/drizzle*",
    "package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb",
    "requirements*.txt", "Pipfile*", "uv.lock",
    "wrangler.toml", "wrangler.jsonc", "wrangler.json",
    ".github/**", "**/_headers", "**/headers*", "**/csp*", "**/*cookie*",
    ".env*", "**/secrets*",
  ],
  // L0: コンテンツ・データ・画像のみ = コードに触れない変更
  l0_paths: [
    "content/**", "posts/**", "articles/**", "data/**",
    "public/images/**", "public/img/**", "src/content/**",
    "**/*.md", "**/*.mdx", "**/*.csv", "**/*.json5",
    "**/*.jpg", "**/*.jpeg", "**/*.png", "**/*.webp", "**/*.avif", "**/*.gif", "**/*.svg", "**/*.ico",
    "**/*.txt", "**/*.xml", "**/*.woff", "**/*.woff2",
    "README*", "LICENSE*", "docs/**",
  ],
  // L2: 1ファイルの変更が全ページに波及する領域
  l2_paths: [
    "**/layouts/**", "**/templates/**", "**/components/**",
    "**/*.css", "**/*.scss", "**/tailwind.config.*", "**/astro.config.*", "**/vite.config.*",
    "build.py", "**/build.py",
  ],
  thresholds: { l1_max_files: 5, l1_max_lines: 150 },
  // L0 でも例外的にコード扱いしたいパスがあればサイト側ポリシーで上書き
};

let policy = DEFAULT_POLICY;
const policyFile = resolve(CWD, POLICY_PATH);
if (existsSync(policyFile)) {
  try {
    const user = JSON.parse(readFileSync(policyFile, "utf8"));
    policy = {
      ...DEFAULT_POLICY,
      ...user,
      thresholds: { ...DEFAULT_POLICY.thresholds, ...(user.thresholds || {}) },
    };
  } catch (e) {
    console.error(`WARN: ${POLICY_PATH} のパースに失敗、内蔵デフォルトを使用: ${e.message}`);
  }
}

// ---------- 簡易グロブ (依存ゼロ; ** と * のみ対応) ----------
function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // "**/" は「0階層以上」、"**" 単体は「任意」
        if (glob[i + 2] === "/") { re += "(?:.*/)?"; i += 2; }
        else { re += ".*"; i += 1; }
      } else re += "[^/]*";
    } else if ("\\^$.|?+()[]{}".includes(c)) re += "\\" + c;
    else re += c;
  }
  return new RegExp(`^${re}$`, "i");
}
const matchers = Object.fromEntries(
  ["l3_paths", "l0_paths", "l2_paths"].map((k) => [k, (policy[k] || []).map(globToRegExp)])
);
const matches = (file, key) => matchers[key].some((re) => re.test(file));

// ---------- git 差分 ----------
function git(argv) {
  return execFileSync("git", argv, { cwd: CWD, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

let files = [];
let totalLines = 0;
let commitMsg = "";
try {
  const range = BASE ? [`${BASE}...${HEAD}`] : [HEAD, "--root"]; // BASE 無し = 初回コミット等
  const nameOut = BASE
    ? git(["diff", "--name-only", `${BASE}...${HEAD}`])
    : git(["show", "--name-only", "--format=", HEAD]);
  files = nameOut.split("\n").map((s) => s.trim()).filter(Boolean);

  const numstat = BASE
    ? git(["diff", "--numstat", `${BASE}...${HEAD}`])
    : git(["show", "--numstat", "--format=", HEAD]);
  for (const line of numstat.split("\n")) {
    const [add, del] = line.split("\t");
    if (add && add !== "-") totalLines += parseInt(add, 10) || 0;
    if (del && del !== "-") totalLines += parseInt(del, 10) || 0;
  }
  commitMsg = git(["log", "-1", "--format=%B", HEAD]).trim();
} catch (e) {
  console.error(`ERROR: git 差分の取得に失敗 (base=${BASE || "(none)"}, head=${HEAD}): ${e.message}`);
  console.error("安全側に倒して L2 とします。");
}

// ---------- 判定 ----------
const VALID = ["L0", "L1", "L2", "L3"];
let level = null;
let reason = "";

// 1. 手動オーバーライド
const tagMatch = commitMsg.match(/\[qa:(L[0-3])\]/i);
if (VALID.includes(OVERRIDE)) {
  level = OVERRIDE;
  reason = `手動オーバーライド (--override ${OVERRIDE})`;
} else if (tagMatch) {
  level = tagMatch[1].toUpperCase();
  reason = `コミットメッセージのタグ [qa:${level}]`;
}

// 2-5. 自動判定
if (!level) {
  if (files.length === 0) {
    level = "L2";
    reason = "差分を取得できなかったため安全側で L2 (マージ/空コミットなら手動で [qa:L0] 指定可)";
  } else {
    const l3hits = files.filter((f) => matches(f, "l3_paths"));
    const nonContent = files.filter((f) => !matches(f, "l0_paths"));
    const l2hits = files.filter((f) => matches(f, "l2_paths"));

    if (l3hits.length > 0) {
      level = "L3";
      reason = `セキュリティ敏感パスに変更: ${l3hits.slice(0, 5).join(", ")}${l3hits.length > 5 ? ` 他${l3hits.length - 5}件` : ""}`;
    } else if (nonContent.length === 0) {
      level = "L0";
      reason = `コンテンツ/データのみの変更 (${files.length}ファイル)`;
    } else if (l2hits.length > 0) {
      level = "L2";
      reason = `全ページ波及パスに変更: ${l2hits.slice(0, 5).join(", ")}`;
    } else {
      const t = policy.thresholds;
      if (files.length <= t.l1_max_files && totalLines <= t.l1_max_lines) {
        level = "L1";
        reason = `軽微なコード変更 (${files.length}ファイル / ${totalLines}行 ≤ ${t.l1_max_files}ファイル / ${t.l1_max_lines}行)`;
      } else {
        level = "L2";
        reason = `中規模以上のコード変更 (${files.length}ファイル / ${totalLines}行)`;
      }
    }
  }
}

// ---------- レベル → 実行ジョブ ----------
const n = VALID.indexOf(level);
const jobs = {
  run_secrets: true,            // 全レベル: シークレット混入は記事更新でも起こる事故
  run_lint: n >= 1,
  run_unit: n >= 1,
  run_build: n >= 1,
  run_e2e: n >= 2,
  run_links: n >= 2,
  run_lighthouse: n >= 2,
  run_sast: n >= 3,
  run_sca: n >= 3,
  run_dast: n >= 3,             // portal のみ有効化はワークフロー側で project_type と AND を取る
  needs_approval: n >= 3,
};

const result = { level, reason, files: files.length, lines: totalLines, ...jobs };

// ---------- 出力 ----------
if (process.env.GITHUB_OUTPUT) {
  // GITHUB_OUTPUT は key=value 形式のため、値の改行・= 崩れを防ぐサニタイズを挟む
  const clean = (v) => String(v).replace(/[\r\n]+/g, " ").slice(0, 500);
  const out = Object.entries(result)
    .map(([k, v]) => `${k}=${clean(v)}`)
    .join("\n") + "\n";
  writeFileSync(process.env.GITHUB_OUTPUT, out, { flag: "a" });
}
if (AS_JSON) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`QAレベル: ${level}`);
  console.log(`判定理由: ${reason}`);
  console.log(`変更規模: ${files.length}ファイル / ${totalLines}行`);
  console.log(`実行ジョブ: ${Object.entries(jobs).filter(([, v]) => v).map(([k]) => k.replace(/^run_|^needs_/, "")).join(", ")}`);
}
