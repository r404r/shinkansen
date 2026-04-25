// Regression: v1.5.0 dual-mode 譯文保留 <a href> 結構
//
// 結構特徵：原段落含 <a href> 等 inline 元素時，serialize 會產生 slots
// （e.g. ⟦0⟧our site⟦/0⟧），wrapper inner 必須走 deserializeWithPlaceholders
// 把連結結構與 href 完整重建，不能把連結文字塌陷成純文字。
//
// SANITY 紀錄（已驗證）：把 buildDualInner 的 slots 路徑替換為 plain text
// fallback（直接 createTextNode(stripStrayPlaceholderMarkers(translation))），
// wrapper 內 anchorCount=0、href 拿不到，spec fail；還原後 pass。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

test('dual-link: <p> 含 <a href> 注入後 wrapper 內仍有 <a> 與相同 href，譯文文字進入 anchor', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/dual.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#link-source', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // 譯文用 ⟦0⟧⟦/0⟧ 包住譯文版的 anchor 文字
  await evaluate(`(() => {
    const el = document.querySelector('#link-source');
    return window.__shinkansen.testInjectDual(el, '造訪⟦0⟧我們的網站⟦/0⟧今天。');
  })()`);

  const after = await page.evaluate(() => {
    const original = document.querySelector('#link-source');
    const wrapper = original.nextElementSibling;
    const inner = wrapper?.firstElementChild;
    if (!inner) return null;
    const anchorsInWrapper = inner.querySelectorAll('a');
    const firstAnchor = anchorsInWrapper[0];
    return {
      originalAnchorText: original.querySelector('a')?.textContent, // 原 anchor 文字未動
      wrapperInnerTag: inner.tagName,
      anchorCount: anchorsInWrapper.length,
      anchorHref:  firstAnchor?.getAttribute('href'),
      anchorText:  firstAnchor?.textContent,
      innerTextContent: inner.textContent,
      hasStrayMarkers: /⟦|⟧/.test(inner.textContent),
    };
  });

  expect(after, 'wrapper > inner 應存在').not.toBeNull();
  expect(after.originalAnchorText, '原 anchor 文字未動').toBe('our site');
  expect(after.wrapperInnerTag, 'inner = <p>').toBe('P');
  expect(after.anchorCount, 'wrapper 內仍有一個 <a>').toBe(1);
  expect(after.anchorHref, 'anchor href 完整保留').toBe('https://example.com');
  expect(after.anchorText, 'anchor 內譯文').toBe('我們的網站');
  expect(after.innerTextContent, 'inner 文字串連').toContain('造訪');
  expect(after.innerTextContent).toContain('我們的網站');
  expect(after.innerTextContent).toContain('今天。');
  expect(after.hasStrayMarkers, '不應有殘留的 ⟦⟧ 標記').toBe(false);

  await page.close();
});
