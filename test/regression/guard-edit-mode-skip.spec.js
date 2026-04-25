// Regression: guard-edit-mode-skip (對應 v1.5.5)
//
// Fixture: test/regression/fixtures/edit-mode-guard-skip.html
//
// 結構通則 (不綁站名): 使用者按 popup「編輯譯文」進入編輯模式後，翻譯元素被
// 加上 contenteditable="true"。使用者改 innerHTML 是預期行為，Content Guard
// 不能 1s 後把使用者的編輯蓋回原譯文；按「結束編輯」後 contenteditable 雖被
// 移除，但快取必須同步更新成使用者編輯後的版本，guard 才不會在下次 sweep
// 時把編輯蓋回原譯文。
//
// 修法兩處：
//   1. content-spa.js runContentGuard / testRunContentGuard：迭代
//      STATE.translatedHTML 時 contenteditable === 'true' 的元素 continue。
//   2. content.js toggleEditMode(false)：結束編輯時把每個元素當前 innerHTML
//      寫回 STATE.translatedHTML，當作新 baseline。
//
// SANITY 紀錄 (已驗證 2026-04-25):
//   情境 1（編輯中）：拿掉 content-spa.js 的 contenteditable skip → spec fail。
//   情境 2（結束後）：拿掉 content.js toggleEditMode(false) 的 STATE.translatedHTML.set
//                     → spec fail（restored=1，innerHTML 被蓋回原譯文）。
import { test, expect } from '../fixtures/extension.js';
import { loadFixtureResponse, getShinkansenEvaluator, runTestInject } from './helpers/run-inject.js';

const FIXTURE = 'edit-mode-guard-skip';
const TARGET_SELECTOR = 'p#target';

test('guard-edit-mode-skip: 編輯中 guard 跳過、結束編輯後 guard 不蓋編輯', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(TARGET_SELECTOR, { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);
  const translation = loadFixtureResponse(FIXTURE);

  // 步驟 1: 注入譯文（填 STATE.translatedHTML 快取）
  await runTestInject(evaluate, TARGET_SELECTOR, translation);

  // 步驟 2: 模擬翻譯完成
  await evaluate(`window.__shinkansen.setTestState({ translated: true })`);
  const stateAfterInject = JSON.parse(await evaluate(`JSON.stringify(window.__shinkansen.getState())`));
  expect(stateAfterInject.guardCacheSize, 'guard 快取應有 1 條').toBeGreaterThanOrEqual(1);

  // 步驟 3: 進入編輯模式（toggleEditMode(true) 會掛 contenteditable="true"）
  const enterRaw = await evaluate(`JSON.stringify(window.__shinkansen.testToggleEditMode(true))`);
  const enterResp = JSON.parse(enterRaw);
  expect(enterResp.editing, '應進入編輯模式').toBe(true);

  // 步驟 4: 模擬使用者編輯 innerHTML（刪一個字 + 加一個字）
  const USER_EDIT = '使用者編輯後的內容';
  await page.evaluate(({ sel, html }) => {
    document.querySelector(sel).innerHTML = html;
  }, { sel: TARGET_SELECTOR, html: USER_EDIT });

  expect(
    await page.evaluate((sel) => document.querySelector(sel).textContent, TARGET_SELECTOR),
    '使用者編輯應生效',
  ).toBe(USER_EDIT);

  // 步驟 5: 編輯中觸發 guard——應跳過 contenteditable 元素
  const restoredDuring = Number(await evaluate(`window.__shinkansen.testRunContentGuard()`));
  expect(restoredDuring, '編輯中 guard 應跳過 contenteditable 元素').toBe(0);
  expect(
    await page.evaluate((sel) => document.querySelector(sel).textContent, TARGET_SELECTOR),
    '編輯中 guard 後內容應仍是使用者編輯',
  ).toBe(USER_EDIT);

  // 步驟 6: 結束編輯（toggleEditMode(false)）
  const exitRaw = await evaluate(`JSON.stringify(window.__shinkansen.testToggleEditMode(false))`);
  const exitResp = JSON.parse(exitRaw);
  expect(exitResp.editing, '應結束編輯模式').toBe(false);

  // 確認 contenteditable 已移除
  const ceAttr = await page.evaluate(
    (sel) => document.querySelector(sel).getAttribute('contenteditable'),
    TARGET_SELECTOR,
  );
  expect(ceAttr, '結束編輯後 contenteditable 應移除').toBeNull();

  // 步驟 7: 再跑 guard——這次元素不再 contenteditable，但快取應已更新成使用者編輯的版本
  const restoredAfter = Number(await evaluate(`window.__shinkansen.testRunContentGuard()`));
  expect(restoredAfter, '結束編輯後 guard 不應修復（快取已更新成使用者編輯）').toBe(0);

  // 斷言核心：使用者編輯不可被 guard 蓋回原譯文
  expect(
    await page.evaluate((sel) => document.querySelector(sel).textContent, TARGET_SELECTOR),
    '結束編輯 + guard sweep 後內容必須仍是使用者編輯',
  ).toBe(USER_EDIT);

  await page.close();
});
