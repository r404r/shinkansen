// Regression: li-strong-br (對應 v1.4.4 修的「<li><strong>標題</strong><br>內文</li> 翻譯後 <br> 消失」bug)
//
// Fixture: test/regression/fixtures/li-strong-br.html
// 結構: <li><strong>タイトル</strong><br>\n本文</li>
//
// Bug 根因（v1.4.3 以前）:
//   collapseCjkSpacesAroundPlaceholders 的第 2 條 pattern 使用 \s+，
//   會在 ⟦/0⟧\n漢字 上命中，把 \n 吃掉。
//   parseSegment 就看不到 \n，無法建出 <br> 元素，標題與內文擠成一行。
//
// v1.4.4 修法:
//   將 4 個 pattern 的 \s+ 改為 [ \t]+（只移除空格/tab，不動 \n），
//   讓 \n 能活到 parseSegment 的 pushText，正確建出 <br>。
//
// SANITY 紀錄（已驗證）：把 collapseCjkSpacesAroundPlaceholders 的第 2 條 pattern
//   改回 \s+，brCount 從 1 降為 0，test fail。還原後 pass。
import { test, expect } from '../fixtures/extension.js';
import {
  loadFixtureResponse,
  getShinkansenEvaluator,
  runTestInject,
} from './helpers/run-inject.js';

const FIXTURE = 'li-strong-br';
const TARGET_SELECTOR = 'li#target';

test('li-strong-br: <li><strong>標題</strong><br>內文</li> 翻譯後 <br> 不可消失', async ({
  context,
  localServer,
}) => {
  const translation = loadFixtureResponse(FIXTURE);

  // 確認 fixture response 含 \n（代表 <br> 換行）
  expect(
    translation.includes('\n'),
    'canned response 應含 \\n（代表 <br>）',
  ).toBe(true);

  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(TARGET_SELECTOR, { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // 斷言 a: 序列化後 text 應含 \n（<br> → \u0001 → \n），且有 1 個 slot（<strong>）
  const serialized = await evaluate(`
    JSON.stringify((() => {
      const el = document.querySelector('${TARGET_SELECTOR}');
      const { text, slots } = window.__shinkansen.serialize(el);
      return { text, slotCount: slots.length };
    })())
  `);
  const { text: sourceText, slotCount } = JSON.parse(serialized);
  expect(slotCount).toBe(1); // <strong> → 1 個 paired slot
  expect(
    sourceText.includes('\n'),
    `序列化後的 text 應含 \\n（BR sentinel），實際: ${JSON.stringify(sourceText)}`,
  ).toBe(true);

  // 跑 testInject（canned response 含 \n，模擬 Gemini 保留 \n 的回應）
  const injectResult = await runTestInject(evaluate, TARGET_SELECTOR, translation);
  expect(injectResult.slotCount).toBe(1);

  // 讀取注入後 DOM 狀態
  const after = await page.evaluate((sel) => {
    const li = document.querySelector(sel);
    if (!li) return null;
    const brs = Array.from(li.querySelectorAll('br'));
    const strong = li.querySelector('strong');
    const textPieces = [];
    const walker = document.createTreeWalker(li, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      const t = n.nodeValue.replace(/^\s+|\s+$/g, '');
      if (t) textPieces.push(t);
    }
    return {
      brCount: brs.length,
      strongText: strong ? strong.textContent.trim() : null,
      textPieces,
      liInnerHTMLPreview: li.innerHTML.replace(/\s+/g, ' ').slice(0, 300),
    };
  }, TARGET_SELECTOR);

  expect(after, 'li#target 應該存在').not.toBeNull();

  // 斷言 1: <br> 必須存在（核心 bug：\n 要還原成 <br>）
  expect(
    after.brCount,
    `li 內 <br> 數量應 >= 1，實際 ${after.brCount}\nDOM: ${after.liInnerHTMLPreview}`,
  ).toBeGreaterThanOrEqual(1);

  // 斷言 2: <strong> 應保留並含有翻譯後標題
  expect(
    after.strongText,
    '<strong> 應保留且有文字',
  ).toBe('能走得更遠的距離');

  // 斷言 3: 內文段落文字應正確出現（<br> 後的本文）
  expect(
    after.textPieces.some(t => t.includes('身體負擔減輕後')),
    `內文應含「身體負擔減輕後」，實際 textPieces: ${JSON.stringify(after.textPieces)}`,
  ).toBe(true);

  await page.close();
});
