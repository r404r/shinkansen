// Regression: v1.5.0 dual-mode <li> 編號維持
//
// 結構特徵：<ol> / <ul> 內的 <li>，wrapper 必須 appendChild 進 <li> 內部，
// 不能用 afterend 插在 <li> 之間——否則 <ol> 編號會錯亂、<li> 數量翻倍。
//
// SANITY 紀錄（已驗證）：把 LI/TD/TH 分支改成 afterend 路徑後，
// `ol.children.length` 從 3 變 6（每個 li 後面多出一個 wrapper），
// `ol.children` 也包含非 LI 元素，spec fail；還原後 pass。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

test('dual-list: <ol> 三個 <li> 注入後 ol 仍只有三個 LI children，wrapper 在 li 內部', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/dual.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#list', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // 對三個 li 各自注入
  await evaluate(`(() => {
    const trans = ['第一項', '第二項', '第三項'];
    ['#li1', '#li2', '#li3'].forEach((sel, i) => {
      const el = document.querySelector(sel);
      window.__shinkansen.testInjectDual(el, trans[i]);
    });
  })()`);

  const after = await page.evaluate(() => {
    const ol = document.querySelector('#list');
    const liChildren = Array.from(ol.children);
    const liTags = liChildren.map(c => c.tagName);
    const li1 = document.querySelector('#li1');
    const li1Wrapper = li1.querySelector('shinkansen-translation');
    return {
      olChildCount: liChildren.length,
      liTags,
      li1Text: li1.firstChild?.nodeValue,  // 原文字節點
      li1WrapperParentTag: li1Wrapper?.parentElement?.tagName,
      li1WrapperInnerTag:  li1Wrapper?.firstElementChild?.tagName,
      li1WrapperInnerText: li1Wrapper?.firstElementChild?.textContent,
    };
  });

  expect(after.olChildCount, 'ol 仍只有 3 個 children').toBe(3);
  expect(after.liTags, 'ol children 全部應是 LI').toEqual(['LI', 'LI', 'LI']);
  expect(after.li1Text?.trim(), '原 li 文字節點不變').toBe('First item');
  expect(after.li1WrapperParentTag, 'wrapper 應在 LI 內部').toBe('LI');
  expect(after.li1WrapperInnerTag, 'wrapper 內 tag 為 DIV（不複用 LI）').toBe('DIV');
  expect(after.li1WrapperInnerText, '譯文「第一項」').toBe('第一項');

  await page.close();
});
