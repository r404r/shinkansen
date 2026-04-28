// Unit test: lib/bing-token.js — Microsoft Translator JWT token 管理
//
// 驗證 getBingToken 核心行為：
//   (1) 首次呼叫 → fetch auth 端點 → 回傳 token
//   (2) 快取命中 → 不再 fetch（token 未過期）
//   (3) 過期 token → 自動刷新
//   (4) forceRefresh → 無視快取，強制重新 fetch
//   (5) 並發鎖 → 多個同時呼叫只發一次 fetch
//   (6) JWT 過期解析 → 正確提取 exp 欄位
//
// Mock 策略：替換 globalThis.fetch（token 端點）+ chrome.storage.session（持久化）
import { test, expect } from '@playwright/test';

let authCallCount = 0;
let authDelay = 0;  // 模擬 auth 延遲（毫秒）
let forceAuthFail = false;

// 假 JWT 工具
function _makeFakeJwt(expSeconds) {
  const header = btoa(JSON.stringify({ alg: 'HS256' }));
  const payload = btoa(JSON.stringify({ exp: expSeconds }));
  return `${header}.${payload}.fakesig`;
}

// Mock storage
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
globalThis.browser = globalThis.chrome;

// 每次 auth call 回傳不同 token（靠 counter 辨識）
globalThis.fetch = async (url) => {
  if (!url.includes('edge.microsoft.com/translate/auth')) {
    return { ok: false, status: 404 };
  }
  authCallCount++;
  if (forceAuthFail) {
    return { ok: false, status: 500 };
  }
  if (authDelay > 0) {
    await new Promise(r => setTimeout(r, authDelay));
  }
  const futureExp = Math.floor(Date.now() / 1000) + 600;
  const token = _makeFakeJwt(futureExp);
  return {
    ok: true,
    text: async () => token + '_v' + authCallCount,
  };
};

const { getBingToken, clearBingToken } = await import('../../shinkansen/lib/bing-token.js');

test.beforeEach(async () => {
  authCallCount = 0;
  authDelay = 0;
  forceAuthFail = false;
  Object.keys(_storageData).forEach(k => delete _storageData[k]);
  await clearBingToken();
});

test('getBingToken: 首次呼叫 → fetch token', async () => {
  const token = await getBingToken();
  expect(authCallCount).toBe(1);
  expect(token).toContain('_v1');
});

test('getBingToken: 第二次呼叫 → 快取命中，不再 fetch', async () => {
  await getBingToken();
  expect(authCallCount).toBe(1);

  const token2 = await getBingToken();
  expect(authCallCount).toBe(1); // 沒有第二次 fetch
  expect(token2).toContain('_v1'); // 同一個 token
});

test('getBingToken: forceRefresh=true → 強制重新 fetch', async () => {
  await getBingToken();
  expect(authCallCount).toBe(1);

  const token2 = await getBingToken(true);
  expect(authCallCount).toBe(2); // 第二次 fetch
  expect(token2).toContain('_v2'); // 新 token
});

test('getBingToken: 過期 token → 自動刷新', async () => {
  // 手動寫入一個已過期的 token 到 storage
  const pastExp = Math.floor(Date.now() / 1000) - 60; // 1 分鐘前過期
  const expiredToken = _makeFakeJwt(pastExp);
  _storageData['_sk_bing_token'] = {
    token: expiredToken,
    expiresAt: pastExp * 1000,
    fetchedAt: Date.now() - 600_000,
  };

  const token = await getBingToken();
  expect(authCallCount).toBe(1); // 過期 → 刷新
  expect(token).toContain('_v1'); // 新 token
});

test('getBingToken: 快要過期（60 秒內）→ 提前刷新', async () => {
  // 手動寫入一個 30 秒後過期的 token
  const soonExp = Math.floor(Date.now() / 1000) + 30; // 30 秒後過期
  const soonToken = _makeFakeJwt(soonExp);
  _storageData['_sk_bing_token'] = {
    token: soonToken,
    expiresAt: soonExp * 1000,
    fetchedAt: Date.now(),
  };

  const token = await getBingToken();
  expect(authCallCount).toBe(1); // 30s < 60s buffer → 刷新
  expect(token).toContain('_v1');
});

test('getBingToken: 並發呼叫 → 只發一次 fetch', async () => {
  authDelay = 50; // 加延遲讓並發可觀察

  // 5 個並發呼叫
  const results = await Promise.all([
    getBingToken(),
    getBingToken(),
    getBingToken(),
    getBingToken(),
    getBingToken(),
  ]);

  // 只有 1 次 auth fetch
  expect(authCallCount).toBe(1);
  // 所有結果相同
  const unique = new Set(results);
  expect(unique.size).toBe(1);
});

test('getBingToken: auth 失敗 → throw Error', async () => {
  forceAuthFail = true;
  await expect(getBingToken()).rejects.toThrow('Microsoft Translator auth HTTP 500');
});

test('clearBingToken: 清除後下次呼叫重新 fetch', async () => {
  await getBingToken();
  expect(authCallCount).toBe(1);

  await clearBingToken();
  await getBingToken();
  expect(authCallCount).toBe(2); // 快取被清除，重新 fetch
});

// SANITY CHECK 紀錄（已驗證，2026-04-28）：
//   把 bing-token.js 的快取提前刷新 buffer 從 60_000 改為 0 →
//   「快要過期（60 秒內）→ 提前刷新」測試的 authCallCount 變為 0 → fail。
//   還原後 pass。
