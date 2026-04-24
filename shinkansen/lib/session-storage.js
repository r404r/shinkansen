// session-storage.js — 跨平台 session storage 抽象
// Chrome: 使用 browser.storage.session（瀏覽器關閉後自動清除）
// Firefox: fallback 到 browser.storage.local + 前綴隔離 + 啟動時清除
//
// 用法：
//   import { sessionStore } from './session-storage.js';
//   await sessionStore.clearOnStartup();  // service worker 啟動時呼叫一次
//   const value = await sessionStore.get('stickyTabs');
//   await sessionStore.set('stickyTabs', value);

import { browser } from './compat.js';

const PREFIX = '_sk_session_';

// 編譯時由 esbuild 注入 __BROWSER__；直接開發時 fallback 到執行期偵測
const hasSessionAPI = (typeof __BROWSER__ !== 'undefined')
  ? __BROWSER__ === 'chrome'
  : !!browser.storage?.session;

export const sessionStore = {
  /**
   * Firefox fallback: 清除所有 _sk_session_ 前綴的 key。
   * 應在 service worker 啟動（onInstalled / 模組頂層）時呼叫一次，
   * 模擬 storage.session 在瀏覽器重啟後自動清空的行為。
   * Chrome 使用原生 storage.session，此方法為 no-op。
   */
  async clearOnStartup() {
    if (hasSessionAPI) return; // Chrome: session storage 自動清除
    try {
      const all = await browser.storage.local.get(null);
      const sessionKeys = Object.keys(all).filter(k => k.startsWith(PREFIX));
      if (sessionKeys.length > 0) {
        await browser.storage.local.remove(sessionKeys);
      }
    } catch { /* 靜默失敗 */ }
  },

  async get(key) {
    if (hasSessionAPI) {
      const result = await browser.storage.session.get(key);
      return result[key];
    }
    const prefixedKey = PREFIX + key;
    const result = await browser.storage.local.get(prefixedKey);
    return result[prefixedKey];
  },

  async set(key, value) {
    if (hasSessionAPI) {
      await browser.storage.session.set({ [key]: value });
      return;
    }
    await browser.storage.local.set({ [PREFIX + key]: value });
  },
};
