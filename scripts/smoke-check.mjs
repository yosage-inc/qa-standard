#!/usr/bin/env node
/**
 * smoke-check.mjs — デプロイ直後の生存確認(スモークテスト)。
 *
 * 使い方:
 *   node smoke-check.mjs --base https://example.com --paths "/,/about,/stores/tokyo" [--json]
 *     [--retries 3] [--retry-wait 30]
 *
 * 各パスについて: HTTP 200 / Content-Type が text/html / <title> が空でない / 応答 5 秒以内 を確認。
 * 1 つでも落ちたら exit 1 (デプロイ直後のロールバック判断に使う)。
 *
 * --retries N: 失敗時に --retry-wait 秒(デフォルト30)待って全パスを再検査、最大 N 回。デフォルト 0(=従来挙動)。
 *   デプロイ直後は Cloudflare Workers の新バージョンがエッジに伝播する前の旧レスポンスを
 *   検査して誤 FAIL することがあるため、post-deploy.yml はリトライ付きで呼ぶ。
 */
const args = process.argv.slice(2);
const opt = (name, def = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const BASE = (opt("base") || "").replace(/\/$/, "");
const PATHS = (opt("paths", "/") || "/").split(",").map((s) => s.trim()).filter(Boolean);
const TIMEOUT_MS = parseInt(opt("timeout", "5000"), 10);
const RETRIES = parseInt(opt("retries", "0"), 10);
const RETRY_WAIT_MS = parseInt(opt("retry-wait", "30"), 10) * 1000;
const AS_JSON = args.includes("--json");

if (!BASE) {
  console.error('使い方: node smoke-check.mjs --base https://example.com --paths "/,/about"');
  process.exit(2);
}

const checkAll = async () => {
  const results = [];
  for (const p of PATHS) {
    const url = BASE + (p.startsWith("/") ? p : `/${p}`);
    const started = Date.now();
    const r = { path: p, url, ok: false, status: 0, ms: 0, title: "", error: "" };
    try {
      const res = await fetch(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { "user-agent": "qa-standard-smoke/1.0" },
      });
      r.ms = Date.now() - started;
      r.status = res.status;
      const ct = res.headers.get("content-type") || "";
      const html = ct.includes("text/html") ? await res.text() : "";
      r.title = (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1]?.trim() || "";
      const problems = [];
      if (res.status !== 200) problems.push(`HTTP ${res.status}`);
      if (!ct.includes("text/html")) problems.push(`Content-Type: ${ct || "(なし)"}`);
      else if (!r.title) problems.push("<title> が空");
      if (r.ms > TIMEOUT_MS) problems.push(`応答 ${r.ms}ms`);
      r.ok = problems.length === 0;
      r.error = problems.join(", ");
    } catch (e) {
      r.ms = Date.now() - started;
      r.error = e.name === "TimeoutError" ? `タイムアウト (${TIMEOUT_MS}ms)` : e.message;
    }
    results.push(r);
  }
  return results;
};

let attempts = 1;
let results = await checkAll();
while (results.some((r) => !r.ok) && attempts <= RETRIES) {
  // 進捗は stderr へ (--json の stdout を汚さない)
  console.error(`⏳ 失敗あり。エッジ伝播待ちの可能性があるため ${RETRY_WAIT_MS / 1000} 秒後に再検査 (リトライ ${attempts}/${RETRIES})`);
  await new Promise((resolve) => setTimeout(resolve, RETRY_WAIT_MS));
  results = await checkAll();
  attempts++;
}

const failed = results.filter((r) => !r.ok);
if (AS_JSON) {
  console.log(JSON.stringify({ base: BASE, total: results.length, failed: failed.length, attempts, results }, null, 2));
} else {
  console.log(`# スモークテスト: ${BASE}\n`);
  for (const r of results) {
    console.log(`${r.ok ? "✅" : "❌"} ${r.path}  [${r.status} / ${r.ms}ms] ${r.title ? `"${r.title.slice(0, 50)}"` : ""} ${r.error ? `— ${r.error}` : ""}`);
  }
  console.log(`\n結果: ${results.length - failed.length}/${results.length} OK${attempts > 1 ? ` (${attempts}回目の検査で確定)` : ""}`);
}
process.exit(failed.length > 0 ? 1 : 0);
