#!/usr/bin/env node
/**
 * check-headers.mjs — デプロイ済みサイトのセキュリティヘッダを検査する。
 *
 * 使い方:
 *   node check-headers.mjs --url https://example.com [--profile static|portal] [--json]
 *     [--retries 3] [--retry-wait 30]
 *
 * --retries N: FAIL または接続エラー時に --retry-wait 秒(デフォルト30)待って再検査、最大 N 回。
 *   デフォルト 0(=従来挙動)。デプロイ直後は Cloudflare Workers の新バージョンが
 *   エッジに伝播する前の旧レスポンスを検査して誤 FAIL することがあるため、
 *   post-deploy.yml はリトライ付きで呼ぶ。
 *
 * プロファイル:
 *   static — 公開メディアサイト(Cookie/会員なし)。CSP は推奨(WARN)扱い
 *   portal — 会員機能あり。CSP / HSTS 含めすべて必須(FAIL)扱い
 *
 * 検査基準は docs/qa-policy.md の「セキュリティヘッダ標準」参照(OWASP Secure Headers Project 準拠)。
 */
const args = process.argv.slice(2);
const opt = (name, def = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const URL_ARG = opt("url");
const PROFILE = opt("profile", "static");
const RETRIES = parseInt(opt("retries", "0"), 10);
const RETRY_WAIT_MS = parseInt(opt("retry-wait", "30"), 10) * 1000;
const AS_JSON = args.includes("--json");

if (!URL_ARG) {
  console.error("使い方: node check-headers.mjs --url https://example.com [--profile static|portal]");
  process.exit(2);
}

const isPortal = PROFILE === "portal";

const runChecks = async () => {
  const res = await fetch(URL_ARG, { redirect: "follow", headers: { "user-agent": "qa-standard-header-check/1.0" } });
  const h = Object.fromEntries([...res.headers.entries()].map(([k, v]) => [k.toLowerCase(), v]));

  const checks = [];
  const add = (name, ok, level, detail) => checks.push({ name, ok, level, detail });

  // --- 必須系 ---
  {
    const v = h["strict-transport-security"];
    const maxAge = v ? parseInt((v.match(/max-age=(\d+)/i) || [])[1] || "0", 10) : 0;
    add("Strict-Transport-Security", !!v && maxAge >= 31536000, "FAIL",
      v ? `${v} (max-age ${maxAge >= 31536000 ? "OK: ≥1年" : "不足: 1年(31536000)以上を推奨"})` : "未設定");
  }
  add("X-Content-Type-Options", (h["x-content-type-options"] || "").toLowerCase() === "nosniff", "FAIL",
    h["x-content-type-options"] || "未設定 (nosniff が必要)");
  {
    const csp = h["content-security-policy"] || "";
    const xfo = (h["x-frame-options"] || "").toUpperCase();
    const frameProtected = csp.includes("frame-ancestors") || xfo === "DENY" || xfo === "SAMEORIGIN";
    add("クリックジャッキング対策 (CSP frame-ancestors か X-Frame-Options)", frameProtected, "FAIL",
      frameProtected ? (csp.includes("frame-ancestors") ? "CSP frame-ancestors あり" : `X-Frame-Options: ${xfo}`) : "どちらも未設定");
  }
  add("Referrer-Policy", !!h["referrer-policy"], isPortal ? "FAIL" : "WARN",
    h["referrer-policy"] || "未設定 (strict-origin-when-cross-origin 推奨)");

  // --- CSP / Permissions-Policy ---
  add("Content-Security-Policy", !!h["content-security-policy"], isPortal ? "FAIL" : "WARN",
    h["content-security-policy"] ? h["content-security-policy"].slice(0, 120) + "…" : "未設定");
  add("Permissions-Policy", !!h["permissions-policy"], "WARN",
    h["permissions-policy"] ? h["permissions-policy"].slice(0, 120) : "未設定 (camera=(), microphone=(), geolocation=() 等の明示を推奨)");

  // --- 情報漏えい系(存在したら減点) ---
  add("X-Powered-By の除去", !h["x-powered-by"], "WARN", h["x-powered-by"] ? `露出: ${h["x-powered-by"]}` : "OK: 非露出");
  add("Server ヘッダの詳細版数非露出", !/\d/.test(h["server"] || ""), "WARN",
    h["server"] ? `Server: ${h["server"]}` : "OK: 非露出");

  // --- ポータルのみ: Cookie 属性 (Mozilla HTTP Observatory で最重量の減点項目: HttpOnly欠如-30 / Secure欠如-40) ---
  if (isPortal) {
    const setCookie = res.headers.getSetCookie?.() ?? (h["set-cookie"] ? [h["set-cookie"]] : []);
    if (setCookie.length > 0) {
      const bad = setCookie.filter((c) => !/;\s*secure/i.test(c) || !/;\s*httponly/i.test(c));
      add("Set-Cookie の Secure + HttpOnly", bad.length === 0, "FAIL",
        bad.length ? `不備 ${bad.length} 件: ${bad[0].split(";")[0]}=…` : `OK (${setCookie.length}件)`);
      const noSameSite = setCookie.filter((c) => !/;\s*samesite=/i.test(c));
      add("Set-Cookie の SameSite", noSameSite.length === 0, "WARN",
        noSameSite.length ? `SameSite 未指定 ${noSameSite.length} 件 (Lax 以上を明示推奨)` : "OK");
    }
  }

  // --- HTTPS リダイレクト ---
  try {
    const httpUrl = URL_ARG.replace(/^https:/, "http:");
    if (httpUrl !== URL_ARG) {
      const r = await fetch(httpUrl, { redirect: "manual" });
      const loc = r.headers.get("location") || "";
      add("HTTP→HTTPS リダイレクト", [301, 302, 308].includes(r.status) && loc.startsWith("https://"), "FAIL",
        `HTTP アクセス時: ${r.status} → ${loc || "(Location なし)"}`);
    }
  } catch { add("HTTP→HTTPS リダイレクト", true, "WARN", "HTTP ポート閉鎖 (問題なし)"); }

  return { status: res.status, checks };
};

// ---------- 実行 (失敗時はリトライ) ----------
let result = null;
let lastError = null;
let attempts = 0;
for (let i = 0; i <= RETRIES; i++) {
  attempts = i + 1;
  try {
    lastError = null;
    result = await runChecks();
  } catch (e) {
    lastError = e; // 接続エラーもエッジ伝播待ち・一時障害の可能性があるためリトライ対象
  }
  const needRetry = lastError || result.checks.some((c) => !c.ok && c.level === "FAIL");
  if (!needRetry || i === RETRIES) break;
  // 進捗は stderr へ (--json の stdout を汚さない)
  console.error(`⏳ ${lastError ? `接続エラー (${lastError.message})` : "FAILあり"}。エッジ伝播待ちの可能性があるため ${RETRY_WAIT_MS / 1000} 秒後に再検査 (リトライ ${i + 1}/${RETRIES})`);
  await new Promise((resolve) => setTimeout(resolve, RETRY_WAIT_MS));
}

if (lastError) {
  console.error(`❌ 接続エラーで検査できず (${attempts}回試行): ${lastError.message}`);
  process.exit(1);
}

// ---------- 出力 ----------
const { status, checks } = result;
const fails = checks.filter((c) => !c.ok && c.level === "FAIL");
const warns = checks.filter((c) => !c.ok && c.level === "WARN");

if (AS_JSON) {
  console.log(JSON.stringify({ url: URL_ARG, profile: PROFILE, status, fails: fails.length, warns: warns.length, attempts, checks }, null, 2));
} else {
  console.log(`# セキュリティヘッダ検査: ${URL_ARG} (profile=${PROFILE}, HTTP ${status})\n`);
  for (const c of checks) {
    const mark = c.ok ? "✅" : c.level === "FAIL" ? "❌" : "⚠️";
    console.log(`${mark} ${c.name}\n     ${c.detail}`);
  }
  console.log(`\n結果: FAIL ${fails.length} / WARN ${warns.length} / PASS ${checks.length - fails.length - warns.length}${attempts > 1 ? ` (${attempts}回目の検査で確定)` : ""}`);
}
process.exit(fails.length > 0 ? 1 : 0);
