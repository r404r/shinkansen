// Regression: v1.8.3 partialMode 「只翻文章開頭(節省費用)」
//
// 鎖兩件事:
//   1. partialMode.enabled=true 時 batch 0 用 partialMode.maxUnits 切批
//   2. 跑完 batch 0 後 batch 1+ **不被 dispatch**(節省 token)
//
// Mock 策略:
//   - storage.sync.get 回 partialMode={ enabled: true, maxUnits: 8 } + maxUnitsPerBatch=10
//   - 30 fake unit → 預期切批: batch 0 = 8u(partialMode 限制) / batch 1=10u / batch 2=10u / batch 3=2u
//     啟用後只該 dispatch batch 0,total TRANSLATE_BATCH_STREAM 計數 = 1,
//     且 fallback non-streaming 路徑下 TRANSLATE_BATCH 計數應為 0(全部跳過)
//   - 為了讓測試環境簡單,mock TRANSLATE_BATCH_STREAM 回 { ok: false } 觸發 fallback,
//     再驗證 fallback 路徑 batch 0 跑 + batch 1+ 不跑
//
// SANITY CHECK 紀錄(已驗證,2026-04-28):
//   把 content.js 內 `skipBatch1Plus = partialMode.enabled` 改成 false → batch 1+ 仍會 dispatch
//   → spec fail。還原後 pass。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'translate-priority-sort';

test('translate-partial-mode: enabled=true 時只跑 batch 0,batch 1+ 不被 dispatch', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('main#content-main', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  await evaluate(`
    window.__batchCallCount = 0;
    window.__batchSizes = [];
    window.__streamCount = 0;

    chrome.storage.sync.get = async function(keys) {
      return {
        maxConcurrentBatches: 10,
        maxUnitsPerBatch: 10,
        maxCharsPerBatch: 100000,
        partialMode: { enabled: true, maxUnits: 8 },
      };
    };

    chrome.runtime.sendMessage = async function(msg) {
      if (msg && msg.type === 'TRANSLATE_BATCH_STREAM') {
        window.__streamCount += 1;
        // 立刻回失敗,觸發 fallback 走 non-streaming 路徑(讓 spec 觀察 TRANSLATE_BATCH 行為)
        return { ok: false, error: 'streaming disabled in test' };
      }
      if (msg && msg.type === 'STREAMING_ABORT') {
        return { ok: true, aborted: false };
      }
      if (msg && msg.type === 'TRANSLATE_BATCH') {
        window.__batchCallCount += 1;
        window.__batchSizes.push((msg.payload && msg.payload.texts && msg.payload.texts.length) || 0);
        const texts = (msg.payload && msg.payload.texts) || [];
        return {
          ok: true,
          result: texts.map(t => '[ZH] ' + t),
          usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0, costUSD: 0, billedInputTokens: 1, billedCostUSD: 0, cacheHits: 0 },
        };
      }
      return { ok: true };
    };
  `);

  // 30 fake unit → partialMode.maxUnits=8 → batch 0=8 / batch 1=10 / batch 2=10 / batch 3=2 (4 批)
  // partialMode 啟用 → 只該跑 batch 0
  await evaluate(`
    (() => {
      const root = document.createElement('div');
      root.id = '__fake-root';
      for (let i = 0; i < 30; i++) {
        const p = document.createElement('p');
        p.textContent = 'fake unit ' + i + ' here we have some text to translate';
        root.appendChild(p);
      }
      document.body.appendChild(root);
      window.__fakeUnits = Array.from(root.children).map(el => ({ kind: 'element', el }));
      window.__translatePromise = window.__SK.translateUnits(window.__fakeUnits).catch(e => null);
      return null;
    })()
  `);

  // 等翻譯完成(streaming fail → fallback runBatch await 100ms;partialMode 跳過 batch 1+ → 整個流程約 200-300ms)
  await page.waitForTimeout(500);

  const result = await evaluate(`({
    streamCount: window.__streamCount,
    batchCallCount: window.__batchCallCount,
    batchSizes: window.__batchSizes,
  })`);

  // streaming 嘗試啟動一次(被 mock 失敗 → fallback)
  expect(result.streamCount, 'streaming 應嘗試啟動 1 次').toBe(1);

  // 關鍵斷言:fallback 路徑下,partialMode 啟用 → 只跑 batch 0(1 筆 TRANSLATE_BATCH)
  expect(
    result.batchCallCount,
    `partialMode.enabled=true 時應只 dispatch batch 0(1 筆 TRANSLATE_BATCH),實際 ${result.batchCallCount} 筆,size=${JSON.stringify(result.batchSizes)}`,
  ).toBe(1);

  // batch 0 size 應 = partialMode.maxUnits = 8
  expect(
    result.batchSizes[0],
    `batch 0 size 應為 partialMode.maxUnits=8,實際 ${result.batchSizes[0]}`,
  ).toBe(8);

  await page.close();
});
