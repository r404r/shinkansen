// Unit test: Google Translate 目標語言跟隨 uiLocale（v1.6 Nozomi 新增）
//
// 驗證 translateGoogleBatch 的 targetLang 參數正確傳遞到 API URL。
// Mock fetch 攔截請求，檢查 URL 中的 tl= 參數。
import { test, expect } from '@playwright/test';

let capturedUrls = [];

// Mock fetch
globalThis.fetch = async (url) => {
  capturedUrls.push(url);
  // 回傳 Google Translate 格式的假回應
  return {
    ok: true,
    json: async () => [[['翻譯結果', 'test text', null, null, 3]]],
  };
};

// 動態 import（fetch mock 必須在 import 之前設好）
const { translateGoogleBatch } = await import('../../shinkansen/lib/google-translate.js');

test.describe('Google Translate targetLang', () => {
  test.beforeEach(() => {
    capturedUrls = [];
  });

  test('預設 targetLang=zh-TW', async () => {
    await translateGoogleBatch(['hello']);
    expect(capturedUrls.length).toBe(1);
    expect(capturedUrls[0]).toContain('tl=zh-TW');
  });

  test('targetLang=zh-CN 傳遞到 URL', async () => {
    await translateGoogleBatch(['hello'], 'zh-CN');
    expect(capturedUrls.length).toBe(1);
    expect(capturedUrls[0]).toContain('tl=zh-CN');
  });

  test('targetLang=ja 傳遞到 URL', async () => {
    await translateGoogleBatch(['hello'], 'ja');
    expect(capturedUrls.length).toBe(1);
    expect(capturedUrls[0]).toContain('tl=ja');
  });

  test('多段文字仍使用相同 targetLang', async () => {
    await translateGoogleBatch(['hello', 'world', 'test'], 'ja');
    // 可能合併為一個請求或拆分，但所有請求都應含 tl=ja
    for (const url of capturedUrls) {
      expect(url).toContain('tl=ja');
    }
  });

  test('空文字陣列不發請求', async () => {
    const result = await translateGoogleBatch([]);
    expect(result.translations).toEqual([]);
    expect(result.chars).toBe(0);
    expect(capturedUrls.length).toBe(0);
  });
});
