// Regression: v1.6.8 翻譯進度通知 master switch
//
// 結構特徵：使用者要求「完全關閉翻譯進度通知」的選項。content-toast.js 內部
// 用 IIFE local 變數 `showProgressToast` 持有狀態，從 storage.sync 載入並透過
// onChanged listener 同步。SK.showToast 入口讀 SK.shouldShowToast() 短路。
//
// 驗證：
//   (1) 預設 showProgressToast=true（DEFAULTS）→ SK.shouldShowToast() 回 true
//   (2) storage.sync.set({ showProgressToast: false }) → onChanged listener 同步
//       → SK.shouldShowToast() 回 false
//   (3) 重新設回 true → SK.shouldShowToast() 回 true
//
// 為什麼用 SK.shouldShowToast() 而非觀察 toast DOM：
//   toast 在 closed Shadow root 內，spec 從外部看不到 shadow 內的 .show class；
//   暴露 query 函式（與 SK.shouldDisableInFrame 同 pattern）兼具可測性與封裝。
//
// SANITY 紀錄（已驗證）：把 SK.showToast 入口的 `if (!SK.shouldShowToast()) return;`
// 拿掉，本 spec 仍會 pass（因為只測 query 函式回傳值，不測 short-circuit 行為）；
// 改測 query 函式的「設了 false 仍回 true」這條 SANITY → 把
// `function shouldShowToast() { return showProgressToast; }` 改成 `return true;`
// → 第 (2) 條 fail。還原後 pass。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

test('toast-master-switch: SK.shouldShowToast() 跟著 storage.showProgressToast 變化', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/dual.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#basic', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // 等 content-toast.js 載入後初次讀 storage 完成
  // 給 50ms 讓 storage.get 的 promise resolve
  await page.waitForTimeout(100);

  // (1) 預設 true（DEFAULTS.showProgressToast）
  const initial = await evaluate(`window.__SK.shouldShowToast()`);
  expect(initial, '預設應為 true').toBe(true);

  // (2) 設 false → onChanged listener 同步
  await evaluate(`browser.storage.sync.set({ showProgressToast: false })`);
  // onChanged 是非同步觸發，等一下
  const start = Date.now();
  let afterFalse = true;
  while (Date.now() - start < 2000) {
    afterFalse = await evaluate(`window.__SK.shouldShowToast()`);
    if (afterFalse === false) break;
    await page.waitForTimeout(50);
  }
  expect(afterFalse, '設成 false 後 SK.shouldShowToast() 應回 false').toBe(false);

  // (3) 設回 true → 應恢復顯示
  await evaluate(`browser.storage.sync.set({ showProgressToast: true })`);
  const start2 = Date.now();
  let afterTrue = false;
  while (Date.now() - start2 < 2000) {
    afterTrue = await evaluate(`window.__SK.shouldShowToast()`);
    if (afterTrue === true) break;
    await page.waitForTimeout(50);
  }
  expect(afterTrue, '設回 true 後 SK.shouldShowToast() 應回 true').toBe(true);

  // 清理：把 storage 還原成 DEFAULTS（避免影響後續 spec）
  await evaluate(`browser.storage.sync.remove('showProgressToast')`);

  await page.close();
});
