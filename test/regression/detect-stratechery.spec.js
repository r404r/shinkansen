// Regression: stratechery-mixed-content-fragment (對應 v0.36 mixed-content block → fragment unit)
//
// Fixture: test/regression/fixtures/stratechery-mixed.html
// 結構: <li>引言文字 ... <ul><li>子1</li><li>子2</li></ul></li>
//
// 結構通則 (不綁站名):當一個 block 同時含直接 inline 文字 + block 後代,
// walker 必須 SKIP 外層讓子 block 獨立成段,同時抽出外層自己的 inline-run
// 變成 fragment unit。否則引言文字會變成孤兒。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'stratechery-mixed';

test('stratechery-mixed-content-fragment: mixed-content block 必須抽出 fragment unit', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('li#outer', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    JSON.stringify(window.__shinkansen.collectParagraphsWithStats())
  `);
  const { units, skipStats } = JSON.parse(result);

  // 斷言 1: 至少一個 fragment unit (對應外層 LI 的引言文字)
  const fragments = units.filter((u) => u.kind === 'fragment');
  expect(
    fragments.length,
    `應有至少 1 個 fragment unit,實際 0。units: ${JSON.stringify(units)}`,
  ).toBeGreaterThanOrEqual(1);

  // 斷言 2: fragment unit 的 tag = LI (外層 mixed-content block)
  const outerFragment = fragments.find((u) => u.tag === 'LI');
  expect(outerFragment, '應有 tag=LI 的 fragment unit').toBeDefined();
  expect(outerFragment.textPreview).toContain('introduction text');

  // 斷言 3: 兩個內層 LI 各自被收成 element unit
  const elementLis = units.filter((u) => u.kind === 'element' && u.tag === 'LI');
  expect(
    elementLis.length,
    `應有 2 個 element kind 的 LI (內層子項目),實際 ${elementLis.length}`,
  ).toBe(2);
  expect(elementLis[0].textPreview).toContain('First sub item');
  expect(elementLis[1].textPreview).toContain('Second sub item');

  // 斷言 4: skipStats 命中 mixed-content 分支
  expect(skipStats.fragmentUnit || 0).toBeGreaterThanOrEqual(1);
  expect(skipStats.hasBlockDescendant || 0).toBeGreaterThanOrEqual(1);

  await page.close();
});
