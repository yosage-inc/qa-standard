#!/usr/bin/env node
/**
 * classify-release.test.mjs — classify-release.mjs の自己テスト(依存ゼロ)。
 *
 * 使い捨ての git リポジトリに履歴を作り、場面ごとに判定レベルを確かめる。
 * 特に「本番基準モード(--deployed-base)」で、L3 の実行中に積まれた L0 の push や、
 * 検査で落ちた変更の後の小さな修正が、低いレベルに落ちないことを確かめる。
 *
 *   node scripts/classify-release.test.mjs   (npm test)
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, appendFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CLASSIFY = join(dirname(fileURLToPath(import.meta.url)), "classify-release.mjs");
const dir = mkdtempSync(join(tmpdir(), "qa-classify-test-"));
const git = (...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8" }).trim();
const write = (f, s) => { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), s); };
const add = (f, s) => appendFileSync(join(dir, f), s);
const commit = (msg) => { git("add", "-A"); git("commit", "-q", "-m", msg); return git("rev-parse", "HEAD"); };

function classify(args) {
  const out = execFileSync("node", [CLASSIFY, ...args, "--cwd", dir, "--json"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, GITHUB_OUTPUT: "" },
  });
  return JSON.parse(out);
}

let failed = 0;
function expect(name, args, level, reasonIncludes) {
  const r = classify(args);
  const ok = r.level === level && (!reasonIncludes || r.reason.includes(reasonIncludes));
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}\n      → ${r.level} (${r.reason})${ok ? "" : `\n      期待: ${level}${reasonIncludes ? ` / 理由に「${reasonIncludes}」` : ""}`}`);
}

try {
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  git("config", "commit.gpgsign", "false");

  write("data/stores.csv", "a\n");
  write("src/x.js", "x\n");
  write(".github/workflows/qa.yml", "w\n");
  write("package.json", "{}\n");
  const P0 = commit("init");                       // 本番の検証済み(とする)
  add(".github/workflows/qa.yml", "w2\n");
  const X = commit("CI を変える");                 // L3 の変更(実行中 or 検査で落ちた)
  add("data/stores.csv", "b\n");
  const Y = commit("データ更新");                   // その上に積まれた L0 の push
  add("data/stores.csv", "c\n");
  const Z = commit("データ更新2 [qa:L0]");          // 下げるタグつき
  git("revert", "--no-edit", X);
  const R = git("rev-parse", "HEAD");               // 落ちた X を取り消す

  // --- 従来モード(--deployed-base なし)は直前の push との差分だけを見る ---
  expect("従来: 直前の push からデータだけ → L0(L3 の X が本番未反映でも見えない=穴)",
    ["--base", X, "--head", Y], "L0");
  expect("従来: 取り消し(revert)は CI ファイルに触れるので L3",
    ["--base", Z, "--head", R], "L3");
  expect("従来: 手動実行(--base なし)は head のコミットだけを見る",
    ["--base", "", "--head", Y], "L0");

  // --- 本番基準モード ---
  expect("本番=直前の push(通常): 従来と同じ L0",
    ["--base", X, "--head", Y, "--deployed-base", X], "L0", "本番の検証済み");
  expect("L3 の X が本番未反映のまま L0 を push → L3(穴を塞ぐ)",
    ["--base", X, "--head", Y, "--deployed-base", P0], "L3", "ほかの push の未検証の変更を含む");
  expect("下げるタグ [qa:L0] も、ほかの push の未検証の変更があれば効かない → L3",
    ["--base", Y, "--head", Z, "--deployed-base", P0], "L3", "引き下げに使えない");
  expect("自分の変更だけなら下げるタグは従来どおり効く → L0",
    ["--base", Y, "--head", Z, "--deployed-base", Y], "L0", "タグ [qa:L0]");
  expect("落ちた X を取り消した: 本番との差はデータだけ → L0(取り消しで流れが戻る)",
    ["--base", Z, "--head", R, "--deployed-base", P0], "L0");
  expect("本番の記録が無い(unknown) → L3",
    ["--base", X, "--head", Y, "--deployed-base", "unknown"], "L3", "記録が無い");
  expect("記録のコミットが読めない → L3",
    ["--base", X, "--head", Y, "--deployed-base", "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"], "L3", "取得できず");
  expect("手動実行: 未反映の L3 があると --override L1 では下げられない → L3",
    ["--base", "", "--head", Y, "--deployed-base", P0, "--override", "L1"], "L3", "引き下げに使えない");
  expect("手動実行: --override で上げるのは効く → L3",
    ["--base", "", "--head", Y, "--deployed-base", Y, "--override", "L3"], "L3", "手動オーバーライド");
  expect("手動実行: 本番と同じ中身なら --override L0 は効く",
    ["--base", "", "--head", Y, "--deployed-base", Y, "--override", "L0"], "L0");
  expect("手動実行: 本番と同じ中身(再ビルド)で指定なし → 安全側 L2",
    ["--base", "", "--head", Y, "--deployed-base", Y], "L2", "再ビルド");
  expect("デプロイ済みの先頭の再実行(本番と head が同じ): 未検証の変更なし → 下げるタグも効く",
    ["--base", Y, "--head", Z, "--deployed-base", Z], "L0", "タグ [qa:L0]");
  expect("古い実行の Re-run(head が本番より古い)→ 従来の判定(この実行はデプロイしない)",
    ["--base", P0, "--head", X, "--deployed-base", Z], "L3");

  // --- L3 の語の照合(2026-10-20): author(書き手)は L3 にしない。auth は語の位置・大小文字によらず L3 ---
  // 1コミット1ファイルで積み、直前のコミットとの差分(従来モード)で判定する
  let prev = R;
  const one = (file, msg) => { write(file, `${msg}\n`); const sha = commit(msg); const args = ["--base", prev, "--head", sha]; prev = sha; return args; };
  expect("authors(書き手)のコンテンツ → L0(旧グロブ **/*auth* では L3 だった)",
    one("src/content/authors/taro.md", "著者データ"), "L0");
  expect("data/authors.json → L0", one("data/authors.json", "著者一覧データ"), "L0");
  expect("authors.js はコードだが auth ではない → L1", one("src/authors.js", "著者一覧の JS"), "L1");
  expect("AuthorCard.js(camelCase の Author)→ L1", one("src/AuthorCard.js", "著者カード"), "L1");
  expect("coauthor.js(auth が語の途中)→ L1", one("src/lib/coauthor.js", "共著者"), "L1");
  expect("auth/ ディレクトリ → L3", one("src/auth/index.js", "認証"), "L3", "src/auth/index.js");
  expect("Auth.js(大文字始まり)→ L3", one("src/Auth.js", "認証2"), "L3", "src/Auth.js");
  expect("login-auth.js(- の後の auth)→ L3", one("scripts/login-auth.js", "ログイン認証"), "L3", "scripts/login-auth.js");
  expect("LoginAuth.js(camelCase の境目の Auth)→ L3", one("src/LoginAuth.js", "ログイン認証2"), "L3", "src/LoginAuth.js");
  expect("useAuth.js(小文字→大文字の山)→ L3", one("src/hooks/useAuth.js", "フック"), "L3", "src/hooks/useAuth.js");
  expect("authorize.js(authoriz は書き手ではない)→ L3", one("src/lib/authorize.js", "認可"), "L3", "src/lib/authorize.js");
  expect("authentication.js → L3", one("src/lib/authentication.js", "認証3"), "L3", "src/lib/authentication.js");
  expect("oauth.js(語頭は o だが語幹を明示)→ L3", one("src/lib/oauth.js", "OAuth"), "L3", "src/lib/oauth.js");
  expect("unauthorized.js → L3", one("src/pages/unauthorized.js", "401"), "L3", "src/pages/unauthorized.js");
  // 全部大文字の例は既存の src/Auth.js と別の名前にする(大小文字を区別しないファイルシステムでは同じファイルになる)
  expect("AUTHZ.JS(全部大文字)→ L3", one("src/api/AUTHZ.JS", "認可2"), "L3", "src/api/AUTHZ.JS");
  expect("auth の語とコンテンツを同時に → L3(語が優先)", (() => { write("data/stores.csv", "d\n"); return one("src/lib/auth-utils.js", "混在"); })(), "L3", "src/lib/auth-utils.js");
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} 件失敗` : "\n全件 PASS");
process.exit(failed ? 1 : 0);
