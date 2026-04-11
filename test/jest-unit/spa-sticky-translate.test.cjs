'use strict';

/**
 * v1.0.23 regression: SPA 續翻模式 (sticky translate)
 *
 * Bug：在 Gmail inbox 翻譯完成後，點進一封 email 不會自動翻譯信件內容；
 *      退出 email 回到 inbox 時，原本翻好的主旨/預覽恢復成英文。
 *
 * 修法：
 *   - 新增 STATE.stickyTranslate — 手動翻譯成功後自動開啟
 *   - hashchange 事件監聽（Gmail 用 hash-based 路由，不走 pushState）
 *   - handleSpaNavigation 中 stickyTranslate 優先於白名單，直接呼叫 translatePage
 *   - restorePage 時關閉 stickyTranslate
 *
 * 這組測試驗證上述四個修法的行為。
 */

const { createEnv, waitForCondition } = require('./helpers/create-env.cjs');

describe('v1.0.23: SPA 續翻模式 (sticky translate)', () => {
  let env;

  afterEach(() => {
    if (env) { env.cleanup(); env = null; }
  });

  test('hashchange + stickyTranslate=true → 觸發 translatePage', async () => {
    env = createEnv({ url: 'https://mail.google.com/mail/u/0/#inbox' });

    // 模擬：使用者已手動翻譯 → translated=true, stickyTranslate=true
    env.shinkansen.setTestState({ translated: true, stickyTranslate: true });

    // 模擬 Gmail hash navigation（使用者點進一封 email）
    env.navigateHash('https://mail.google.com/mail/u/0/#inbox/FMfcgzQXKzgfBbGPNjKnGjTdbRMpNBFM');

    // handleSpaNavigation 是 async 函式，內部流程：
    //   1. resetForSpaNavigation()       — 立刻執行（translated → false）
    //   2. await setTimeout(800ms)        — 等 DOM 穩定 (SPA_NAV_SETTLE_MS)
    //   3. if (wasSticky) translatePage() — 因為 sticky=true，呼叫翻譯
    //   4. translatePage() → chrome.storage.sync.get(['apiKey', ...]) — 讀取設定

    // 直接斷言 1：resetForSpaNavigation 會立刻把 translated 清掉
    // （不需要等——hashchange handler 是同步啟動 reset 的）
    await waitForCondition(() => env.shinkansen.getState().translated === false, { timeout: 300 });
    expect(env.shinkansen.getState().translated).toBe(false);

    // 直接斷言 2：等 translatePage 被呼叫
    // translatePage 內部會依序呼叫 storage.sync.get('skipTraditionalChinesePage')，
    // 這是 translatePage 專屬的呼叫，handleSpaNavigation 本身不會叫它。
    const gotTranslateCall = await waitForCondition(() => {
      return env.chrome.storage.sync.get.mock.calls.some(
        ([keys]) => keys === 'skipTraditionalChinesePage'
      );
    }, { timeout: 2000 });
    expect(gotTranslateCall).toBe(true);
  });

  test('hashchange + stickyTranslate=false → 不觸發 translatePage（無白名單）', async () => {
    env = createEnv({ url: 'https://mail.google.com/mail/u/0/#inbox' });

    // 翻譯完成但 sticky 模式關閉
    env.shinkansen.setTestState({ translated: true, stickyTranslate: false });

    // 清掉載入時的呼叫記錄，確保斷言精準
    env.chrome.storage.sync.get.mockClear();

    env.navigateHash('https://mail.google.com/mail/u/0/#inbox/FMfcgzQXKzgfBbGPNjKnGjTdbRMpNBFM');

    // 負向測試：等足夠時間讓 handleSpaNavigation 完整跑完（800ms settle + buffer）
    await new Promise(r => setTimeout(r, 1200));

    // 驗證 1：translatePage 沒被呼叫（不會出現 skipTraditionalChinesePage 的 storage 讀取）
    const hasTranslateCall = env.chrome.storage.sync.get.mock.calls.some(
      ([keys]) => keys === 'skipTraditionalChinesePage'
    );
    expect(hasTranslateCall).toBe(false);

    // 驗證 2：STATE 不會進入 translating 狀態
    const state = env.shinkansen.getState();
    expect(state.translating).toBe(false);
    // resetForSpaNavigation 會把 translated 清掉
    expect(state.translated).toBe(false);
  });

  test('restorePage 關閉 stickyTranslate', async () => {
    env = createEnv({ url: 'https://example.com/' });

    // 建立一段有內容的段落，讓 testInject + restorePage 有東西操作
    const p = env.document.createElement('p');
    p.textContent = 'Hello world this is a long paragraph for testing purposes only.';
    env.document.body.appendChild(p);

    // 注入翻譯 + 開啟 sticky 模式
    env.shinkansen.testInject(p, '你好世界，這是一段僅用於測試的長段落。');
    env.shinkansen.setTestState({ translated: true, stickyTranslate: true });
    expect(env.shinkansen.getState().stickyTranslate).toBe(true);

    // 透過 Debug Bridge 觸發 restorePage（等同使用者按 Option+S 還原）
    await new Promise(resolve => {
      env.window.addEventListener('shinkansen-debug-response', (e) => {
        resolve(e.detail);
      }, { once: true });
      env.window.dispatchEvent(new env.window.CustomEvent('shinkansen-debug-request', {
        detail: { action: 'RESTORE' },
      }));
    });

    // restorePage 會關閉 stickyTranslate（v1.0.23 修法的一部分）
    expect(env.shinkansen.getState().stickyTranslate).toBe(false);
    // 也會關閉 translated
    expect(env.shinkansen.getState().translated).toBe(false);
  });
});
