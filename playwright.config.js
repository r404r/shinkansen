// Shinkansen 自動化測試的 Playwright 設定
// 注意事項（MV3 extension 的地雷）：
//   1. 必須用 launchPersistentContext，普通 launch() 載不了 extension
//   2. headless 模式下 service worker 會被 disabled，所以一律 headed
//   3. workers 必須是 1：每個 worker 都會開一個帶 user data dir 的瀏覽器，
//      平行跑會互踩 user data。
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test',
  // extension fixture 共用 user data dir，禁止平行
  workers: 1,
  fullyParallel: false,
  // 探查工具，不重試
  retries: 0,
  // Wikipedia 在台灣有時較慢，給寬一點
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    // 預設不擷圖、不錄影；個別 spec 需要時自行開
    screenshot: 'off',
    video: 'off',
    trace: 'off',
  },
});
