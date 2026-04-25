// Regression: v1.5.0 dual-mode 基本 <p> 注入
//
// 結構特徵：一般 block (`<p>`) → wrapper 用 insertAdjacentElement('afterend')
// 插在原段落後面，wrapper 內部 tag = 原 tag（<p>），原文不動。
//
// SANITY 紀錄（已驗證）：把 SK.injectDual 的 block 分支
// `original.insertAdjacentElement('afterend', wrapper)` 改為 no-op 後，
// nextSiblingTag 變成 null（原段落沒有下一個兄弟），spec fail；還原後 pass。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

test('dual-basic: <p> 注入後 wrapper 為 afterend、原段落不動、wrapper 內部為 <p>', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/dual.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#basic', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // 確認注入前狀態
  const before = await page.evaluate(() => {
    const el = document.querySelector('#basic');
    return {
      tag: el.tagName,
      text: el.textContent,
      hasNext: !!el.nextElementSibling,
    };
  });
  expect(before.tag).toBe('P');
  expect(before.text).toBe('Hello world.');

  // 注入
  await evaluate(`(() => {
    const el = document.querySelector('#basic');
    return window.__shinkansen.testInjectDual(el, '你好世界。');
  })()`);

  const after = await page.evaluate(() => {
    const el = document.querySelector('#basic');
    const next = el.nextElementSibling;
    return {
      originalText: el.textContent,
      originalAttr: el.getAttribute('data-shinkansen-dual-source'),
      nextTag: next ? next.tagName.toLowerCase() : null,
      mark: next ? next.getAttribute('data-sk-mark') : null,
      innerTag: next ? next.firstElementChild?.tagName : null,
      innerText: next ? next.firstElementChild?.textContent : null,
    };
  });

  expect(after.originalText, '原段落 textContent 不應改動').toBe('Hello world.');
  expect(after.originalAttr, '原段落應掛上 data-shinkansen-dual-source').toBe('1');
  expect(after.nextTag, 'next sibling 應為 shinkansen-translation').toBe('shinkansen-translation');
  expect(after.mark, 'wrapper 預設 data-sk-mark="tint"').toBe('tint');
  expect(after.innerTag, 'wrapper 內部 tag = 原段落 tag (<p>)').toBe('P');
  expect(after.innerText, 'wrapper 內部譯文應為「你好世界。」').toBe('你好世界。');

  await page.close();
});
