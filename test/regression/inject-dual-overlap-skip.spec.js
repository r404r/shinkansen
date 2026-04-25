// Regression: v1.5.1 dual-mode 祖孫同段去重
//
// 結構特徵：collectParagraphs 在某些網站（例如 BBC author byline）會把祖先
// element + 後代 element 都當成段落單元。單語模式下後一次 in-place 注入會
// 覆蓋前一次，使用者看不到；雙語模式下每次都 insertAdjacentElement 一個
// wrapper，會疊出多個同譯文 wrapper（v1.5.0 在 BBC 的 author byline 觀察到三
// 重 wrapper）。
//
// 修法：SK.injectDual 入口檢查祖先鏈與後代是否已有 data-shinkansen-dual-source
// 標記——已有則 skip，不重複插入 wrapper。
//
// SANITY 紀錄（已驗證）：把 SK.injectDual 內的祖先鏈 while 迴圈與後代
// querySelector 檢查同時註解掉，第二次注入仍會插一個 wrapper，DOM 內
// `shinkansen-translation` 變成 2 個，spec fail；還原後 pass。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

test('dual-overlap-skip: 祖孫同段第二次注入應 skip，不該疊出第二個 wrapper', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/dual.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#overlap-outer', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // 1) 先注入「祖先」outer
  await evaluate(`(() => {
    const el = document.querySelector('#overlap-outer');
    return window.__shinkansen.testInjectDual(el, '健康節目主持人，BBC 廣播電台 4');
  })()`);

  const afterFirst = await page.evaluate(() => ({
    wrapperCount: document.querySelectorAll('shinkansen-translation').length,
    outerHasAttr: document.querySelector('#overlap-outer').hasAttribute('data-shinkansen-dual-source'),
    innerHasAttr: document.querySelector('#overlap-inner').hasAttribute('data-shinkansen-dual-source'),
  }));
  expect(afterFirst.wrapperCount, '第一次注入後應有 1 個 wrapper').toBe(1);
  expect(afterFirst.outerHasAttr).toBe(true);
  expect(afterFirst.innerHasAttr).toBe(false);

  // 2) 再注入「後代」inner——應該 skip 因祖先已有 dual-source
  await evaluate(`(() => {
    const el = document.querySelector('#overlap-inner');
    return window.__shinkansen.testInjectDual(el, '健康節目主持人，BBC 廣播電台 4');
  })()`);

  const afterSecond = await page.evaluate(() => ({
    wrapperCount: document.querySelectorAll('shinkansen-translation').length,
    innerHasAttr: document.querySelector('#overlap-inner').hasAttribute('data-shinkansen-dual-source'),
  }));
  expect(afterSecond.wrapperCount, '第二次注入應被 skip，wrapper 仍只有 1 個').toBe(1);
  expect(afterSecond.innerHasAttr, 'inner 應沒被打上 dual-source（skip 提早 return）').toBe(false);

  // 3) 反向順序：先 inner 再 outer——outer 應該被後代的 dual-source 擋下
  // 用一個全新 page 避免 sticky state 互相干擾
  await page.close();
  const page2 = await context.newPage();
  await page2.goto(`${localServer.baseUrl}/dual.html`, { waitUntil: 'domcontentloaded' });
  await page2.waitForSelector('#overlap-inner', { timeout: 10_000 });

  const ev2 = (await getShinkansenEvaluator(page2)).evaluate;
  await ev2(`window.__shinkansen.testInjectDual(document.querySelector('#overlap-inner'), '譯文')`);
  await ev2(`window.__shinkansen.testInjectDual(document.querySelector('#overlap-outer'), '譯文')`);

  const reverseResult = await page2.evaluate(() => ({
    wrapperCount: document.querySelectorAll('shinkansen-translation').length,
    outerHasAttr: document.querySelector('#overlap-outer').hasAttribute('data-shinkansen-dual-source'),
  }));
  expect(reverseResult.wrapperCount, '反向順序也應只有 1 個 wrapper').toBe(1);
  expect(reverseResult.outerHasAttr, 'outer 應 skip 不被打上 dual-source').toBe(false);

  await page2.close();
});
