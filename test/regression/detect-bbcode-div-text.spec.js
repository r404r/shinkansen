// Regression: bbcode-div-text (對應 v1.4.7 修的「XenForo BBCode DIV 文字漏翻」bug)
//
// Fixture: test/regression/fixtures/bbcode-div-text.html
// 結構: <div class="bbWrapper">intro<br>Pros:<ul><li>...</li></ul>Overall...</div>
//
// Bug 根因（v1.4.6 以前）:
//   DIV 不在 BLOCK_TAGS_SET，所以 collectParagraphs walker 對 .bbWrapper
//   直接回 FILTER_SKIP，完全沒走到 containsBlockDescendant / extractInlineFragments。
//   結果：LI 元素（在 BLOCK_TAGS_SET）被翻到，但 DIV 內的直接 text node
//   （intro 段落、"Pros:"、"Overall..."）完全漏翻。
//
// v1.4.7 修法:
//   在 acceptNode 的非 BLOCK_TAGS_SET 分支，若元素有直接 TEXT 子節點（trimmed >= 2）
//   且有 block 子孫，補做 extractInlineFragments，把 text 抽成 fragment 單元。
//
// SANITY 紀錄（已驗證）：移除 v1.4.7 新增的 !BLOCK_TAGS_SET 分支 extractInlineFragments，
//   fragmentCount=0（intro 文字沒被偵測到），斷言 1 fail。還原後 pass。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE_HTML = 'bbcode-div-text';

test('bbcode-div-text: XenForo 風格 DIV 內的 intro 文字應被偵測為 fragment 單元', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE_HTML}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // 在 isolated world 跑 collectParagraphsWithStats，確認 fragment 有被抓到
  const result = await evaluate(`
    (() => {
      const stats = {};
      const units = window.__SK.collectParagraphs(document.body, stats);
      const fragments = units.filter(u => u.kind === 'fragment');
      const elements = units.filter(u => u.kind === 'element');
      const introFrag = fragments.find(f => {
        const text = f.el ? (f.el.textContent || '') : '';
        return text.includes('1700 SQFT');
      });
      return {
        totalUnits: units.length,
        fragmentCount: fragments.length,
        elementCount: elements.length,
        hasIntroFragment: !!introFrag,
        // 擷取 fragment 對應的 element 文字，用於診斷
        fragmentTexts: fragments.map(f => f.el ? f.el.textContent.trim().slice(0, 80) : ''),
        stats,
      };
    })()
  `);

  // 斷言 1: intro 文字應被偵測為 fragment（v1.4.7 修法核心）
  expect(
    result.hasIntroFragment,
    `intro 段落應被偵測為 fragment，實際 fragmentCount=${result.fragmentCount}` +
    `\nfragmentTexts: ${JSON.stringify(result.fragmentTexts)}` +
    `\nstats: ${JSON.stringify(result.stats)}`,
  ).toBe(true);

  // 斷言 2: fragment 數量 >= 1（intro + 可能含 Overall 文字）
  expect(
    result.fragmentCount,
    `至少應有 1 個 fragment unit，實際 ${result.fragmentCount}`,
  ).toBeGreaterThanOrEqual(1);

  // 斷言 3: LI 元素仍被正常偵測（既有行為不應回退）
  expect(
    result.elementCount,
    `應有 >= 2 個 element unit（LI 列表項），實際 ${result.elementCount}`,
  ).toBeGreaterThanOrEqual(2);

  await page.close();
});
