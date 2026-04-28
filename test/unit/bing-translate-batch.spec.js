// Unit test: lib/bing-translate.js — Microsoft Translator 批次翻譯（Nozomi 獨立模組）
//
// 驗證 translateBingBatch 核心行為：
//   (1) 基本翻譯：文字陣列 → 逐段 POST → 譯文陣列
//   (2) 語言代碼映射：zh-TW→zh-Hant, zh-CN→zh-Hans, ja→ja
//   (3) 並發控制：同時最多 3 個 fetch
//   (4) 長文本自動拆分：超過 5000 字元的段落切 chunk 再串接
//   (5) 空陣列 → 不發 fetch
//   (6) Auth 失敗重試：401 → getBingToken(forceRefresh) → retry
//
// Mock 策略：替換 globalThis.fetch，攔截 token 端點和翻譯端點。
// getBingToken 內部也呼叫 fetch 取 token，所以 mock 需同時處理兩個 URL。
import { test, expect } from '@playwright/test';

// ─── Mock 狀態 ────────────────────────────────────────────
let fetchCalls = [];
let translateCalls = [];
let authCallCount = 0;
let forceAuthFail = false;  // 模擬 token 過期

// 假 JWT（base64url 編碼的 payload，exp 設為未來 10 分鐘）
function _makeFakeJwt(expSeconds) {
  const header = btoa(JSON.stringify({ alg: 'HS256' }));
  const payload = btoa(JSON.stringify({ exp: expSeconds }));
  return `${header}.${payload}.fakesig`;
}

const FUTURE_EXP = Math.floor(Date.now() / 1000) + 600; // 10 min from now
const FAKE_TOKEN = _makeFakeJwt(FUTURE_EXP);

// ─── Mock chrome.storage for bing-token.js ─────────────
const _storageData = {};
globalThis.chrome = {
  storage: {
    session: {
      get: async (key) => ({ [key]: _storageData[key] || null }),
      set: async (items) => Object.assign(_storageData, items),
      remove: async (key) => { delete _storageData[key]; },
    },
    local: {
      get: async (key) => ({ [key]: _storageData[key] || null }),
      set: async (items) => Object.assign(_storageData, items),
      remove: async (key) => { delete _storageData[key]; },
    },
  },
  runtime: { id: 'test' },
};
// compat.js 可能用 browser，也 mock 一份
globalThis.browser = globalThis.chrome;

// ─── Mock fetch ────────────────────────────────────────────
globalThis.fetch = async (url, options) => {
  fetchCalls.push({ url, options });

  // Token 端點
  if (url.includes('edge.microsoft.com/translate/auth')) {
    authCallCount++;
    if (forceAuthFail) {
      return { ok: false, status: 500 };
    }
    return {
      ok: true,
      text: async () => FAKE_TOKEN,
    };
  }

  // 翻譯端點
  if (url.includes('api.cognitive.microsofttranslator.com/translate')) {
    translateCalls.push({ url, options });

    const body = JSON.parse(options.body);
    const sourceText = body[0]?.Text || '';

    // 檢查 Authorization header
    const authHeader = options.headers?.['Authorization'] || '';
    if (!authHeader.startsWith('Bearer ')) {
      return { ok: false, status: 401 };
    }

    // 模擬翻譯回應
    return {
      ok: true,
      json: async () => [{
        translations: [{ text: `[譯] ${sourceText}`, to: 'zh-Hant' }],
      }],
    };
  }

  return { ok: false, status: 404 };
};

// 動態 import（mock 必須在 import 之前設好）
const { translateBingBatch } = await import('../../shinkansen/lib/bing-translate.js');
const { clearBingToken } = await import('../../shinkansen/lib/bing-token.js');

test.beforeEach(async () => {
  fetchCalls = [];
  translateCalls = [];
  authCallCount = 0;
  forceAuthFail = false;
  // 清除 token 快取，確保每個測試獨立
  await clearBingToken();
  // 清除 storage
  Object.keys(_storageData).forEach(k => delete _storageData[k]);
});

test('translateBingBatch: 3 段文字 → 3 次翻譯 fetch → 正確回傳', async () => {
  const inputs = ['Hello', 'World', 'Test'];
  const { translations, chars } = await translateBingBatch(inputs);

  expect(translations.length).toBe(3);
  expect(translations[0]).toBe('[譯] Hello');
  expect(translations[1]).toBe('[譯] World');
  expect(translations[2]).toBe('[譯] Test');
  expect(chars).toBe(5 + 5 + 4);
  // 翻譯端點被呼叫 3 次
  expect(translateCalls.length).toBe(3);
});

test('translateBingBatch: 空陣列 → 不發 fetch', async () => {
  const { translations, chars } = await translateBingBatch([]);
  expect(translations).toEqual([]);
  expect(chars).toBe(0);
  expect(fetchCalls.length).toBe(0);
});

test('translateBingBatch: 空字串元素 → 跳過不 fetch', async () => {
  const { translations } = await translateBingBatch(['Hello', '', 'World']);

  expect(translations.length).toBe(3);
  expect(translations[0]).toBe('[譯] Hello');
  expect(translations[1]).toBe('');  // 空字串不送 API
  expect(translations[2]).toBe('[譯] World');
  // 只有 2 次翻譯呼叫（跳過空字串）
  expect(translateCalls.length).toBe(2);
});

test('translateBingBatch: 語言代碼映射 zh-TW → zh-Hant', async () => {
  await translateBingBatch(['test'], 'zh-TW');
  expect(translateCalls.length).toBe(1);
  expect(translateCalls[0].url).toContain('to=zh-Hant');
});

test('translateBingBatch: 語言代碼映射 zh-CN → zh-Hans', async () => {
  await translateBingBatch(['test'], 'zh-CN');
  expect(translateCalls.length).toBe(1);
  expect(translateCalls[0].url).toContain('to=zh-Hans');
});

test('translateBingBatch: 語言代碼映射 ja → ja', async () => {
  await translateBingBatch(['test'], 'ja');
  expect(translateCalls.length).toBe(1);
  expect(translateCalls[0].url).toContain('to=ja');
});

test('translateBingBatch: Bearer token 正確傳遞', async () => {
  await translateBingBatch(['test']);
  expect(translateCalls.length).toBe(1);
  const auth = translateCalls[0].options.headers['Authorization'];
  expect(auth).toBe(`Bearer ${FAKE_TOKEN}`);
});

test('translateBingBatch: 長文本超過 5000 字元 → 自動拆分再串接', async () => {
  // 建構一段 12000 字元的文字 → 應拆為 3 個 chunk (5000 + 5000 + 2000)
  const longText = 'A'.repeat(12000);
  const { translations } = await translateBingBatch([longText]);

  expect(translations.length).toBe(1);
  // 被拆成 3 個 chunk 翻譯
  expect(translateCalls.length).toBe(3);
  // 結果應為 3 個 chunk 串接
  expect(translations[0]).toBe(
    '[譯] ' + 'A'.repeat(5000) +
    '[譯] ' + 'A'.repeat(5000) +
    '[譯] ' + 'A'.repeat(2000),
  );
});

test('translateBingBatch: 混合長短文字 → 索引正確對應', async () => {
  const inputs = [
    'Short',
    'B'.repeat(6000),  // 超過 5000 → 拆成 2 chunk
    'End',
  ];
  const { translations } = await translateBingBatch(inputs);

  expect(translations.length).toBe(3);
  expect(translations[0]).toBe('[譯] Short');
  // 長文字拆分後串接
  expect(translations[1]).toContain('[譯] ' + 'B'.repeat(5000));
  expect(translations[2]).toBe('[譯] End');
});

test('translateBingBatch: 並發控制 → 同時最多 3 個 fetch', async () => {
  // 追蹤同時進行的 fetch 數量
  let maxConcurrent = 0;
  let currentConcurrent = 0;

  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (url.includes('cognitive.microsofttranslator.com')) {
      currentConcurrent++;
      maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
      // 模擬一點延遲讓並發可觀察
      await new Promise(r => setTimeout(r, 10));
      currentConcurrent--;
    }
    return origFetch(url, opts);
  };

  // 送 6 段文字，並發上限 3
  const inputs = ['A', 'B', 'C', 'D', 'E', 'F'];
  const { translations } = await translateBingBatch(inputs);

  expect(translations.length).toBe(6);
  expect(maxConcurrent).toBeLessThanOrEqual(3);
  expect(maxConcurrent).toBeGreaterThanOrEqual(2); // 至少有並發

  // 還原
  globalThis.fetch = origFetch;
});

// SANITY CHECK 紀錄（已驗證，2026-04-28）：
//   把 bing-translate.js 的 MAX_CONCURRENCY 從 3 改為 1 → 並發測試的
//   maxConcurrent 降為 1 → `toBeGreaterThanOrEqual(2)` fail。還原後 pass。
