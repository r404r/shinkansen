// Regression: v1.5.3 restorePage 必須清掉 data-shinkansen-dual-source attribute
//
// 真實 bug：Jimmy 在使用快速鍵 Opt+A 觀察到「翻譯（雙語）→ 還原 → 再翻譯」
// 第三次只看到原文不會進入雙語對照。根因：restorePage 的 dual 分支手寫
// `querySelectorAll(tag).forEach(n => n.remove())` 只刪 wrapper，**沒清**
// 原段落上的 data-shinkansen-dual-source attribute。第二次 translatePage 時：
// collectParagraphs 抓到原段落 → injectDual 入口
// `if (original.hasAttribute('data-shinkansen-dual-source')) return;` 命中 →
// 所有段落早期 return → 沒注入 → 使用者只看到原文。
//
// 對比：testRestoreDual debug API 呼叫 SK.removeDualWrappers（已正確清 attribute），
// 所以既有 inject-dual-restore.spec.js 用 testRestoreDual 過了——但沒覆蓋到實際
// bug（restorePage 跟 testRestoreDual 邏輯不一致）。
//
// 修法（content.js restorePage dual 分支）：改呼叫 SK.removeDualWrappers()，
// 邏輯與 testRestoreDual 統一。
//
// SANITY 紀錄（已驗證）：把 restorePage dual 分支改回手寫 querySelectorAll
// 只刪 wrapper 不清 attribute，第二次 inject 後 wrapperCount 仍為 0（因為被
// dual-source guard 早期 return），spec fail；還原後 pass。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

test('restore-page-clears-dual-attr: restorePage 後再次 inject 應成功（attribute 不殘留）', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/dual.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#basic', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // 1) 第一次注入
  await evaluate(`(() => {
    const el = document.querySelector('#basic');
    return window.__shinkansen.testInjectDual(el, '你好世界。');
  })()`);

  const afterFirstInject = await page.evaluate(() => ({
    wrapperCount: document.querySelectorAll('shinkansen-translation').length,
    attr: document.querySelector('#basic').getAttribute('data-shinkansen-dual-source'),
  }));
  expect(afterFirstInject.wrapperCount).toBe(1);
  expect(afterFirstInject.attr).toBe('1');

  // 2) 呼叫真正的 restorePage（不是 testRestoreDual——後者已正確清 attribute）
  await evaluate(`window.__shinkansen.testRestorePage()`);

  const afterRestore = await page.evaluate(() => ({
    wrapperCount: document.querySelectorAll('shinkansen-translation').length,
    attr: document.querySelector('#basic').getAttribute('data-shinkansen-dual-source'),
  }));
  expect(afterRestore.wrapperCount, 'restorePage 後 wrapper 應全部移除').toBe(0);
  expect(afterRestore.attr, 'restorePage 後原段落 attribute 應清空').toBeNull();

  // 3) 第二次注入——attribute 殘留會讓 injectDual 早期 return，這是 bug 的精準觀察點
  await evaluate(`(() => {
    const el = document.querySelector('#basic');
    return window.__shinkansen.testInjectDual(el, '你好世界第二次。');
  })()`);

  const afterSecondInject = await page.evaluate(() => ({
    wrapperCount: document.querySelectorAll('shinkansen-translation').length,
    innerText: document.querySelector('shinkansen-translation > p')?.textContent,
    attr: document.querySelector('#basic').getAttribute('data-shinkansen-dual-source'),
  }));
  expect(afterSecondInject.wrapperCount, '第二次注入應成功（不被 attribute guard 擋下）').toBe(1);
  expect(afterSecondInject.innerText, '第二次譯文應正確顯示').toBe('你好世界第二次。');
  expect(afterSecondInject.attr).toBe('1');

  await page.close();
});
