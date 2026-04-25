// Regression: v1.5.2 collectParagraphs 必須跳過 dual wrapper 子樹（中英混排譯文 case）
//
// 真實情境：BBC News byline 翻譯後譯文「《Inside Health》主持人，BBC Radio 4」，
// CJK 字元佔比 < 50%（人名 / 節目名保留英文），SK.isTraditionalChinese 回 false →
// isCandidateText 把譯文當「新英文段落」回傳 → SPA observer 觸發
// translateUnits + injectDual 又疊一個 wrapper。每次 BBC 頁面自然 mutation 觸發
// observer，wrapper 再疊一層，視覺上是「慢慢長出第二、第三個」相同譯文。
//
// 修法：把 SHINKANSEN-TRANSLATION 加進 SK.HARD_EXCLUDE_TAGS，detector 整個
// 跳過 wrapper 子樹，不論裡面譯文是不是繁中。
//
// 注意：這條跟 v1.5.1 的 inject-dual-overlap-skip / v1.5.2 的 inject-dual-spa-rebuild
// 處理的是不同 race：
//   - overlap-skip：祖孫同段都被當段落（同一輪 collectParagraphs）
//   - spa-rebuild：BBC 替換 inline element 造成 attribute 不繼承（注入層 race）
//   - 本 spec：detector 把 wrapper 內譯文當新段落（中英混排譯文沒被 isTraditionalChinese 擋）
//
// SANITY 紀錄（已驗證）：把 SHINKANSEN-TRANSLATION 從 HARD_EXCLUDE_TAGS 拿掉，
// collectParagraphs 會抓到 wrapper 內的譯文 inner（因 CJK 佔比 < 50% 沒被
// isCandidateText 擋），spec fail；還原後 pass。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

// 真實 BBC byline 譯文：CJK 「主持人」3 字 + 英文「Inside Health BBC Radio」18 字 → CJK 佔比 ~14%
const MIXED_TRANSLATION = '《Inside Health》主持人，BBC Radio 4';

test('detect-skip-translation-wrapper: 中英混排譯文 wrapper 內 inner 不應被 collectParagraphs 抓走', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/dual.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#bbc-byline-span', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // 1) 先做一次 dual 注入，譯文用中英混排（模擬 BBC byline 真實譯文）
  await evaluate(`(() => {
    const el = document.querySelector('#bbc-byline-span');
    return window.__shinkansen.testInjectDual(el, ${JSON.stringify(MIXED_TRANSLATION)});
  })()`);

  const afterInject = await page.evaluate(() => ({
    wrapperCount: document.querySelectorAll('shinkansen-translation').length,
    innerText: document.querySelector('shinkansen-translation > div')?.textContent
            || document.querySelector('shinkansen-translation > p')?.textContent
            || document.querySelector('shinkansen-translation')?.textContent,
  }));
  expect(afterInject.wrapperCount, '第一次注入應有 1 個 wrapper').toBe(1);
  expect(afterInject.innerText, 'wrapper 內譯文').toBe(MIXED_TRANSLATION);

  // 2) collectParagraphs 不應抓到 wrapper 內的譯文 inner（即使 CJK 佔比 < 50%）
  const units = await evaluate('window.__shinkansen.collectParagraphs()');
  const wrapperUnits = units.filter((u) => u.tag === 'SHINKANSEN-TRANSLATION');
  const mixedUnits = units.filter((u) => /Inside Health.*主持人/.test(u.textPreview || ''));

  expect(wrapperUnits.length, 'collectParagraphs 不應把 SHINKANSEN-TRANSLATION 自己當段落').toBe(0);
  expect(mixedUnits.length, '中英混排的譯文不應被 collectParagraphs 抓回').toBe(0);

  await page.close();
});
