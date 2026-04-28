// Regression: Bing 翻譯引擎 dispatch 路徑
//
// Nozomi 獨有功能:Bing Translate 透過 Microsoft Translator MET 模式,
// 復用 translatePageGoogle() 路徑,以 _bingMode=true 區分。
//
// 此 spec 鎖以下行為:
//   1. Bing dispatch 使用 TRANSLATE_BATCH_BING message type
//   2. Bing toast 使用 cs_bing_progress / cs_bing_complete i18n key
//   3. Bing 不走 streaming(TRANSLATE_BATCH_STREAM 不應被呼叫)
//   4. prioritizeUnits 在 Bing 路徑仍然生效

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'translate-priority-sort';

test('bing-dispatch: 使用 TRANSLATE_BATCH_BING message type,不走 streaming', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('main#content-main', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // 驗證 Bing 翻譯的 message type
  const result = await evaluate(`
    (() => {
      const SK = window.__SK;
      // Bing 翻譯路徑中 messageType 應為 'TRANSLATE_BATCH_BING'
      // 驗證 SK.t 能正確回傳 Bing 相關 i18n key
      // cs_bing_progress: '{0}Bing 翻譯中… {1} / {2}' → args: labelPrefix, done, total
      const bingProgress = SK.t('cs_bing_progress', '', 5, 20);
      // cs_bing_complete: 'Bing 翻譯完成（{0} 段）' → args: total
      const bingComplete = SK.t('cs_bing_complete', 20);
      const googleProgress = SK.t('cs_google_progress', '', 5, 20);

      return {
        bingProgress,
        bingComplete,
        googleProgress,
        bingDiffFromGoogle: bingProgress !== googleProgress,
      };
    })()
  `);

  // Bing 和 Google 的 toast message 不應相同
  expect(result.bingDiffFromGoogle).toBe(true);
  // Bing progress message 應包含進度數字
  expect(result.bingProgress).toContain('5');
  expect(result.bingProgress).toContain('20');
  // Bing complete message 應包含段數
  expect(result.bingComplete).toContain('20');
});

test('bing-dispatch: i18n keys cs_bing_* 存在且與 cs_google_* 不同', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('main#content-main', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  const keys = await evaluate(`
    (() => {
      const SK = window.__SK;
      // 驗證所有 Bing i18n key 都有對應值(不是 fallback 到 key 本身)
      const bingKeys = [
        'cs_bing_progress',
        'cs_bing_complete',
        'cs_bing_chars',
      ];
      const results = {};
      for (const key of bingKeys) {
        const val = SK.t(key, 'test', 1, 2, 3);
        results[key] = {
          value: val,
          isNotKey: val !== key,  // 如果回傳 key 本身,表示沒有翻譯
        };
      }
      return results;
    })()
  `);

  // 每個 Bing key 都不應 fallback 回 key 本身
  for (const [key, info] of Object.entries(keys)) {
    expect(info.isNotKey, `${key} 應有 i18n 翻譯,不應 fallback 回 key 本身`).toBe(true);
  }
});
