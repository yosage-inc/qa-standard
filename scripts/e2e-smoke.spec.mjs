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
 */
import { test, expect } from "@playwright/test";

const BASE = (process.env.SMOKE_BASE_URL || "http://localhost:8788").replace(/\/$/, "");
const PATHS = (process.env.SMOKE_PATHS || "/").split(",").map((s) => s.trim()).filter(Boolean);

// サードパーティ起因で自サイトの品質と無関係なエラーはここで除外
const CONSOLE_ALLOWLIST = [/googletagmanager/i, /google-analytics/i, /doubleclick/i, /favicon\.ico.*404/i];

for (const path of PATHS) {
  test(`smoke: ${path}`, async ({ page }) => {
    const pageErrors = [];
    const consoleErrors = [];
    page.on("pageerror", (e) => pageErrors.push(String(e)));
    page.on("console", (msg) => {
      if (msg.type() === "error" && !CONSOLE_ALLOWLIST.some((re) => re.test(msg.text()))) {
        consoleErrors.push(msg.text());
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
  });
}
