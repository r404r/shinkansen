// Regression: v1.5.0 dual-mode <td> / <th> wrapper 在 cell 內部
//
// 結構特徵：table cell 用 afterend 會把 wrapper 插在 cell 之間，
// 破壞欄對齊。必須 appendChild 到 cell 內部。
//
// SANITY 紀錄（已驗證）：把 TD/TH 分支改成 afterend 路徑後，wrapper 變成 cell
// 的 nextElementSibling 而非 child，spec fail；還原後 pass。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

test('dual-table: <th>/<td> 注入後 wrapper appendChild 進 cell 內部，不在 cell 之間', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/dual.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#th1', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  await evaluate(`(() => {
    window.__shinkansen.testInjectDual(document.querySelector('#th1'), '標頭 A');
    window.__shinkansen.testInjectDual(document.querySelector('#td1'), '資料 A');
  })()`);

  const after = await page.evaluate(() => {
    const th = document.querySelector('#th1');
    const td = document.querySelector('#td1');
    const thWrapper = th.querySelector('shinkansen-translation');
    const tdWrapper = td.querySelector('shinkansen-translation');
    return {
      thWrapperInsideCell: !!thWrapper && thWrapper.parentElement === th,
      tdWrapperInsideCell: !!tdWrapper && tdWrapper.parentElement === td,
      thNextTag: th.nextElementSibling?.tagName,    // 應該還是 TD
      tdNextTag: td.nextElementSibling?.tagName,    // 應該是 null（td 本來就是最後一格）
      thInnerTag: thWrapper?.firstElementChild?.tagName,
      tdInnerTag: tdWrapper?.firstElementChild?.tagName,
      thInnerText: thWrapper?.firstElementChild?.textContent,
      tdInnerText: tdWrapper?.firstElementChild?.textContent,
    };
  });

  expect(after.thWrapperInsideCell, 'th wrapper 必須在 th 內部').toBe(true);
  expect(after.tdWrapperInsideCell, 'td wrapper 必須在 td 內部').toBe(true);
  expect(after.thNextTag, 'th 旁邊仍是原本的 td，不該被 wrapper 插中間').toBe('TD');
  expect(after.thInnerTag, 'th wrapper inner = DIV（不複用 TH）').toBe('DIV');
  expect(after.tdInnerTag, 'td wrapper inner = DIV（不複用 TD）').toBe('DIV');
  expect(after.thInnerText).toBe('標頭 A');
  expect(after.tdInnerText).toBe('資料 A');

  await page.close();
});
