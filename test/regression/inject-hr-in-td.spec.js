// Regression: hr-in-td（對應 v1.4.10 修的「VBulletin 論壇翻譯後 <hr> 分隔線消失」bug）
//
// Fixture: test/regression/fixtures/hr-in-td.html
// 結構: <td id="target">
//         <div class="smallfont"><strong>標題</strong></div>
//         <hr class="hideonmobile">
//         <div id="post_message_test">內文</div>
//       </td>
//
// Bug 根因（v1.4.9 以前）:
//   <td> 沒有 P/H1/LI 等 BLOCK_TAGS_SET 後代，walker 直接 FILTER_ACCEPT 整個 <td>。
//   serializeWithPlaceholders 走過 <hr> 時，isAtomicPreserve 回 false、
//   isPreservableInline 也回 false，走 else 分支遞迴子節點（HR 沒有子節點），
//   結果 <hr> 在序列化輸出裡完全消失。
//   注入時 clean slate 清空 <td> 所有子節點，<hr> 就此不見。
//
// v1.4.10 修法:
//   isAtomicPreserve 加一行 `if (el.tagName === 'HR') return true;`。
//   序列化時 <hr> 變成 ⟦*N⟧ 原子佔位符（cloneNode(true) 保留 class）。
//   LLM 保留 ⟦*N⟧ 後，反序列化自動還原完整 <hr class="hideonmobile">。
//
// <!-- SANITY-PENDING: 把 isAtomicPreserve 的 HR 那行移除，
//      預期：hrCount 從 1 降為 0，test fail。還原後 pass。 -->
import { test, expect } from '../fixtures/extension.js';
import {
  loadFixtureResponse,
  getShinkansenEvaluator,
  runTestInject,
} from './helpers/run-inject.js';

const FIXTURE = 'hr-in-td';
const TARGET_SELECTOR = 'td#target';

test('hr-in-td: <td> 內夾著 <hr> 分隔線翻譯後不可消失', async ({
  context,
  localServer,
}) => {
  const translation = loadFixtureResponse(FIXTURE);

  // 確認 canned response 含 ⟦*1⟧（HR 的原子佔位符）
  expect(
    translation.includes('\u27E6*1\u27E7'),
    'canned response 應含 ⟦*1⟧（代表 <hr> 原子 slot）',
  ).toBe(true);

  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(TARGET_SELECTOR, { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // 斷言 a: 序列化後 text 應含 ⟦*N⟧（HR 已被收進原子 slot）
  const serialized = await evaluate(`
    JSON.stringify((() => {
      const el = document.querySelector('${TARGET_SELECTOR}');
      const { text, slots } = window.__shinkansen.serialize(el);
      const hrSlotCount = slots.filter(s => s && s.atomic && s.node && s.node.tagName === 'HR').length;
      return { text, slotCount: slots.length, hrSlotCount };
    })())
  `);
  const { text: sourceText, slotCount, hrSlotCount } = JSON.parse(serialized);

  expect(
    hrSlotCount,
    `slots 中應有 1 個 HR 原子 slot，實際 hrSlotCount=${hrSlotCount}，text=${JSON.stringify(sourceText)}`,
  ).toBe(1);

  expect(
    sourceText.includes('\u27E6*'),
    `序列化 text 應含 ⟦*N⟧（原子佔位符），實際: ${JSON.stringify(sourceText)}`,
  ).toBe(true);

  // 跑 testInject
  const injectResult = await runTestInject(evaluate, TARGET_SELECTOR, translation);
  expect(injectResult.slotCount).toBeGreaterThanOrEqual(1);

  // 讀取注入後 DOM 狀態
  const after = await page.evaluate((sel) => {
    const td = document.querySelector(sel);
    if (!td) return null;
    const hrs = Array.from(td.querySelectorAll('hr'));
    const strong = td.querySelector('strong');
    const textPieces = [];
    const walker = document.createTreeWalker(td, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      const t = n.nodeValue.replace(/^\s+|\s+$/g, '');
      if (t) textPieces.push(t);
    }
    return {
      hrCount: hrs.length,
      hrClass: hrs[0] ? hrs[0].className : null,
      strongText: strong ? strong.textContent.trim() : null,
      textPieces,
      tdPreview: td.innerHTML.replace(/\s+/g, ' ').slice(0, 400),
    };
  }, TARGET_SELECTOR);

  expect(after, 'td#target 應該存在').not.toBeNull();

  // 斷言 1: <hr> 必須存在（核心 bug）
  expect(
    after.hrCount,
    `td 內 <hr> 數量應 >= 1，實際 ${after.hrCount}\nDOM: ${after.tdPreview}`,
  ).toBeGreaterThanOrEqual(1);

  // 斷言 2: <hr> 的 class 屬性應保留（cloneNode(true)）
  expect(
    after.hrClass,
    '<hr> 的 class 屬性應保留為 hideonmobile',
  ).toBe('hideonmobile');

  // 斷言 3: <strong> 應保留並含有翻譯後標題
  expect(
    after.strongText,
    '<strong> 應保留且有翻譯後標題文字',
  ).toBe('激烈加速時 ND 徹底熄火兩次');

  // 斷言 4: 內文翻譯後的中文應出現
  expect(
    after.textPieces.some(t => t.includes('早安各位')),
    `內文應含「早安各位」，實際 textPieces: ${JSON.stringify(after.textPieces)}`,
  ).toBe(true);

  await page.close();
});
