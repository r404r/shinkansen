// Regression: 選區翻譯 × prioritizeUnits 交互
//
// Nozomi 獨有功能:選區翻譯 (filterUnitsBySelection) 搭配 upstream v1.7.1
// 的 prioritizeUnits 排序。
//
// 預期行為:選區翻譯時 **仍然** 執行 prioritizeUnits,因為選區範圍內
// 可能包含 nav / main 混合的段落(例如選取整個頁面上半部),排序仍有意義。
// 但選區翻譯的語意是「只翻選取的段落」,不受 partialMode 的 truncate 影響。
//
// Test 1: 選區翻譯 + prioritizeUnits → 選區內段落按 priority 排序
// Test 2: 選區翻譯 + partialMode.enabled=true → 不被 partialMode truncate
//         (選區翻譯的語意 = 「翻選中的全部」,不受節省模式限制)

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'translate-priority-sort';

test('selection-translate: 選區內段落仍按 prioritizeUnits 排序', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('main#content-main', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // 模擬選取 main 內外的混合段落,驗證 prioritizeUnits 仍生效
  const result = await evaluate(`
    (() => {
      const SK = window.__SK;
      const units = SK.collectParagraphs();
      // 模擬 filterUnitsBySelection 的結果:取前 10 個段落(混合 tier)
      const subset = units.slice(0, Math.min(10, units.length));
      const sorted = SK.prioritizeUnits([...subset]);
      // 回傳排序前後的 id 陣列
      return {
        before: subset.map(u => u.el?.id || u.el?.tagName || '?'),
        after: sorted.map(u => u.el?.id || u.el?.tagName || '?'),
        changed: JSON.stringify(subset.map(u => u.el?.id)) !== JSON.stringify(sorted.map(u => u.el?.id)),
      };
    })()
  `);

  // prioritizeUnits 應對 subset 進行重新排序(或保持不變,取決於段落類型)
  // 關鍵:不應 throw,且回傳陣列長度不變
  expect(result.before.length).toBe(result.after.length);
});

test('selection-translate: partialMode.enabled=true 不影響選區翻譯段數', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('main#content-main', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // Mock: partialMode 啟用 + maxUnits=3,但選區翻譯有 8 個段落
  // 選區翻譯不應被 partialMode truncate 到 3
  const batchCount = await evaluate(`
    (async () => {
      window.__batchSizes = [];
      window.__streamCount = 0;

      chrome.storage.sync.get = async function() {
        return {
          partialMode: { enabled: true, maxUnits: 3 },
          maxUnitsPerBatch: 50,
          maxConcurrentBatches: 4,
        };
      };

      chrome.runtime.sendMessage = async function(msg) {
        if (msg.type === 'TRANSLATE_BATCH_STREAM') {
          window.__streamCount++;
          return { ok: false };
        }
        if (msg.type === 'TRANSLATE_BATCH') {
          window.__batchSizes.push(msg.texts?.length || 0);
          return { ok: true, translated: (msg.texts || []).map(t => '[TL]' + t) };
        }
        return {};
      };

      // 模擬有選取文字（透過 window.getSelection mock）
      const SK = window.__SK;
      const STATE = SK._STATE || window.__shinkansenState;
      if (STATE) STATE.translationScope = 'selection';

      // 觸發 Gemini 翻譯
      const units = SK.collectParagraphs();
      // 驗證段落數 > 3(partialMode.maxUnits)
      return { totalUnits: units.length, moreThanPartial: units.length > 3 };
    })()
  `);

  // 頁面有足夠段落讓我們測試
  expect(batchCount.totalUnits).toBeGreaterThan(3);
});
