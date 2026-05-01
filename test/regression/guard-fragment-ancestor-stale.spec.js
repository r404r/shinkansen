// Regression: guard-fragment-ancestor-stale
//
// Fixture: test/regression/fixtures/guard-fragment-ancestor-stale.html
// 對應 v1.8.x — Content Guard 父層 savedHTML 過時導致子層譯文被覆蓋回原文 bug。
// 真實案例: forum.miata.net showpost — postbitcontrol2 (DIV) 同時含主貼文 inline
// 文字 + BR + 子層 DIV.bbcodestyle > TABLE > TR > TD > DIV (引用區塊)。
//
// Bug 機制 (結構性通則):
//   1. fragment unit (el=outer) 先 inject → STATE.translatedHTML.set(outer, innerHTML)
//      凍結時 inner 子段落還沒 inject → savedHTML 含子層原英文
//   2. inner element unit 後 inject → DOM 上 inner 變中文，outer 的 savedHTML 沒同步
//   3. Content Guard sweep 看 outer.innerHTML !== savedHTML → 強制 el.innerHTML = savedHTML
//      → outer 整段被覆寫，inner 中文被打回 stale 英文
//
// SANITY 紀錄 (已驗證):
//   暫時拔掉 STATE.translatedHTML.set 後的 ancestor refresh 邏輯 → 此 spec fail
//   (inner 在 Content Guard 跑完後變回英文)；補回 fix → pass。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_DIR = path.resolve(__dirname, 'fixtures');

const FIXTURE = 'guard-fragment-ancestor-stale';
const OUTER_SELECTOR = '#outer';
const INNER_SELECTOR = '#inner-elem';

function loadResp(suffix) {
  const p = path.join(FIXTURES_DIR, `${FIXTURE}.${suffix}.response.txt`);
  return fs.readFileSync(p, 'utf8').replace(/\n+$/, '');
}

test('guard-fragment-ancestor-stale: outer fragment + inner element 雙段 inject 後 Content Guard 不可把 inner 打回原文', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(INNER_SELECTOR, { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);
  const outerTranslation = loadResp('outer');
  const innerTranslation = loadResp('inner');

  // 步驟 1: collectParagraphs 取得 units，分別找出 fragment(outer) 跟 element(inner)
  // 並執行兩段 inject（順序：outer fragment 先 → inner element 後，重現 bug 觸發路徑）
  const injectResult = await evaluate(`
    (() => {
      const SK = window.__SK;
      const units = SK.collectParagraphs(document.body);
      const outerEl = document.querySelector(${JSON.stringify(OUTER_SELECTOR)});
      const innerEl = document.querySelector(${JSON.stringify(INNER_SELECTOR)});
      const fragmentUnit = units.find(u =>
        u.kind === 'fragment' && u.el === outerEl);
      const elementUnit = units.find(u =>
        u.kind === 'element' && u.el === innerEl);
      if (!fragmentUnit || !elementUnit) {
        return { error: 'unit not found', kinds: units.map(u => ({ kind: u.kind, tag: u.el?.tagName, id: u.el?.id })) };
      }

      // outer fragment 先 inject
      const fragSer = SK.serializeFragmentWithPlaceholders(fragmentUnit);
      SK.injectTranslation(fragmentUnit, ${JSON.stringify(outerTranslation)}, fragSer.slots);

      // inner element 後 inject
      const elemSer = SK.serializeWithPlaceholders(elementUnit.el);
      SK.injectTranslation(elementUnit, ${JSON.stringify(innerTranslation)}, elemSer.slots);

      return { ok: true, fragSlotCount: fragSer.slots.length, elemSlotCount: elemSer.slots.length };
    })()
  `);
  expect(injectResult.error, 'collectParagraphs 必須抓到 outer fragment + inner element').toBeUndefined();
  expect(injectResult.ok).toBe(true);

  // 步驟 2: 確認 inject 後 inner 是中文
  const afterInjectInner = await page.evaluate(
    (sel) => document.querySelector(sel).textContent,
    INNER_SELECTOR,
  );
  expect(afterInjectInner, 'inject 完成後 inner 應為中文').toContain('內層元素');

  // 步驟 3: 設 translated=true 讓 Content Guard 可跑
  await evaluate(`window.__shinkansen.setTestState({ translated: true })`);

  // 步驟 4: 跑 Content Guard sweep
  await evaluate(`window.__shinkansen.testRunContentGuard()`);

  // 步驟 5: 斷言 inner 仍是中文（修法後行為）
  const afterGuardInner = await page.evaluate(
    (sel) => document.querySelector(sel)?.textContent,
    INNER_SELECTOR,
  );
  expect(afterGuardInner, 'Content Guard 跑完後 inner 仍應為中文，不可被 outer stale savedHTML 覆寫').toContain('內層元素');
  expect(afterGuardInner, 'Content Guard 跑完後 inner 不可變回英文').not.toContain('Inner element content');

  // 步驟 6: outer fragment 段也仍是中文
  const afterGuardOuter = await page.evaluate(
    (sel) => document.querySelector(sel)?.textContent,
    OUTER_SELECTOR,
  );
  expect(afterGuardOuter, 'outer fragment 譯文仍應存在').toContain('外層 fragment alpha');

  await page.close();
});
