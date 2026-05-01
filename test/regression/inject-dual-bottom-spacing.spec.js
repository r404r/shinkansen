// Regression: v1.8.31 dual-mode 譯文塊底色不溢出 + 段距保留
//
// 結構特徵:inner 是 <p>/<div> 等真實 tag,會被站點 `article p { padding-bottom }`
// 規則套到。padding 算進 inner box 內 → wrapper background 跟著延伸 → 視覺上
// 「底色超出文字一大塊」(Stratechery / Substack 一類站點都這樣)。
// 修法:inner reset padding/margin = 0,段距由 wrapper 自己 marginBottom mirror
// 原段落 padding-bottom + margin-bottom 補回。
//
// SANITY 紀錄(已驗證):
//   1. 把 buildDualInner 的 `inner.style.padding = '0'` / `inner.style.margin = '0'`
//      註解掉,inner inline style padding/margin 變空字串,spec fail;還原 pass。
//   2. 把 injectDual 的 wrapper.style.marginBottom 那段刪掉,wrapper computed
//      marginBottom 不再包含原段落 padding-bottom + margin-bottom (= 40px),
//      變回瀏覽器預設 0,spec fail;還原 pass。
//   3. 把 wrapper.style.marginTop = -pb 那行刪掉,wrapper marginTop 退回 CSS 預設
//      0.25em (= 4px),spec fail;還原 pass。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

test('dual-bottom-spacing: inner reset padding/margin + wrapper mirror 下方段距', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/dual.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#bottom-spacing-source', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  await evaluate(`(() => {
    const el = document.querySelector('#bottom-spacing-source');
    window.__shinkansen.testInjectDual(el, '譯文文字', { markStyle: 'tint' });
  })()`);

  const after = await page.evaluate(() => {
    const original = document.querySelector('#bottom-spacing-source');
    const wrapper = original.nextElementSibling;
    const inner = wrapper?.firstElementChild;
    if (!inner || !wrapper) return null;
    const wrapperCs = window.getComputedStyle(wrapper);
    return {
      // inner inline style 應 reset 為 0(不是 computed,要驗 inline 才能確定來自我們的 reset)
      innerInlinePadding: inner.style.padding,
      innerInlineMargin:  inner.style.margin,
      // wrapper computed marginBottom 應 ≥ 24 (padding-bottom) + 16 (margin-bottom) = 40px
      wrapperMarginBottom: wrapperCs.marginBottom,
      // wrapper computed marginTop 應為 -24px(抵消原段落 padding-bottom,讓譯文塊黏著原文)
      wrapperMarginTop: wrapperCs.marginTop,
      // inner 仍是 P
      innerTag: inner.tagName,
    };
  });

  expect(after).not.toBeNull();
  expect(after.innerTag).toBe('P');
  // inline padding/margin reset 為 '0'
  expect(after.innerInlinePadding).toBe('0px');
  expect(after.innerInlineMargin).toBe('0px');
  // wrapper marginBottom mirror 原段落 24+16=40px
  expect(after.wrapperMarginBottom).toBe('40px');
  // v1.8.31: wrapper marginTop = -原段落 padding-bottom (= -24px)
  // 不抵消 marginBottom(歷史教訓:抵消 marginBottom 在 list 兄弟結構會造成
  // 譯文塊跟下一個 li 重疊,Daring Fireball sidebar 已踩過)
  expect(after.wrapperMarginTop).toBe('-24px');

  await page.close();
});
