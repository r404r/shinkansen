'use strict';

/**
 * create-env.cjs — Jest 單元測試用的 content.js 載入 helper
 *
 * 做的事：
 *   1. 用 jsdom 建立一個假的瀏覽器環境（DOM、window、history 等）
 *   2. 加上假的 chrome.runtime / chrome.storage API
 *   3. 把 content.js eval 進去，讓它以為自己在真的 Chrome Extension 裡面跑
 *
 * 這樣就能測試 SPA 導航偵測、Content Guard 等涉及 chrome API 的邏輯，
 * 完全不需要動 shinkansen/ 裡面的任何程式碼。
 *
 * 已知的時間常數（content.js 內部定義，測試的 wait 時間依此推算）：
 *   SPA_URL_POLL_MS      = 500   — URL 輪詢間隔
 *   SPA_NAV_SETTLE_MS    = 800   — SPA 導航後等 DOM 穩定
 *   GUARD_SWEEP_INTERVAL = 1000  — Content Guard 週期性掃描
 */

const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

// 只讀一次 content.js 原始碼，所有 test 共用（不會被修改）
const CONTENT_JS_PATH = path.resolve(__dirname, '../../../shinkansen/content.js');
const contentCode = fs.readFileSync(CONTENT_JS_PATH, 'utf-8');

/**
 * 建立乾淨的 jsdom 環境並載入 content.js。
 *
 * @param {Object} [options]
 * @param {string} [options.url='https://example.com/'] — 初始 URL
 * @param {string} [options.html] — 初始 HTML（預設空 body）
 * @returns {{ dom, window, document, chrome, shinkansen, setUrl, navigateHash, cleanup }}
 */
function createEnv(options = {}) {
  const {
    url = 'https://example.com/',
    html = '<!DOCTYPE html><html><head></head><body></body></html>',
  } = options;

  const dom = new JSDOM(html, {
    url,
    runScripts: 'dangerously',   // 讓 window.eval() 能執行 content.js
    pretendToBeVisual: true,      // 提供 requestAnimationFrame、innerHeight 等
  });

  const win = dom.window;

  // ── Chrome API mock ──────────────────────────────────────
  // 只 mock content.js 實際會呼叫的方法，其他不需要。
  // 每個 mock 都用 jest.fn() 包裝，測試可以斷言呼叫次數與參數。
  const chromeMock = {
    runtime: {
      sendMessage: jest.fn().mockImplementation(() => Promise.resolve({})),
      getManifest: jest.fn().mockReturnValue({ version: '1.0.26' }),
      onMessage: { addListener: jest.fn() },
    },
    storage: {
      sync: {
        get: jest.fn().mockImplementation(() => Promise.resolve({})),
      },
      onChanged: { addListener: jest.fn() },
    },
  };
  win.chrome = chromeMock;

  // ── 載入 content.js ─────────────────────────────────────
  // content.js 是 IIFE，eval 後所有內部函式都在閉包裡，
  // 外部只能透過 window.__shinkansen API 互動。
  win.eval(contentCode);

  return {
    dom,
    window: win,
    document: win.document,
    chrome: chromeMock,
    shinkansen: win.__shinkansen,

    /**
     * 靜默改變 URL（不觸發任何事件）。
     * 用途：模擬 SPA 框架用快取的 pushState 導航（monkey-patch 攔不到）。
     * content.js 的 500ms URL 輪詢會偵測到這個變化。
     */
    setUrl(newUrl) {
      dom.reconfigure({ url: newUrl });
    },

    /**
     * 改變 URL + 手動觸發 hashchange 事件。
     * 用途：模擬 Gmail 等 hash-based SPA 的導航。
     */
    navigateHash(newUrl) {
      dom.reconfigure({ url: newUrl });
      win.dispatchEvent(new win.Event('hashchange'));
    },

    /**
     * 清理 jsdom 資源。每個 test 結束後呼叫。
     */
    cleanup() {
      win.close();
    },
  };
}

/**
 * 輪詢等待條件成立。用於正向測試（預期某狀態最終會變化）。
 * 負向測試（預期某事不發生）仍應使用固定等待。
 *
 * @param {Function} conditionFn — 回傳 truthy 代表條件成立
 * @param {Object} [opts]
 * @param {number} [opts.timeout=3000] — 最久等幾毫秒
 * @param {number} [opts.interval=50]  — 每幾毫秒檢查一次
 * @returns {Promise<boolean>} — true 表示條件在 timeout 內成立
 */
async function waitForCondition(conditionFn, { timeout = 3000, interval = 50 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (conditionFn()) return true;
    await new Promise(r => setTimeout(r, interval));
  }
  return false;
}

module.exports = { createEnv, waitForCondition };
