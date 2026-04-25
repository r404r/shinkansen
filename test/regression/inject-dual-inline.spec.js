// Regression: v1.5.0 dual-mode inline 段落 wrapper 放在 block 祖先後
//
// 結構特徵：被偵測為段落的 inline 元素（例如 <span>，常見於 Twitter card）
// wrapper 不能放在 inline 自身後面（會跑進 inline flow 中），必須往上找最近的
// block 祖先（computed display ∈ {block, flex, grid, table, list-item, flow-root}），
// 把 wrapper 放在 block 祖先的 afterend。
//
// SANITY 紀錄（已驗證）：把 inline 分支的 findBlockAncestor 結果忽略、改用
// `original.insertAdjacentElement('afterend', wrapper)`，wrapper.parentElement
// 變成 #inline-parent (P)，不是 #inline-container (DIV)，spec fail；還原後 pass。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

test('dual-inline: span 段落 wrapper 應放在最近 block 祖先（<p>）的 afterend', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/dual.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#inline-target', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  await evaluate(`(() => {
    const el = document.querySelector('#inline-target');
    return window.__shinkansen.testInjectDual(el, '重要片語');
  })()`);

  const after = await page.evaluate(() => {
    const span = document.querySelector('#inline-target');
    const parent = document.querySelector('#inline-parent');
    const container = document.querySelector('#inline-container');
    // 在整個 #inline-container 內找 wrapper
    const wrapper = container.querySelector('shinkansen-translation');
    return {
      spanText: span.textContent,                     // 原 span 文字未動
      spanStillInsideParent: span.parentElement === parent,
      wrapperParentId: wrapper?.parentElement?.id,    // 應為 inline-container（block 祖先）
      wrapperPrevTag:  wrapper?.previousElementSibling?.tagName, // 應為 P (parent)
      wrapperInnerTag: wrapper?.firstElementChild?.tagName,
      wrapperInnerText: wrapper?.firstElementChild?.textContent,
    };
  });

  expect(after.spanText, 'span 內文字未動').toBe('important phrase');
  expect(after.spanStillInsideParent, 'span 仍在原 <p> 內').toBe(true);
  expect(
    after.wrapperParentId,
    'wrapper 應插在最近 block 祖先（#inline-container）後面，不在 <p> 內',
  ).toBe('inline-container');
  expect(after.wrapperPrevTag, 'wrapper 緊接在 <p>(#inline-parent) 之後').toBe('P');
  expect(after.wrapperInnerTag, 'wrapper 內 tag = DIV').toBe('DIV');
  expect(after.wrapperInnerText).toBe('重要片語');

  await page.close();
});
