#!/usr/bin/env node
/**
 * smoke-check.mjs — デプロイ直後の生存確認(スモークテスト)。
 *
 * 使い方:
 *   node smoke-check.mjs --base https://example.com --paths "/,/about,/stores/tokyo" [--json]
 *
 * 各パスについて: HTTP 200 / Content-Type が text/html / <title> が空でない / 応答 5 秒以内 を確認。
 * 1 つでも落ちたら exit 1 (デプロイ直後のロールバック判断に使う)。
 */
const args = process.argv.slice(2);
const opt = (name, def = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const BASE = (opt("base") || "").replace(/\/$/, "");
const PATHS = (opt("paths", "/") || "/").split(",").map((s) => s.trim()).filter(Boolean);
const TIMEOUT_MS = parseInt(opt("timeout", "5000"), 10);
const AS_JSON = args.includes("--json");

if (!BASE) {
  console.error('使い方: node smoke-check.mjs --base https://example.com --paths "/,/about"');
  process.exit(2);
}

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

const failed = results.filter((r) => !r.ok);
if (AS_JSON) {
  console.log(JSON.stringify({ base: BASE, total: results.length, failed: failed.length, results }, null, 2));
} else {
  console.log(`# スモークテスト: ${BASE}\n`);
  for (const r of results) {
    console.log(`${r.ok ? "✅" : "❌"} ${r.path}  [${r.status} / ${r.ms}ms] ${r.title ? `"${r.title.slice(0, 50)}"` : ""} ${r.error ? `— ${r.error}` : ""}`);
  }
  console.log(`\n結果: ${results.length - failed.length}/${results.length} OK`);
}
process.exit(failed.length > 0 ? 1 : 0);
