'use strict';

/**
 * v1.4.21 regression: popup YouTube 字幕勾勾「顯示」與「動作」對齊到同一語意。
 *
 * Bug（v1.4.13–v1.4.20）：
 *   - 顯示：popup 勾勾狀態 = 讀 ytSubtitle.autoTranslate 設定值
 *   - 動作：popup 點擊送 TOGGLE_SUBTITLE → content.js 呼叫 translateYouTubeSubtitles()
 *           這個函式依 YT.active 翻面（active=true → 停、false → 啟）
 *   當「設定值」跟「YT.active」desync 時，點擊結果與勾勾狀態相反。
 *   最常見 desync：使用者用 Alt+S 手動啟動過（YT.active=true 但設定=false），
 *   或 init 800ms 延遲窗口內點擊（設定=true 但 YT.active 還是 false）。
 *
 * 修法：
 *   - popup 送 SET_SUBTITLE { enabled }（勾=true, 不勾=false）
 *   - content.js handler 讀 enabled + 當前 YT.active，分四支：
 *       enabled=true  + active=false → 呼叫 translateYouTubeSubtitles（啟動）
 *       enabled=false + active=true  → 呼叫 stopYouTubeTranslation（停止）
 *       enabled=true  + active=true  → no-op（已是期望狀態）
 *       enabled=false + active=false → no-op
 *   - 這樣勾勾即「期望狀態」，點擊結果永遠跟著勾勾走，不再受 YT.active 當前值影響。
 *
 * 這組 test 四條 scenario 直接模擬 chrome.runtime.onMessage 呼叫 content.js 的
 * listener，並攔截 SK.translateYouTubeSubtitles / SK.stopYouTubeTranslation 觀察
 * 呼叫次數，驗證四種分支都走對路。
 */

const { createEnv } = require('./helpers/create-env.cjs');

describe('v1.4.21: SET_SUBTITLE 取代 TOGGLE_SUBTITLE', () => {
  let env;
  afterEach(() => { if (env) { env.cleanup(); env = null; } });

  // Helper：在 isolated world 安裝 stub + 觸發 content.js 的 runtime.onMessage listener
  // content.js 本身在 eval 時會呼叫 chrome.runtime.onMessage.addListener(fn) 把 fn 註冊進去。
  // create-env.cjs 的 mock 會把 fn 存進 addListener.mock.calls，直接取出調用即可。
  function setupStubs() {
    const SK = env.window.__SK;
    // 初始化 SK.YT 避免 handler 讀 SK.YT.active 時丟 undefined
    if (!SK.YT) SK.YT = { active: false };
    const startCalls = [];
    const stopCalls = [];
    SK.translateYouTubeSubtitles = () => {
      startCalls.push(Date.now());
      SK.YT.active = true;
      return Promise.resolve();
    };
    SK.stopYouTubeTranslation = () => {
      stopCalls.push(Date.now());
      SK.YT.active = false;
    };
    return { startCalls, stopCalls, SK };
  }

  function invokeContentMessage(msg) {
    // content.js 的 runtime.onMessage listener 在載入時註冊。create-env 的 mock
    // 會把 listener 塞進 addListener.mock.calls。拿第一個（也是唯一一個 content.js 註冊的）。
    const addListener = env.chrome.runtime.onMessage.addListener;
    const listener = addListener.mock.calls[0][0];
    listener(msg, {}, () => {});
  }

  test('enabled=true + 目前未翻譯 → 啟動翻譯', async () => {
    env = createEnv({ url: 'https://www.youtube.com/watch?v=abc' });
    const { startCalls, stopCalls, SK } = setupStubs();
    SK.YT.active = false;

    invokeContentMessage({ type: 'SET_SUBTITLE', payload: { enabled: true } });
    await new Promise(r => setTimeout(r, 30));

    expect(startCalls.length).toBe(1);
    expect(stopCalls.length).toBe(0);
  });

  test('enabled=false + 目前正在翻譯 → 停止翻譯', async () => {
    env = createEnv({ url: 'https://www.youtube.com/watch?v=abc' });
    const { startCalls, stopCalls, SK } = setupStubs();
    SK.YT.active = true;

    invokeContentMessage({ type: 'SET_SUBTITLE', payload: { enabled: false } });
    await new Promise(r => setTimeout(r, 30));

    expect(startCalls.length).toBe(0);
    expect(stopCalls.length).toBe(1);
  });

  test('enabled=true + 已經在翻譯 → no-op（不再啟動一次）', async () => {
    env = createEnv({ url: 'https://www.youtube.com/watch?v=abc' });
    const { startCalls, stopCalls, SK } = setupStubs();
    SK.YT.active = true;

    invokeContentMessage({ type: 'SET_SUBTITLE', payload: { enabled: true } });
    await new Promise(r => setTimeout(r, 30));

    expect(startCalls.length).toBe(0);
    expect(stopCalls.length).toBe(0);
  });

  test('enabled=false + 本來就沒在翻 → no-op', async () => {
    env = createEnv({ url: 'https://www.youtube.com/watch?v=abc' });
    const { startCalls, stopCalls, SK } = setupStubs();
    SK.YT.active = false;

    invokeContentMessage({ type: 'SET_SUBTITLE', payload: { enabled: false } });
    await new Promise(r => setTimeout(r, 30));

    expect(startCalls.length).toBe(0);
    expect(stopCalls.length).toBe(0);
  });

  // v1.4.21 前的 bug 重現：YT.active=true + enabled=true（使用者剛勾起）應 no-op，
  // 但舊 TOGGLE_SUBTITLE 會呼叫 translateYouTubeSubtitles → 翻面 → stopYouTubeTranslation。
  // 這條 test 鎖死「不該因為勾起而停掉已在翻的」。
  test('desync 重現：YT.active=true + 勾起（enabled=true）不該停止翻譯', async () => {
    env = createEnv({ url: 'https://www.youtube.com/watch?v=abc' });
    const { startCalls, stopCalls, SK } = setupStubs();
    SK.YT.active = true;  // 使用者先用 Alt+S 手動啟動過

    // 使用者現在勾起 popup 的 toggle（想開自動翻譯）
    invokeContentMessage({ type: 'SET_SUBTITLE', payload: { enabled: true } });
    await new Promise(r => setTimeout(r, 30));

    // 期望：已經在翻，勾起只是確認「我要翻」，不該觸發任何動作
    expect(stopCalls.length).toBe(0);    // 舊 bug：會變 1（停掉了）
    expect(startCalls.length).toBe(0);
    expect(SK.YT.active).toBe(true);     // 翻譯狀態保持
  });
});
