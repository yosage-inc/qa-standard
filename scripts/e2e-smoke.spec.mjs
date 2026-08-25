/**
 * e2e-smoke.spec.mjs — 共通E2Eスモークテスト (Playwright)。
 *
 * サイト側にテストコードが無くても最低限のE2Eが回るよう、qa-standard が提供する汎用スペック。
 * 環境変数:
 *   SMOKE_BASE_URL  — テスト対象 (例: http://localhost:8788)
 *   SMOKE_PATHS     — カンマ区切りパス (例: "/,/about,/stores/tokyo")
 *
 * 各パスで検証すること:
 *   1. HTTP 200 で応答する
 *   2. <title> が空でない
 *   3. ページ内で JS エラー (pageerror) が発生しない
 *   4. console.error が発生しない (サードパーティ由来は許容リストで除外)
 *   5. ビューポート内の画像が壊れていない (naturalWidth > 0)
 *
 * 計測タグ(GA4/GTM/Clarity等)へのリクエストは route で abort する。
 * 本番URLに対して実行するとテストのアクセスが GA4/Clarity の実計測に混入するため
 * (UX台帳 T-001, 2026-08-11)。abort によるリソース読み込み失敗のコンソールエラーは
 * CONSOLE_ALLOWLIST 側で除外している。
 */
import { test, expect } from "@playwright/test";

const BASE = (process.env.SMOKE_BASE_URL || "http://localhost:8788").replace(/\/$/, "");
const PATHS = (process.env.SMOKE_PATHS || "/").split(",").map((s) => s.trim()).filter(Boolean);

// 計測系ホスト: このドメイン(サブドメイン含む)宛のリクエストはすべて遮断する
const TRACKING_HOSTS = [
  "googletagmanager.com",
  "google-analytics.com",
  "analytics.google.com",
  "clarity.ms",
  "doubleclick.net",
];

// サードパーティ起因で自サイトの品質と無関係なエラーはここで除外
const CONSOLE_ALLOWLIST = [/googletagmanager/i, /google-analytics/i, /analytics\.google/i, /clarity/i, /doubleclick/i, /favicon\.ico.*404/i];

// Chromiumのバージョンによっては console.error の text がURLを含まない
// ("Failed to load resource: net::ERR_BLOCKED_BY_CLIENT.Inspector" 等)。
// text だけでなく発生元URL (msg.location().url) も突き合わせて判定する。
function isAllowedConsoleError(msg) {
  const text = msg.text();
  const url = msg.location()?.url || "";
  if (CONSOLE_ALLOWLIST.some((re) => re.test(text) || re.test(url))) return true;
  // スペック自身が遮断した計測リクエスト起因のエラーは全て許容 (遮断は T-001 対策で意図的)
  try {
    const host = new URL(url).hostname;
    if (TRACKING_HOSTS.some((t) => host === t || host.endsWith(`.${t}`))) return true;
  } catch {}
  return false;
}

for (const path of PATHS) {
  test(`smoke: ${path}`, async ({ page }) => {
    const blockedRequests = [];
    await page.route("**/*", (route) => {
      let host = "";
      try {
        host = new URL(route.request().url()).hostname;
      } catch {
        return route.continue();
      }
      if (TRACKING_HOSTS.some((t) => host === t || host.endsWith(`.${t}`))) {
        blockedRequests.push(route.request().url());
        return route.abort("blockedbyclient");
      }
      return route.continue();
    });
    const pageErrors = [];
    const consoleErrors = [];
    page.on("pageerror", (e) => pageErrors.push(String(e)));
    page.on("console", (msg) => {
      if (msg.type() === "error" && !isAllowedConsoleError(msg)) {
        consoleErrors.push(`${msg.text()} (${msg.location()?.url || "url不明"})`);
      }
    });

    const res = await page.goto(BASE + path, { waitUntil: "load", timeout: 15000 });
    expect(res, `${path} が応答しない`).toBeTruthy();
    expect(res.status(), `${path} が HTTP ${res.status()}`).toBe(200);

    await expect(page).toHaveTitle(/.+/);

    const brokenImages = await page.$$eval("img", (imgs) =>
      imgs
        .filter((img) => img.loading !== "lazy" || img.complete)
        .filter((img) => img.complete && img.naturalWidth === 0 && img.src)
        .map((img) => img.src)
        .slice(0, 5)
    );
    expect(brokenImages, `壊れた画像: ${brokenImages.join(", ")}`).toHaveLength(0);
    expect(pageErrors, `JSエラー: ${pageErrors.join(" / ")}`).toHaveLength(0);
    expect(consoleErrors, `console.error: ${consoleErrors.join(" / ")}`).toHaveLength(0);

    if (blockedRequests.length > 0) {
      const hosts = [...new Set(blockedRequests.map((u) => new URL(u).hostname))];
      console.log(`[tracking-block] ${path}: 計測リクエスト ${blockedRequests.length} 件を遮断 (${hosts.join(", ")})`);
    }
  });
}
