// Regression: v1.5.0 dual-mode 4 種 mark style attribute + computed 樣式
//
// 結構特徵：data-sk-mark 是 routing attribute；CSS 由 SK.ensureDualWrapperStyle
// 注入到 <head>。對每種 mark 驗證：(a) attribute 正確、(b) 對應 CSS 規則生效
// （以該 mark 最具代表性的 computed 樣式為斷言點）。
//
// SANITY 紀錄（已驗證）：
//   1. 把 SK.injectDual 內的 `wrapper.setAttribute('data-sk-mark', mark)`
//      改為 hardcode `'tint'`，bar/dashed/none 三種 attribute 全錯，spec fail；
//      還原後 pass。
//   2. 把 SK.ensureDualWrapperStyle 改為 no-op，computed style 全部變
//      browser default，spec fail；還原後 pass。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

test('dual-mark-style: 4 種 mark 各自 attribute + 對應 CSS 生效', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/dual.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#mark-tint', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // 對 4 個目標各自指定 mark style 注入
  await evaluate(`(() => {
    [['#mark-tint', 'tint'], ['#mark-bar', 'bar'],
     ['#mark-dashed', 'dashed'], ['#mark-none', 'none']]
    .forEach(([sel, mark]) => {
      const el = document.querySelector(sel);
      window.__shinkansen.testInjectDual(el, '譯文 ' + mark, { markStyle: mark });
    });
  })()`);

  const after = await page.evaluate(() => {
    const result = {};
    for (const [sel, mark] of [
      ['#mark-tint', 'tint'], ['#mark-bar', 'bar'],
      ['#mark-dashed', 'dashed'], ['#mark-none', 'none'],
    ]) {
      const wrapper = document.querySelector(sel)?.nextElementSibling;
      if (!wrapper) { result[mark] = null; continue; }
      const cs = window.getComputedStyle(wrapper);
      result[mark] = {
        attr: wrapper.getAttribute('data-sk-mark'),
        bgColor: cs.backgroundColor,
        borderLeftStyle: cs.borderLeftStyle,
        borderLeftWidth: cs.borderLeftWidth,
        borderBottomStyle: cs.borderBottomStyle,
        textDecorationLine: cs.textDecorationLine,
        textDecorationStyle: cs.textDecorationStyle,
        display: cs.display,
        borderRadius: cs.borderTopLeftRadius,
        paddingTop: cs.paddingTop,
        paddingRight: cs.paddingRight,
        paddingBottom: cs.paddingBottom,
        paddingLeft: cs.paddingLeft,
        boxSizing: cs.boxSizing,
      };
    }
    return result;
  });

  // attribute 正確
  expect(after.tint?.attr).toBe('tint');
  expect(after.bar?.attr).toBe('bar');
  expect(after.dashed?.attr).toBe('dashed');
  expect(after.none?.attr).toBe('none');

  // 共通：display:block
  for (const k of ['tint', 'bar', 'dashed', 'none']) {
    expect(after[k]?.display, `${k} wrapper 應為 display:block`).toBe('block');
  }

  // tint:背景色 #FFF8E1 = rgb(255, 248, 225)
  expect(after.tint?.bgColor).toBe('rgb(255, 248, 225)');
  // v1.8.31: tint padding 4 8 4 8、圓角 4px、border-box(避免文字貼塊邊 + 不溢出)
  expect(after.tint?.paddingTop).toBe('4px');
  expect(after.tint?.paddingRight).toBe('8px');
  expect(after.tint?.paddingBottom).toBe('4px');
  expect(after.tint?.paddingLeft).toBe('8px');
  expect(after.tint?.borderRadius).toBe('4px');
  expect(after.tint?.boxSizing).toBe('border-box');

  // bar：左邊細條 solid 2px
  expect(after.bar?.borderLeftStyle).toBe('solid');
  expect(after.bar?.borderLeftWidth).toBe('2px');

  // dashed：v1.5.3 起改為波浪底線 wavy（從 v1.5.0 的 border-bottom dashed 換）
  expect(after.dashed?.textDecorationLine).toBe('underline');
  expect(after.dashed?.textDecorationStyle).toBe('wavy');

  // none：背景透明 + 無左邊條 + 無底線（border-style 預設 'none' 或空）
  // rgba(0, 0, 0, 0) 是 transparent；'none' 是 border 預設
  expect(['rgba(0, 0, 0, 0)', 'transparent']).toContain(after.none?.bgColor);
  expect(after.none?.borderLeftStyle).toBe('none');
  expect(after.none?.borderBottomStyle).toBe('none');
  expect(after.none?.textDecorationLine).toBe('none');

  await page.close();
});
