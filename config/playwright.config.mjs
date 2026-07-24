/**
 * qa-standard 共通 Playwright 設定 (E2E スモーク用)。
 * ワークフローが qa-standard を checkout し、この設定でサイトのビルド成果物に対して実行する。
 */
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "../scripts",
  testMatch: "e2e-smoke.spec.mjs",
  timeout: 30_000,
  retries: 1, // ネットワーク起因のフレーク対策で1回だけ再試行
  workers: 2,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
