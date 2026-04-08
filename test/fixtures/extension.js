// Shinkansen Playwright extension fixture
//
// 重要地雷（MV3 + Playwright）：
//   1. 必須用 chromium.launchPersistentContext(...)，普通 launch() 載不了 extension。
//   2. 必須 headed（headless: false），headless 下 service worker 會被 disabled，
//      content script 雖然會跑，但 background 路由會掛掉。
//   3. --disable-extensions-except 與 --load-extension 兩個都要給，
//      只給後者 Chrome 仍會嘗試載入其他 extension（雖然 user data dir 是空的，
//      還是依規矩走）。
//   4. 每次跑用獨立 temp user data dir，避免狀態殘留與平行衝突。
//      Playwright config 已經把 workers 鎖成 1，再加 temp dir 雙保險。
//
// 用法：
//   import { test, expect } from '../fixtures/extension.js';
//   test('xxx', async ({ context, extensionId }) => { ... });
import { test as base, chromium } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// repo 根目錄下的 shinkansen/ 資料夾就是 extension 本體
const EXTENSION_PATH = path.resolve(__dirname, '../../shinkansen');

export const test = base.extend({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    if (!fs.existsSync(path.join(EXTENSION_PATH, 'manifest.json'))) {
      throw new Error(`找不到 extension manifest：${EXTENSION_PATH}/manifest.json`);
    }

    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shinkansen-pw-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        '--no-first-run',
        '--no-default-browser-check',
      ],
    });

    await use(context);

    await context.close();
    // 清掉 temp user data dir
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  },

  // 取得 extension ID（從 service worker URL 解析）
  // 對 Edo 偵測測試而言不是必要的，但留著供後續測試使用
  extensionId: async ({ context }, use) => {
    let [worker] = context.serviceWorkers();
    if (!worker) {
      worker = await context.waitForEvent('serviceworker', { timeout: 10_000 });
    }
    const id = worker.url().split('/')[2];
    await use(id);
  },
});

export const expect = test.expect;
