// Regression: v1.7.2 prioritizeUnits tier 0 細分(Readability content score)
//
// Fixture: test/regression/fixtures/translate-priority-tier-0-readability.html
// 結構特徵:`<main>` 內混了「UI 工具列短文字」與「真內容」(模擬 GitHub repo:
// Issues / Pull requests / Code 等 tab 跟 README 內容都在 main 內)
//
// v1.7.1 行為:tier 0 = 「祖先有 main/article」一刀切,GitHub UI tab 跟 README 內文
// 全部命中 tier 0 → 同 tier 內 stable sort 維持 DOM 順序 → batch 0 仍可能吃到 UI tab
//
// v1.7.2 修法:tier 0 內加 readability score 細分:
//   tier 0 = 祖先 main/article + score >= 5(真內文,如 H1 / 多逗號長文)
//   tier 1 = 祖先 main/article + score < 5(短工具列文字)
//
// 預期:fixture 中 `real-heading` (H1) 與 `real-content` / `real-followup` (含多逗號的長 P)
// 應排到 array 前面,`ui-toolbar-1` / `ui-toolbar-2` (短文字、無逗號、不是 H1-3) 排到後面
//
// 斷言基於結構特徵(score 公式只用文字長度、逗號數、heading tag、含 P 子孫),
// 不靠 class/id 名稱啟發式 → 符合硬規則 §8 結構通則
//
// SANITY CHECK 紀錄(已驗證,2026-04-28):
//   把 prioritizeUnits 改回 v1.7.1 三 tier(移除 readability score 細分,
//   把 inMainOrArticle 內全部回 tier 0)→ ui-toolbar-* 維持 DOM 順序在前 →
//   real-heading / real-content 不會被推前 → 斷言 fail。還原 pass。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'translate-priority-tier-0-readability';

test('priority-tier-0-readability: main 內高 readability score 必排在低 score 之前', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('main#content-main', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (() => {
      const SK = window.__SK;
      const before = SK.collectParagraphs();
      const after = SK.prioritizeUnits(before);
      const idOf = (u) => u.el?.id || null;
      return JSON.stringify({
        before: before.map(idOf),
        after: after.map(idOf),
      });
    })()
  `);
  const { before, after } = JSON.parse(result);

  // real-heading / real-content / real-followup 三個高 score 元素應在 after 前 3 位
  // (DOM 順序:ui-toolbar-1 / ui-toolbar-2 / real-heading / real-content / real-followup,
  //  排序後 tier 0 三個高 score 推前,tier 1 兩個 ui-toolbar 排後)
  const realIds = new Set(['real-heading', 'real-content', 'real-followup']);
  const top3 = after.slice(0, 3);
  for (const id of top3) {
    expect(
      realIds.has(id),
      `after 前 3 位應全屬於高 readability score(real-*)集合,實際 top3=${JSON.stringify(top3)},全部=${JSON.stringify(after)}`,
    ).toBe(true);
  }

  // ui-toolbar-* 應排在 real-* 之後
  const toolbar1Idx = after.indexOf('ui-toolbar-1');
  const toolbar2Idx = after.indexOf('ui-toolbar-2');
  const realHeadingIdx = after.indexOf('real-heading');
  expect(toolbar1Idx, 'ui-toolbar-1 應出現').toBeGreaterThanOrEqual(0);
  expect(realHeadingIdx, 'real-heading 應出現').toBeGreaterThanOrEqual(0);
  expect(
    toolbar1Idx,
    `ui-toolbar-1(tier 1,score < 5)應排在 real-heading(tier 0,score >= 5)之後`,
  ).toBeGreaterThan(realHeadingIdx);
  expect(
    toolbar2Idx,
    `ui-toolbar-2(tier 1)應排在 real-heading(tier 0)之後`,
  ).toBeGreaterThan(realHeadingIdx);

  await page.close();
});
