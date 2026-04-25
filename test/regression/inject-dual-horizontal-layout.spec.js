// Regression: v1.5.3 dual-mode wrapper 繼承原段落水平 layout
//
// 結構特徵：原 <p> 在某些網站（例如 macstories.net Newsletter）有 margin-left /
// padding-left 把段落擠到頁面中段，wrapper 是 sibling 注入後不繼承這些屬性，
// 譯文拉滿整行從左邊開始，視覺上跟原文不對齊。
//
// v1.5.2 typography copy 只搬字型相關 6 屬性（font-family/size/weight/line-height/
// letter-spacing/color），layout 屬性沒搬。
//
// 修法（content-inject.js injectDual）：建立 wrapper 後從 originalEl computed style
// 抓水平 layout 屬性 inline 寫到 wrapper：marginLeft / marginRight / paddingLeft /
// paddingRight / maxWidth。**不**動垂直方向（保留 wrapper 自有的 margin-top:0.25em
// 段間距與不固定 width）。
//
// SANITY 紀錄（已驗證）：把 v1.5.3 的「水平 layout copy」整段註解掉，wrapper 的
// computed marginLeft / paddingLeft 變回 0px，spec fail；還原後 pass。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

test('dual-horizontal-layout: wrapper 應 copy 原段落 margin-left/right、padding-left/right、max-width', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/dual.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#layout-source', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  await evaluate(`(() => {
    const el = document.querySelector('#layout-source');
    return window.__shinkansen.testInjectDual(el, '帶有水平偏移排版的段落。');
  })()`);

  const result = await page.evaluate(() => {
    const el = document.querySelector('#layout-source');
    const wrapper = el.nextElementSibling;
    if (!wrapper) return null;
    const csOriginal = getComputedStyle(el);
    const csWrapper = getComputedStyle(wrapper);
    return {
      origMarginLeft:    csOriginal.marginLeft,
      wrapperMarginLeft: csWrapper.marginLeft,
      origPaddingLeft:    csOriginal.paddingLeft,
      wrapperPaddingLeft: csWrapper.paddingLeft,
      origPaddingRight:    csOriginal.paddingRight,
      wrapperPaddingRight: csWrapper.paddingRight,
      origMaxWidth:    csOriginal.maxWidth,
      wrapperMaxWidth: csWrapper.maxWidth,
    };
  });

  expect(result, 'wrapper 應該存在').not.toBeNull();
  // 水平 layout 對齊
  expect(result.wrapperMarginLeft,   'wrapper margin-left 應對齊原段落').toBe(result.origMarginLeft);
  expect(result.wrapperPaddingLeft,  'wrapper padding-left 應對齊原段落').toBe(result.origPaddingLeft);
  expect(result.wrapperPaddingRight, 'wrapper padding-right 應對齊原段落').toBe(result.origPaddingRight);
  expect(result.wrapperMaxWidth,     'wrapper max-width 應對齊原段落').toBe(result.origMaxWidth);

  // 額外保險：fixture 的明確值確認
  expect(result.origMarginLeft).toBe('200px');
  expect(result.origPaddingLeft).toBe('30px');
  expect(result.origPaddingRight).toBe('40px');
  expect(result.origMaxWidth).toBe('600px');

  await page.close();
});
