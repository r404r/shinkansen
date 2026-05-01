// Regression: sticky cross-tab 不應繼承 — Cmd+T 等價路徑（v1.8.24）
//
// 背景：v1.4.11 用 `chrome.tabs.onCreated.openerTabId` 判斷「使用者從翻譯過的 tab
// 點連結開新 tab」，但現代 Chrome 對 Cmd+T 開的新 tab 也會把 openerTabId 設為當下
// active tab（受 tab grouping / new-tab placement 影響），導致使用者 Cmd+T → 打網址
// 開的新 tab 也誤繼承 sticky slot，被自動翻譯（非預期）。
//
// v1.8.24 修法：改用 `chrome.webNavigation.onCreatedNavigationTarget`——這個事件
// 只 fire 在「使用者點連結造成新 tab」的情境（target=_blank / middle-click /
// Cmd+click / window.open），不 fire 在 Cmd+T → 打網址 / bookmark / 外部 app /
// 程式化 chrome.tabs.create。
//
// Playwright 的 `context.newPage()` 走 CDP `Target.createTarget` 開新 tab，
// 行為等價於「程式化開新 tab」——不會觸發 onCreatedNavigationTarget，剛好用來
// 驗證 v1.8.24 修法：新開的 tab 即使 `stickyTabs` 內已有 active tab 的 entry，
// 新 tab 的 STICKY_QUERY 也應該回 shouldTranslate=false。
//
// 對應正向測試（window.open → 應繼承）見 sticky-cross-tab.spec.js test (1)。
//
// SANITY 紀錄（已驗證）：把 background.js 的 webNavigation.onCreatedNavigationTarget
// listener 改回舊的 tabs.onCreated.openerTabId 路徑（即 v1.8.23 行為），test fail
// （context.newPage() 開的新 tab 也會誤繼承 sticky=true）。還原 v1.8.24 後 pass。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const SLOT = 2;

const _evalCache = new WeakMap();
async function sendMessageFrom(page, msg) {
  let evaluate = _evalCache.get(page);
  if (!evaluate) {
    evaluate = (await getShinkansenEvaluator(page)).evaluate;
    _evalCache.set(page, evaluate);
  }
  return JSON.parse(
    await evaluate(`(async () => JSON.stringify(await chrome.runtime.sendMessage(${JSON.stringify(msg)})))()`)
  );
}

test('sticky-cross-tab: Cmd+T 等價路徑（context.newPage）不繼承 sticky', async ({
  context,
  localServer,
}) => {
  // Page A 設 sticky
  const pageA = await context.newPage();
  await pageA.goto(`${localServer.baseUrl}/br-paragraph.html`, { waitUntil: 'domcontentloaded' });
  await pageA.waitForSelector('#target', { timeout: 10_000 });
  const setResp = await sendMessageFrom(pageA, { type: 'STICKY_SET', payload: { slot: SLOT } });
  expect(setResp?.ok, 'STICKY_SET 應成功').toBe(true);

  // Sanity: Page A 自己 query 應 true
  const queryA = await sendMessageFrom(pageA, { type: 'STICKY_QUERY' });
  expect(queryA?.shouldTranslate, 'sanity: Page A 設完應為 true').toBe(true);

  // 直接用 context.newPage() 開新 tab（CDP Target.createTarget，等價 Cmd+T 程式化開）
  // 注意：這條路徑不會 fire webNavigation.onCreatedNavigationTarget，
  // 也就不會觸發 v1.8.24 的繼承 listener
  const pageB = await context.newPage();
  await pageB.goto(`${localServer.baseUrl}/br-paragraph.html`, { waitUntil: 'domcontentloaded' });
  await pageB.waitForSelector('#target', { timeout: 10_000 });

  // 給 background listener 一些時間（即使不該 fire 也等一下，避免測得太早）
  await pageB.waitForTimeout(500);

  // 核心斷言：Page B 不應繼承 sticky
  const queryB = await sendMessageFrom(pageB, { type: 'STICKY_QUERY' });
  expect(
    queryB?.shouldTranslate,
    `Page B（context.newPage 等價 Cmd+T）不應繼承 sticky，實際 ${JSON.stringify(queryB)}`,
  ).toBe(false);
  expect(
    queryB?.slot,
    `Page B 不應有 slot，實際 ${JSON.stringify(queryB)}`,
  ).toBeNull();

  await pageB.close();
  await pageA.close();
});
