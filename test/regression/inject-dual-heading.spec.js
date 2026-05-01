// Regression: v1.5.0 dual-mode <h1>–<h6> 字級繼承
//
// 結構特徵：heading 不應在 wrapper 內被當成另一個 h1（避免重複標題、SEO/AT 問題），
// 改用 <div> 並把 font-size / font-weight / line-height 從原 heading 繼承過來，
// 讓視覺階層保留。
//
// SANITY 紀錄（已驗證）：把 buildDualInner 的 H1-H6 分支 copyHeadingStyle 設為
// false（不繼承字級），inner.style.fontSize 變空字串，spec fail；還原後 pass。
//
// v1.8.31 新增「標題後 wrapper margin-top 加大」斷言:
//   :where(h1..h6) + shinkansen-translation 套 margin-top: 0.5em (= 8px)
//   原 0.25em(4px)在大字級標題 line-height 會被吃光,標題與譯文視覺零間距。
//   SANITY:把 ensureDualWrapperStyle 那條 selector 砍掉,marginTop 退回 0.25em(4px),斷言 fail;還原 pass。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

test('dual-heading: <h1> 注入後 wrapper inner = <div>，字級從原 heading 繼承', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/dual.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#heading', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  await evaluate(`(() => {
    const el = document.querySelector('#heading');
    return window.__shinkansen.testInjectDual(el, '標題文字');
  })()`);

  const after = await page.evaluate(() => {
    const el = document.querySelector('#heading');
    const wrapper = el.nextElementSibling;
    const inner = wrapper?.firstElementChild;
    if (!inner) return null;
    const wrapperCs = window.getComputedStyle(wrapper);
    return {
      originalTag: el.tagName,
      originalText: el.textContent,
      innerTag: inner.tagName,
      innerText: inner.textContent,
      // 抓 inline style（這是我們從 computed 設過去的）
      inlineFontSize:   inner.style.fontSize,
      inlineFontWeight: inner.style.fontWeight,
      inlineLineHeight: inner.style.lineHeight,
      // v1.8.31: heading 後 wrapper 的 margin-top
      wrapperMarginTop: wrapperCs.marginTop,
    };
  });

  expect(after, 'wrapper > inner 應該存在').not.toBeNull();
  expect(after.originalTag, '原 heading 仍是 H1').toBe('H1');
  expect(after.originalText, '原 heading 文字未動').toBe('Title text');
  expect(after.innerTag, 'wrapper 內 tag 應為 DIV，不是 H1').toBe('DIV');
  expect(after.innerText, 'wrapper 內譯文').toBe('標題文字');

  // 字級繼承：3 個 inline style 都應該被設定（非空字串）
  expect(after.inlineFontSize,   'fontSize 應從原 heading 繼承').not.toBe('');
  expect(after.inlineFontWeight, 'fontWeight 應從原 heading 繼承').not.toBe('');
  expect(after.inlineLineHeight, 'lineHeight 應從原 heading 繼承').not.toBe('');

  // computed fontSize 應該大致跟原始 28px 一致（heading downgrade 不該縮小視覺尺寸）
  // 用 inline style 比較，避免單位差異造成誤判
  expect(after.inlineFontSize).toMatch(/28(\.0+)?px/);
  expect(after.inlineFontWeight).toBe('700');

  // v1.8.31: 標題後 wrapper margin-top: 0.5em
  // wrapper 自身字級(無設定)= 預設 16px → 0.5em = 8px
  // 退回 0.25em 會是 4px。容忍小數浮點寫法。
  // (注意:H1 fixture 沒 inline padding/margin → user-agent margin-bottom 會跟
  // wrapper marginTop margin collapse,但 getComputedStyle 回傳的是 declared
  // value,不算 collapse 結果。所以這裡測的是 8px。)
  expect(after.wrapperMarginTop).toMatch(/^8(\.0+)?px$/);

  await page.close();
});
