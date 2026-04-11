'use strict';

/**
 * v1.0.11 regression: SPA URL 輪詢 safety net
 *
 * Bug：在 Medium 翻譯完成後，點擊文章內的站內連結跳到新頁面，
 *      按 Option+S 顯示「已還原原文」而不是翻譯新頁面。
 *
 * 根因：React Router 在 module 初始化時快取 history.pushState 原始參照，
 *       content script 的 monkey-patch（document_idle 才跑）攔不到框架
 *       呼叫的 pushState。STATE.translated 沒有被重置。
 *
 * 修法：新增 500ms URL 輪詢 safety net，每 500ms 比對 location.href，
 *       偵測到變化就呼叫 handleSpaNavigation() 重置翻譯狀態。
 *
 * 這組測試驗證 URL 輪詢在各種情境下的行為：
 *   1. 基本偵測：URL 變了 → 觸發 handleSpaNavigation
 *   2. 捲動跳過：已翻譯 + 有翻譯節點 + 非 sticky → 視為捲動更新，不重設
 *   3. Sticky 覆蓋：sticky 模式下不跳過，即使有翻譯節點也觸發導航
 */

const { createEnv, waitForCondition } = require('./helpers/create-env.cjs');

describe('v1.0.11: SPA URL 輪詢偵測', () => {
  let env;

  afterEach(() => {
    if (env) { env.cleanup(); env = null; }
  });

  test('URL 變化被 500ms 輪詢偵測 → 觸發 handleSpaNavigation', async () => {
    env = createEnv({ url: 'https://medium.com/@user/article-1-abc123' });

    // 先設定 translated=true，這樣 resetForSpaNavigation 把它清成 false 時
    // 我們能用 getState().translated === false 作為直接斷言
    env.shinkansen.setTestState({ translated: true });

    // 靜默改變 URL（模擬框架用快取的 pushState 導航，monkey-patch 攔不到）
    // 注意：不觸發 hashchange 或 popstate，純粹改 location.href
    env.setUrl('https://medium.com/@user/article-2-def456');

    // 輪詢等待 translated 被清掉（證明 resetForSpaNavigation 跑了）
    // URL 輪詢 500ms + handleSpaNavigation 立刻呼叫 reset → 最多 ~600ms
    const resetHappened = await waitForCondition(
      () => env.shinkansen.getState().translated === false,
      { timeout: 2000 }
    );
    expect(resetHappened).toBe(true);
    expect(env.shinkansen.getState().translated).toBe(false);
  });

  test('已翻譯 + 有翻譯節點 + 非 sticky → URL 變化視為捲動更新，不重設', async () => {
    env = createEnv({ url: 'https://engadget.com/2026/04/article-1' });

    // 模擬：頁面已翻譯，且 DOM 裡有標記過的翻譯節點
    env.shinkansen.setTestState({ translated: true, stickyTranslate: false });
    const p = env.document.createElement('p');
    p.setAttribute('data-shinkansen-translated', 'true');
    p.textContent = '已翻譯的文章段落';
    env.document.body.appendChild(p);

    // 清掉載入時的記錄
    env.chrome.runtime.sendMessage.mockClear();

    // 靜默改變 URL（模擬 Engadget 無限捲動時用 replaceState 更新網址列）
    env.setUrl('https://engadget.com/2026/04/article-2');

    // 等輪詢觸發（500ms + buffer）
    await new Promise(r => setTimeout(r, 700));

    // URL 輪詢偵測到變化，但因為 translated=true + 有翻譯節點 + 非 sticky，
    // 判定為捲動型 URL 更新，只靜默同步 spaLastUrl，不呼叫 handleSpaNavigation。
    // 證據：不會發出 CLEAR_BADGE
    const clearBadgeCalls = env.chrome.runtime.sendMessage.mock.calls.filter(
      ([msg]) => msg && msg.type === 'CLEAR_BADGE'
    );
    expect(clearBadgeCalls.length).toBe(0);

    // translated 狀態應保持不變
    expect(env.shinkansen.getState().translated).toBe(true);
  });

  test('已翻譯 + 有翻譯節點 + sticky → URL 變化仍觸發導航', async () => {
    env = createEnv({ url: 'https://mail.google.com/mail/u/0/#inbox' });

    // 模擬：已翻譯 + sticky 模式開啟（Gmail 場景）
    env.shinkansen.setTestState({ translated: true, stickyTranslate: true });
    const p = env.document.createElement('p');
    p.setAttribute('data-shinkansen-translated', 'true');
    p.textContent = '已翻譯的信件主旨';
    env.document.body.appendChild(p);

    env.chrome.runtime.sendMessage.mockClear();

    // 靜默改變 URL（模擬 Gmail hash-based 導航被 URL 輪詢偵測到）
    env.setUrl('https://mail.google.com/mail/u/0/#inbox/FMfcgzQXKzgf');

    // 輪詢等待 translated 被清掉（證明 resetForSpaNavigation 跑了，
    // 代表 sticky 覆蓋了捲動跳過邏輯）
    const resetHappened = await waitForCondition(
      () => env.shinkansen.getState().translated === false,
      { timeout: 2000 }
    );
    expect(resetHappened).toBe(true);
    expect(env.shinkansen.getState().translated).toBe(false);
  });
});
