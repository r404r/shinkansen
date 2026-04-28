// Regression: v1.8.7 ignorePartialMode 路徑
//
// 鎖一件事:
//   translatePage({ ignorePartialMode: true }) 在 STATE.translated=true 時不走
//   restorePage 早退,而是進到完整翻譯流程(會呼叫 collectParagraphs)。
//
// 這條路徑是「翻譯剩餘段落」按鈕觸發的——使用者開 partialMode toggle、翻完
// 開頭、想看完整篇時點按鈕 → translatePage({ ignorePartialMode: true })。
//
// 驗證手段:wrap SK.collectParagraphs 計次,看是否被呼叫到。如果路徑退化(STATE.translated
// 進來就 restorePage 早退),collectParagraphs 不會被呼叫,計數 = 0;正確走完整翻譯
// 流程則計數 >= 1。
//
// SANITY CHECK 紀錄(已驗證,2026-04-28):
//   把 content.js 內 `if (STATE.translated && !options.ignorePartialMode)` 改成
//   `if (STATE.translated)`(不檢查 ignorePartialMode)→ STATE.translated=true 進來
//   一律 restorePage,collectParagraphs 計數=0 → spec fail。還原後 pass。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'translate-priority-sort';

test('translate-partial-mode-ignore: ignorePartialMode=true + STATE.translated=true 不走 restorePage 早退', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('main#content-main', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // wrap collectParagraphs 計次
  await evaluate(`
    window.__collectCount = 0;
    const origCollect = window.__SK.collectParagraphs;
    window.__SK.collectParagraphs = function(...args) {
      window.__collectCount += 1;
      return origCollect.apply(this, args);
    };

    // mock storage: 開 partialMode 模擬使用者已配置節省模式
    chrome.storage.sync.get = async function(keys) {
      return {
        maxConcurrentBatches: 10,
        maxUnitsPerBatch: 10,
        maxCharsPerBatch: 100000,
        maxTranslateUnits: 1000,
        partialMode: { enabled: true, maxUnits: 8 },
        skipTraditionalChinesePage: false,
      };
    };

    // mock streaming + non-streaming 翻譯都立即回成功(不真的翻),
    // 重點是讓 translatePage 跑到 collectParagraphs 那一步
    chrome.runtime.sendMessage = async function(msg) {
      if (msg && msg.type === 'TRANSLATE_BATCH_STREAM') return { ok: false };
      if (msg && msg.type === 'STREAMING_ABORT') return { ok: true };
      if (msg && msg.type === 'TRANSLATE_BATCH') {
        const texts = (msg.payload && msg.payload.texts) || [];
        return {
          ok: true,
          result: texts.map(t => '[ZH] ' + t),
          usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0, costUSD: 0, billedInputTokens: 1, billedCostUSD: 0, cacheHits: 0 },
        };
      }
      return { ok: true };
    };

    // 模擬「使用者已翻過 partialMode」狀態
    window.__SK.STATE.translated = true;
    window.__SK.STATE.partialModeActive = true;
  `);

  // ── Test A: 不帶 ignorePartialMode → 應走 restorePage,collectParagraphs 不被呼叫 ──
  await evaluate(`
    (async () => {
      window.__collectCount = 0;
      await window.__SK.translatePage({});
    })().catch(e => null)
  `);
  await page.waitForTimeout(300);
  const countA = await evaluate(`window.__collectCount`);
  expect(
    countA,
    `不帶 ignorePartialMode 時應走 restorePage 早退,collectParagraphs 不被呼叫(實際 ${countA})`,
  ).toBe(0);

  // ── Test B: 帶 ignorePartialMode=true → 應跑完整流程,collectParagraphs 被呼叫 ──
  await evaluate(`
    window.__SK.STATE.translated = true;  // 重新設一次(restorePage 已重置成 false)
    window.__SK.STATE.partialModeActive = true;
    window.__collectCount = 0;
    (async () => {
      await window.__SK.translatePage({ ignorePartialMode: true });
    })().catch(e => null)
  `);
  await page.waitForTimeout(800);
  const countB = await evaluate(`window.__collectCount`);
  expect(
    countB,
    `ignorePartialMode=true 時不該走 restorePage 早退,collectParagraphs 應被呼叫(實際 ${countB});若退化代表豁免邏輯失效`,
  ).toBeGreaterThanOrEqual(1);

  await page.close();
});
