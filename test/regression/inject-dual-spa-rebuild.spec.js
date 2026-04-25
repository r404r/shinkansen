// Regression: v1.5.2 dual-mode SPA rebuild race-condition 防護
//
// 結構特徵：BBC News 等 React-driven 站點在初次 dual 注入後會把 inline 段落
// （如 byline <span>）整顆 cloneNode 替換掉。新 element 沒繼承
// data-shinkansen-dual-source attribute（attribute 在「舊 element」上、舊 element
// 已不在 DOM），但「舊 wrapper」仍在 DOM——wrapper 是上層 block-ancestor 的
// sibling，不會被 inline element 的替換連帶刪除。
// 第二次 collectParagraphs / injectDual 對「新 element」沒有去重保護 → 又注入
// 第二個 wrapper → BBC 再 rerender → 第三個 wrapper（v1.5.2 BBC byline 三層觀察值）。
//
// 修法：injectDual 注入前用 findExistingWrapperAtInsertionPoint 檢查
// 「預期插入位置」是否已有譯文相符的 wrapper——有則 skip，並把
// STATE.translationCache 的 key 從舊 element 換到新 element。
//
// SANITY 紀錄（已驗證）：把 injectDual 內的 findExistingWrapperAtInsertionPoint
// 檢查整段註解掉，第二次注入會插入第二個 wrapper，spec fail；還原後 pass。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

test('dual-spa-rebuild: 模擬 BBC SPA 把 inline span 替換掉，第二次注入應 dedupe skip', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/dual.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#bbc-byline-span', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // 1) 第一次注入 inline span
  await evaluate(`(() => {
    const el = document.querySelector('#bbc-byline-span');
    return window.__shinkansen.testInjectDual(el, '《Inside Health》節目主持人，BBC Radio 4');
  })()`);

  const afterFirst = await page.evaluate(() => {
    const w = document.querySelector('shinkansen-translation');
    return {
      wrapperCount: document.querySelectorAll('shinkansen-translation').length,
      spanHasAttr: document.querySelector('#bbc-byline-span').hasAttribute('data-shinkansen-dual-source'),
      // 記下 wrapper 的 prev sibling id（給後續 dedupe 比對用，不要硬寫位置）
      prevSiblingId: w?.previousElementSibling?.id || null,
    };
  });
  expect(afterFirst.wrapperCount, '第一次注入應有 1 個 wrapper').toBe(1);
  expect(afterFirst.spanHasAttr, 'span 應掛上 dual-source').toBe(true);
  // wrapper 應該緊接在某個 block 祖先後面（具體哪個取決於 findBlockAncestor）
  expect(afterFirst.prevSiblingId, 'wrapper 應在某個 byline 容器之後').toMatch(/^bbc-byline-(outer|mid)$/);

  // 2) 模擬 BBC SPA 重建：用 cloneNode 拷貝 span（不含 dual-source attribute）
  // 然後把舊 span replaceWith 新 span。新 span 的 ID / textContent 不變，但是不同 element。
  await page.evaluate(() => {
    const oldSpan = document.querySelector('#bbc-byline-span');
    const cloned = oldSpan.cloneNode(true);
    cloned.removeAttribute('data-shinkansen-dual-source');
    oldSpan.replaceWith(cloned);
  });

  const afterRebuild = await page.evaluate(() => {
    const newSpan = document.querySelector('#bbc-byline-span');
    return {
      newSpanHasAttr: newSpan.hasAttribute('data-shinkansen-dual-source'),
      wrapperStillExists: document.querySelectorAll('shinkansen-translation').length,
    };
  });
  expect(afterRebuild.newSpanHasAttr, '替換後新 span 不應有 attribute').toBe(false);
  expect(afterRebuild.wrapperStillExists, '舊 wrapper 仍在 DOM').toBe(1);

  // 3) 第二次注入「新 span」——應被 dedupe 擋下，不疊新 wrapper
  await evaluate(`(() => {
    const el = document.querySelector('#bbc-byline-span');
    return window.__shinkansen.testInjectDual(el, '《Inside Health》節目主持人，BBC Radio 4');
  })()`);

  const afterSecond = await page.evaluate(() => ({
    wrapperCount: document.querySelectorAll('shinkansen-translation').length,
    newSpanHasAttr: document.querySelector('#bbc-byline-span').hasAttribute('data-shinkansen-dual-source'),
  }));
  expect(afterSecond.wrapperCount, '第二次注入應 dedupe，wrapper 仍只有 1 個').toBe(1);
  expect(afterSecond.newSpanHasAttr, 'dedupe 後新 span 應掛上 dual-source 防再次注入').toBe(true);

  // 4) 第三次注入（模擬第三輪 SPA rerender）——也應 dedupe
  await page.evaluate(() => {
    const oldSpan = document.querySelector('#bbc-byline-span');
    const cloned = oldSpan.cloneNode(true);
    cloned.removeAttribute('data-shinkansen-dual-source');
    oldSpan.replaceWith(cloned);
  });
  await evaluate(`(() => {
    const el = document.querySelector('#bbc-byline-span');
    return window.__shinkansen.testInjectDual(el, '《Inside Health》節目主持人，BBC Radio 4');
  })()`);
  const afterThird = await page.evaluate(
    () => document.querySelectorAll('shinkansen-translation').length,
  );
  expect(afterThird, '第三輪也應 dedupe，wrapper 始終 1 個').toBe(1);

  // 5) 驗 cache key 已切換到「最新一輪的新 span」，讓 Content Guard 後續還能追蹤
  const cacheStatus = await evaluate(`(() => {
    const newSpan = document.querySelector('#bbc-byline-span');
    return {
      cacheHasNewSpan: window.__SK.STATE.translationCache.has(newSpan),
      cacheSize: window.__SK.STATE.translationCache.size,
    };
  })()`);
  expect(cacheStatus.cacheHasNewSpan, 'cache key 應指向最新的 span，給 Content Guard 用').toBe(true);
  expect(cacheStatus.cacheSize, 'cache 應只有 1 筆（舊 element key 在每次 dedupe 時已 delete）').toBe(1);

  await page.close();
});
