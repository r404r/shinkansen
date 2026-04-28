// Regression: Bing 翻譯 e2e 完整路徑（Nozomi 獨立功能）
//
// 驗證 translateUnitsGoogle(units, { messageType: 'TRANSLATE_BATCH_BING' }) 的完整路徑：
//   (1) 翻譯 message type 為 TRANSLATE_BATCH_BING（不是 TRANSLATE_BATCH_GOOGLE）
//   (2) TRANSLATE_BATCH_STREAM 不被觸發（Bing 不走 streaming）
//   (3) toast 進度使用 Bing 專屬 i18n key
//   (4) 翻譯結果正確注入 DOM
//   (5) handleTranslatePreset 路由 engine='bing' → translatePageGoogle({_bingMode:true})
//
// Mock 策略：在 isolated world 替換 chrome.runtime.sendMessage + chrome.storage.sync.get，
// 透過 SK.translateUnitsGoogle 直接測試批次翻譯，觀察 message type 和 DOM 注入結果。
// 使用 fake units（手動建構 paragraphs）避免依賴 collectParagraphs 的 DOM 結構。
//
// SANITY CHECK 紀錄（已驗證，2026-04-28）：
//   把 content.js translateUnitsGoogle 的 _msgType 硬編碼成 'TRANSLATE_BATCH_GOOGLE'
//   → messageType 斷言 fail（messageLog 只有 TRANSLATE_BATCH_GOOGLE）。還原後 pass。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'translate-priority-sort';

test('bing-e2e: translateUnitsGoogle 帶 TRANSLATE_BATCH_BING message type', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('main#content-main', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // 設定 mock
  await evaluate(`
    window.__messageLog = [];
    chrome.runtime.sendMessage = async function(msg) {
      window.__messageLog.push(msg.type);
      if (msg.type === 'TRANSLATE_BATCH_BING') {
        const texts = (msg.payload && msg.payload.texts) || [];
        return {
          ok: true,
          result: texts.map(t => '[Bing] ' + t.substring(0, 30)),
          usage: { engine: 'bing', chars: 100, cacheHits: 0 },
        };
      }
      if (msg.type === 'TRANSLATE_BATCH_STREAM') {
        return { ok: false, error: 'not supported' };
      }
      return { ok: true };
    };
  `);

  // 建構 fake units 並呼叫 translateUnitsGoogle with Bing message type
  const result = await evaluate(`
    (async () => {
      const SK = window.__SK;
      // 建構 fake units
      const root = document.createElement('div');
      root.id = '__bing-test';
      for (let i = 0; i < 5; i++) {
        const p = document.createElement('p');
        p.textContent = 'Bing test paragraph number ' + i + ' with some English text here';
        root.appendChild(p);
      }
      document.body.appendChild(root);
      const units = Array.from(root.children).map(el => ({ kind: 'element', el }));

      // 呼叫 translateUnitsGoogle with Bing message type
      const { done, total, failures, chars } = await SK.translateUnitsGoogle(units, {
        messageType: 'TRANSLATE_BATCH_BING',
      });

      return {
        done,
        total,
        failures: failures.length,
        messageLog: window.__messageLog,
        hasBingMsg: window.__messageLog.includes('TRANSLATE_BATCH_BING'),
        hasGoogleMsg: window.__messageLog.includes('TRANSLATE_BATCH_GOOGLE'),
        hasStreamMsg: window.__messageLog.includes('TRANSLATE_BATCH_STREAM'),
      };
    })()
  `);

  expect(result.hasBingMsg, 'TRANSLATE_BATCH_BING 應被呼叫').toBe(true);
  expect(result.hasGoogleMsg, 'TRANSLATE_BATCH_GOOGLE 不應被呼叫').toBe(false);
  expect(result.hasStreamMsg, 'TRANSLATE_BATCH_STREAM 不應被呼叫').toBe(false);
  expect(result.done).toBe(5);
  expect(result.total).toBe(5);
  expect(result.failures).toBe(0);
});

test('bing-e2e: Bing 翻譯結果正確注入 DOM', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('main#content-main', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  await evaluate(`
    chrome.runtime.sendMessage = async function(msg) {
      if (msg.type === 'TRANSLATE_BATCH_BING') {
        const texts = (msg.payload && msg.payload.texts) || [];
        return {
          ok: true,
          result: texts.map(() => '必應翻譯結果'),
          usage: { engine: 'bing', chars: 50, cacheHits: 0 },
        };
      }
      return { ok: true };
    };
  `);

  const result = await evaluate(`
    (async () => {
      const SK = window.__SK;
      const root = document.createElement('div');
      root.id = '__bing-inject-test';
      for (let i = 0; i < 3; i++) {
        const p = document.createElement('p');
        p.textContent = 'Original English text for injection test ' + i;
        root.appendChild(p);
      }
      document.body.appendChild(root);
      const units = Array.from(root.children).map(el => ({ kind: 'element', el }));

      await SK.translateUnitsGoogle(units, { messageType: 'TRANSLATE_BATCH_BING' });

      // 檢查 DOM 注入結果
      const injected = Array.from(root.querySelectorAll('p')).map(p => p.textContent);
      return {
        injected,
        hasTranslatedText: injected.some(t => t.includes('必應翻譯結果')),
      };
    })()
  `);

  expect(result.hasTranslatedText, 'DOM 中應包含 Bing 譯文「必應翻譯結果」').toBe(true);
});

test('bing-e2e: handleTranslatePreset(bing) 路由到 translatePageGoogle(_bingMode)', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('main#content-main', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // Mock translatePageGoogle 以觀察 _bingMode 參數
  await evaluate(`
    window.__capturedGtOptions = null;
    const SK = window.__SK;
    window.__origTranslatePageGoogle = SK.translatePageGoogle;
    SK.translatePageGoogle = function(opts) {
      window.__capturedGtOptions = opts;
      // 不真的翻譯，只記錄參數
    };

    // Mock storage — 同時 mock browser 和 chrome 確保 compat.js proxy 也覆蓋
    const mockGet = async function() {
      return {
        translatePresets: [
          { slot: 3, engine: 'bing', label: 'Bing Translate' },
        ],
      };
    };
    chrome.storage.sync.get = mockGet;
    if (typeof browser !== 'undefined' && browser.storage && browser.storage.sync) {
      browser.storage.sync.get = mockGet;
    }
  `);

  // 觸發 handleTranslatePreset（async，需等完成）
  await evaluate(`
    window.__SK.handleTranslatePreset(3);
  `);

  // 等 async 完成
  await page.waitForTimeout(500);

  const result = await evaluate(`
    (() => {
      const opts = window.__capturedGtOptions;
      window.__SK.translatePageGoogle = window.__origTranslatePageGoogle;
      return {
        captured: !!opts,
        bingMode: opts?._bingMode,
        slot: opts?.slot,
        label: opts?.label,
      };
    })()
  `);

  expect(result.captured, 'translatePageGoogle 應被呼叫').toBe(true);
  expect(result.bingMode, '_bingMode 應為 true').toBe(true);
  expect(result.slot).toBe(3);
  expect(result.label).toBe('Bing Translate');
});

test('bing-e2e: Bing 翻譯 toast 使用 Bing 專屬 i18n key（不含 Google）', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('main#content-main', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // Mock sendMessage + 攔截 showToast
  await evaluate(`
    window.__toastCalls = [];
    const origToast = window.__SK.showToast;
    window.__SK.showToast = function(type, msg, opts) {
      window.__toastCalls.push({ type, msg });
      return origToast.call(window.__SK, type, msg, opts);
    };

    chrome.runtime.sendMessage = async function(msg) {
      if (msg.type === 'TRANSLATE_BATCH_BING') {
        const texts = (msg.payload && msg.payload.texts) || [];
        return {
          ok: true,
          result: texts.map(t => '[Bing] ' + t.substring(0, 30)),
          usage: { engine: 'bing', chars: 100, cacheHits: 0 },
        };
      }
      return { ok: true };
    };
  `);

  // 觸發 Bing 翻譯（透過 translatePageGoogle 路徑）
  await evaluate(`
    (async () => {
      const SK = window.__SK;
      const STATE = SK.STATE;
      // 重置翻譯狀態
      STATE.translated = false;
      STATE.translating = false;
      STATE.translatedBy = null;
      STATE.abortController = null;

      // mock storage for translatePageGoogle path
      chrome.storage.sync.get = async function() {
        return {
          maxUnitsPerBatch: 50,
          maxConcurrentBatches: 4,
          stickyTranslateEnabled: false,
        };
      };

      await SK.translatePageGoogle({ _bingMode: true });
    })()
  `);

  // 等翻譯完成
  await page.waitForTimeout(2000);

  const result = await evaluate(`
    (() => {
      const toasts = window.__toastCalls;
      const loading = toasts.filter(t => t.type === 'loading');
      const success = toasts.filter(t => t.type === 'success');
      // 還原 showToast
      window.__SK.showToast = window.__toastCalls = null;
      return {
        loadingMsgs: loading.map(t => t.msg),
        successMsgs: success.map(t => t.msg),
        hasLoadingBing: loading.some(t => t.msg.includes('Bing')),
        hasLoadingGoogle: loading.some(t => t.msg.includes('Google')),
      };
    })()
  `);

  expect(result.hasLoadingBing, 'loading toast 應包含 Bing 字樣').toBe(true);
  expect(result.hasLoadingGoogle, 'loading toast 不應包含 Google 字樣').toBe(false);
});
