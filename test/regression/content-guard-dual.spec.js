// Regression: v1.5.0 Content Guard dual 分支
//
// 結構特徵：dual 模式下 SPA framework（如 Engadget、各種 widget 重設容器）會
// 把 <shinkansen-translation> wrapper 從 DOM 上拔掉。Content Guard 必須遍歷
// STATE.translationCache（Map<originalEl, { wrapper, insertMode }>），對每個
// wrapper.isConnected===false 的條目，依當初的 insertMode 把同一個 wrapper
// element 重新插回去（不重新建立、不重新呼叫 LLM）。
//
// SANITY 紀錄（已驗證）：把 runContentGuardDual 的迴圈裡 isConnected 檢查
// 反向（continue if isConnected）後，只有「wrapper 還在」的條目被嘗試，被刪掉
// 的條目放著不管，wrapperRestored=0、wrapperBackInDom=false，spec fail；
// 還原後 pass。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

test('content-guard-dual: wrapper 被刪掉後 Content Guard 應依 insertMode 把同一 wrapper re-append', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/dual.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#basic', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // 1) 注入 dual
  await evaluate(`(() => {
    const el = document.querySelector('#basic');
    return window.__shinkansen.testInjectDual(el, '你好世界。');
  })()`);

  // 注入後 wrapper 應該在
  const afterInject = await page.evaluate(() => ({
    wrapperCount: document.querySelectorAll('shinkansen-translation').length,
  }));
  expect(afterInject.wrapperCount, '注入後應有 1 個 wrapper').toBe(1);

  // 2) 模擬 SPA framework 把 wrapper 從 DOM 拔掉（不刪除 wrapper element 本身）
  const removed = await page.evaluate(() => {
    const w = document.querySelector('shinkansen-translation');
    if (!w) return false;
    w.remove();  // 從 DOM 拔掉但 element 物件還在 STATE.translationCache 裡
    return true;
  });
  expect(removed).toBe(true);

  const afterRemove = await page.evaluate(() => ({
    wrapperCount: document.querySelectorAll('shinkansen-translation').length,
  }));
  expect(afterRemove.wrapperCount, '移除後 DOM 應無 wrapper').toBe(0);

  // 3) 觸發 Content Guard dual 分支
  const restoredCount = await evaluate(`window.__shinkansen.testRunContentGuard()`);
  expect(restoredCount, 'Content Guard 應修復 1 個 wrapper').toBe(1);

  // 4) 確認 wrapper 回到正確位置 + 譯文內容保留
  const afterGuard = await page.evaluate(() => {
    const original = document.querySelector('#basic');
    const next = original.nextElementSibling;
    return {
      wrapperBackInDom: next?.tagName.toLowerCase() === 'shinkansen-translation',
      wrapperParent:    next?.parentElement?.tagName,
      innerText: next?.firstElementChild?.textContent,
      wrapperCount: document.querySelectorAll('shinkansen-translation').length,
    };
  });
  expect(afterGuard.wrapperBackInDom, 'wrapper 應回到 #basic 的 nextSibling').toBe(true);
  expect(afterGuard.wrapperCount, '只有一個 wrapper（不是新建第二個）').toBe(1);
  expect(afterGuard.innerText, '譯文內容應原樣保留（同一個 wrapper element）').toBe('你好世界。');

  await page.close();
});
