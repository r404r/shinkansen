// Regression: v1.8.8 ignorePartialMode 必須翻完所有 batch
//
// 鎖一件事:
//   translatePage({ ignorePartialMode: true }) 進到 translateUnits 時,內層
//   skipBatch1Plus 不可被 storage.partialMode.enabled=true 觸發。否則 22 批切完
//   只跑 batch 0 就 toast 「翻譯完成」,實際只翻 8 段。
//
// 觸發條件:使用者開 partialMode toggle、partialMode 翻完前 N 段後點「翻譯
// 剩餘段落」按鈕 → translatePage({ ignorePartialMode: true })。translatePage
// 主流程 pmActive=false,但下游 translateUnits 讀 storage.partialMode.enabled=true
// 後直接 skipBatch1Plus=true,只跑 batch 0 → 對使用者來說「toast 立刻完成、實際
// 大部分內容沒翻」。
//
// 驗證手段:wrap chrome.runtime.sendMessage 計算 TRANSLATE_BATCH 次數。
// 把 BATCH0_UNITS 跟 maxUnitsPerBatch 都壓到 2,5 段 fixture 切 3 批。
// 修正前:ignorePartialMode=true 下仍 skipBatch1Plus → 只送 1 個 batch 訊息(FAIL)
// 修正後:ignorePartialMode=true 跑完 3 批 → 送 3 個 batch 訊息(PASS)
//
// SANITY CHECK 紀錄(已驗證,2026-04-28):
//   把 content.js translateUnits 內 line 273 改回:
//     const firstBatchUnits = partialMode.enabled ? partialMode.maxUnits : SK.BATCH0_UNITS;
//   再把 line 448 改回:
//     const skipBatch1Plus = partialMode.enabled;
//   → ignorePartialMode=true 路徑只跑 1 批 → spec fail。
//   還原 v1.8.8 修法後 pass。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'translate-priority-sort';

test('translate-ignore-partial-mode-runs-all-batches: ignorePartialMode=true 下 skipBatch1Plus 不該被 storage partialMode 觸發', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('main#content-main', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  await evaluate(`
    // 壓低 batch 0 容量,讓 5 段 fixture 切多批
    window.__SK.BATCH0_UNITS = 2;
    window.__SK.BATCH0_CHARS = 100000;

    // mock storage:開 partialMode 模擬使用者開了「只翻文章開頭」
    chrome.storage.sync.get = async function(keys) {
      return {
        maxConcurrentBatches: 10,
        maxUnitsPerBatch: 2,
        maxCharsPerBatch: 100000,
        maxTranslateUnits: 1000,
        partialMode: { enabled: true, maxUnits: 2 },
        skipTraditionalChinesePage: false,
      };
    };
    chrome.storage.local.get = async function() { return {}; };

    // 計數 TRANSLATE_BATCH 訊息次數,並 mock 立即回成功
    window.__batchCount = 0;
    chrome.runtime.sendMessage = async function(msg) {
      if (msg && msg.type === 'TRANSLATE_BATCH_STREAM') return { ok: false };
      if (msg && msg.type === 'STREAMING_ABORT') return { ok: true };
      if (msg && msg.type === 'TRANSLATE_BATCH') {
        window.__batchCount += 1;
        const texts = (msg.payload && msg.payload.texts) || [];
        return {
          ok: true,
          result: texts.map(t => '[ZH] ' + t),
          usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0, costUSD: 0, billedInputTokens: 1, billedCostUSD: 0, cacheHits: 0 },
        };
      }
      return { ok: true };
    };

    // 模擬「使用者已翻過 partialMode」狀態,讓 ignorePartialMode 路徑能進入
    window.__SK.STATE.translated = true;
    window.__SK.STATE.partialModeActive = true;
  `);

  // 觸發「翻譯剩餘段落」路徑
  await evaluate(`
    (async () => {
      await window.__SK.translatePage({ ignorePartialMode: true });
    })().catch(e => null)
  `);

  // 等翻譯流程完成
  for (let i = 0; i < 30; i += 1) {
    const translating = await evaluate(`!!window.__SK.STATE.translating`);
    if (!translating) break;
    await page.waitForTimeout(200);
  }
  await page.waitForTimeout(500);

  const batchCount = await evaluate(`window.__batchCount`);
  expect(
    batchCount,
    `ignorePartialMode=true 應跑完所有 batch(預期 >= 2,實際 ${batchCount});若 = 1 代表 translateUnits 仍被 storage.partialMode 觸發 skipBatch1Plus`,
  ).toBeGreaterThanOrEqual(2);

  await page.close();
});
