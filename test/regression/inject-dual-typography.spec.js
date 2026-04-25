// Regression: v1.5.2 dual-mode typography copy
//
// 結構特徵：BBC 等網站把 paragraph typography 設在 `p` selector 上（非 body /
// 容器）。dual wrapper 在 block 段落情況下用 insertAdjacentElement('afterend')
// 插在原段落「後面」當 sibling，wrapper 內 inner 也不在原段落裡，所以**不會**
// 繼承到 `p` selector 設定的 font-family / font-size / font-weight /
// line-height / letter-spacing / color——必須主動 copy computed style。
//
// 真實案例：v1.5.1 之前在 BBC News 文章雙語模式下，譯文字距 / 行距明顯比原段落
// 緊，閱讀感降級。根因不是翻譯品質，而是 typography 沒繼承。
//
// SANITY 紀錄（已驗證）：把 buildDualInner 裡 typography copy 區塊整段註解掉
// （inner.style.fontFamily / fontSize / lineHeight / letterSpacing / color
// 都不寫），spec fail（inner 的 computed 字型回到 body 預設）；還原後 pass。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

test('dual-typography: wrapper inner 應 copy 原段落 font-family/size/weight/line-height/letter-spacing/color', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/dual.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#typography-source', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  await evaluate(`(() => {
    const el = document.querySelector('#typography-source');
    return window.__shinkansen.testInjectDual(el, '帶有自訂排版的原始段落。');
  })()`);

  const result = await page.evaluate(() => {
    const el = document.querySelector('#typography-source');
    const wrapper = el.nextElementSibling;
    const inner = wrapper?.firstElementChild;
    if (!inner) return null;
    const csOriginal = getComputedStyle(el);
    const csInner = getComputedStyle(inner);
    return {
      origFamily:        csOriginal.fontFamily,
      innerFamily:       csInner.fontFamily,
      origSize:          csOriginal.fontSize,
      innerSize:         csInner.fontSize,
      origWeight:        csOriginal.fontWeight,
      innerWeight:       csInner.fontWeight,
      origLineHeight:    csOriginal.lineHeight,
      innerLineHeight:   csInner.lineHeight,
      origLetterSpacing: csOriginal.letterSpacing,
      innerLetterSpacing:csInner.letterSpacing,
      origColor:         csOriginal.color,
      innerColor:        csInner.color,
      innerText:         inner.textContent,
    };
  });

  expect(result, 'wrapper > inner 應該存在').not.toBeNull();
  expect(result.innerText, '譯文應為「帶有自訂排版的原始段落。」').toBe('帶有自訂排版的原始段落。');

  // computed style 對齊：六個 typography 屬性 inner 都應跟原段落相同
  expect(result.innerFamily,        'font-family 應對齊原段落').toBe(result.origFamily);
  expect(result.innerSize,          'font-size 應對齊原段落').toBe(result.origSize);
  expect(result.innerWeight,        'font-weight 應對齊原段落').toBe(result.origWeight);
  expect(result.innerLineHeight,    'line-height 應對齊原段落').toBe(result.origLineHeight);
  expect(result.innerLetterSpacing, 'letter-spacing 應對齊原段落').toBe(result.origLetterSpacing);
  expect(result.innerColor,         'color 應對齊原段落').toBe(result.origColor);

  // 額外保險：fixture 的明確值應如預期，避免將來改 fixture style 沒同步斷言
  expect(result.origSize).toBe('20px');
  expect(result.origWeight).toBe('600');
  expect(result.origColor).toBe('rgb(50, 60, 70)');

  await page.close();
});
