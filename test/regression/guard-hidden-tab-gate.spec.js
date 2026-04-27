// Regression: guard-hidden-tab-gate (對應 v1.6.10 分頁隱藏時 Content Guard 跳過 sweep)
//
// Fixture: 沿用 guard-overwrite.html / .response.txt
// 結構通則: production runContentGuard 在 document.hidden=true 時應跳過,使用者
// 看不到的內容無需即時修復;切回 visible 時下一次 sweep 應正常修復。此 spec 鎖
// 死 hidden gate 行為,避免日後不小心移除這個能源優化。
//
// 與 guard-content-overwrite.spec.js 的差別:後者透過 testRunContentGuard
// (繞過 viewport 與 hidden gate) 驗證 guard 核心修復邏輯;本 spec 透過
// _testRunContentGuardProd (production 路徑,所有 gate 啟用) 驗證 hidden gate。
//
// SANITY 紀錄(已驗證):移除 runContentGuard 內 `if (document.hidden) return;`
// 後,場景 A 斷言 fail(英文被 guard 修復成中文)→ 還原 fix → 全綠。
import { test, expect } from '../fixtures/extension.js';
import { loadFixtureResponse, getShinkansenEvaluator, runTestInject } from './helpers/run-inject.js';

const FIXTURE = 'guard-overwrite';
const TARGET_SELECTOR = 'p#target';

test('guard-hidden-tab-gate: document.hidden=true 時 production guard 跳過 sweep,visible 時恢復修復', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(TARGET_SELECTOR, { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);
  const translation = loadFixtureResponse(FIXTURE);

  const overwriteText = 'The quick brown fox jumps over the lazy dog near the riverbank on a sunny afternoon';

  // Setup: 注入譯文,設定 STATE.translated=true(production guard 入口需要)
  await runTestInject(evaluate, TARGET_SELECTOR, translation);
  await evaluate(`window.__shinkansen.setTestState({ translated: true })`);

  // 場景 A: document.hidden=true 時呼叫 production guard,應跳過修復
  await evaluate(`(() => {
    document.querySelector(${JSON.stringify(TARGET_SELECTOR)}).innerHTML = ${JSON.stringify(overwriteText)};
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    window.__SK._testRunContentGuardProd();
  })()`);

  const afterHiddenGuard = await page.evaluate(
    (sel) => document.querySelector(sel).textContent,
    TARGET_SELECTOR,
  );
  expect(
    afterHiddenGuard,
    'document.hidden=true 時 production guard 應跳過,英文應保留',
  ).toContain('quick brown fox');
  expect(
    afterHiddenGuard,
    'document.hidden=true 時不應修復為中文',
  ).not.toContain('棕色狐狸');

  // 場景 B: 切回 visible 後再呼叫 guard,應修復為中文
  await evaluate(`(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    window.__SK._testRunContentGuardProd();
  })()`);

  const afterVisibleGuard = await page.evaluate(
    (sel) => document.querySelector(sel).textContent,
    TARGET_SELECTOR,
  );
  expect(
    afterVisibleGuard,
    'document.hidden=false 時 guard 應修復為中文',
  ).toContain('棕色狐狸');

  await page.close();
});
