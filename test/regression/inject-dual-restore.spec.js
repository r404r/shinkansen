// Regression: v1.5.0 dual-mode 還原機制
//
// 結構特徵：dual 模式還原 = 移除所有 <shinkansen-translation>、清掉
// data-shinkansen-dual-source attribute、清空 STATE.translationCache。
// 原段落 textContent / innerHTML 完全未動（因為原文沒被覆寫過）。
//
// SANITY 紀錄（已驗證）：把 SK.removeDualWrappers 改成 no-op，wrapper 仍存在
// 於 DOM，spec 的 `wrapperCount` 斷言 fail（>0）；還原後 pass。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

test('dual-restore: 注入後呼叫 testRestoreDual 應移除所有 wrapper、原段落不動', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/dual.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#restore-source', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  const originalHtmlBefore = await page.evaluate(() =>
    document.querySelector('#restore-source').innerHTML);

  await evaluate(`(() => {
    const el = document.querySelector('#restore-source');
    return window.__shinkansen.testInjectDual(el, '把我還原。');
  })()`);

  // 注入後確認 wrapper 在
  const mid = await page.evaluate(() => ({
    wrapperCount: document.querySelectorAll('shinkansen-translation').length,
    originalAttr: document.querySelector('#restore-source')
      .getAttribute('data-shinkansen-dual-source'),
  }));
  expect(mid.wrapperCount).toBeGreaterThan(0);
  expect(mid.originalAttr).toBe('1');

  // 還原
  await evaluate(`window.__shinkansen.testRestoreDual()`);

  const after = await page.evaluate(() => {
    const el = document.querySelector('#restore-source');
    return {
      wrapperCount: document.querySelectorAll('shinkansen-translation').length,
      originalAttr: el.getAttribute('data-shinkansen-dual-source'),
      originalHTML: el.innerHTML,
      originalText: el.textContent,
    };
  });

  expect(after.wrapperCount, '所有 wrapper 應被移除').toBe(0);
  expect(after.originalAttr, 'data-shinkansen-dual-source 應被清掉').toBeNull();
  expect(after.originalHTML, '原段落 innerHTML 應與注入前相同').toBe(originalHtmlBefore);
  expect(after.originalText, '原段落文字未動').toBe('Restore me.');

  await page.close();
});
