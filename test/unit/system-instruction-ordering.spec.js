// Unit test: systemInstruction 建構順序（v0.71 regression）
//
// 驗證 translateChunk 建構的 effectiveSystem 遵守以下順序：
//   1. 基礎翻譯指令（使用者在設定頁自訂的 systemInstruction）
//   2. 段落分隔規則（若文字含 \n）
//   3. 佔位符規則（若文字含 ⟦⟧）
//   4. 術語對照表（若有 glossary，「參考資料」放最末）
//
// v0.70 的 bug：術語表放在佔位符規則前面，稀釋了 LLM 對佔位符的注意力，
// 導致 ⟦*N⟧ 標記洩漏到譯文裡。
import { test, expect } from '@playwright/test';

// ── Mock chrome.storage（gemini.js → logger.js → storage.js 的依賴鏈）──
globalThis.chrome = {
  storage: {
    sync: { get: async () => ({}), remove: async () => {} },
    local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
  },
};

// ── Mock fetch：攔截 Gemini API 呼叫，記錄 request body ──────
let capturedBodies = [];
globalThis.fetch = async (_url, options) => {
  capturedBodies.push(JSON.parse(options.body));
  return {
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [{ content: { parts: [{ text: '翻譯結果' }] } }],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 },
    }),
  };
};

const { translateBatch } = await import('../../shinkansen/lib/gemini.js');

const BASE_SYSTEM = '基礎翻譯指令';
const settings = {
  apiKey: 'test-key',
  geminiConfig: {
    model: 'gemini-2.5-flash',
    serviceTier: 'DEFAULT',
    temperature: 1.0,
    topP: 0.95,
    topK: 40,
    maxOutputTokens: 8192,
    systemInstruction: BASE_SYSTEM,
  },
  maxRetries: 0,
};

const GLOSSARY_MARKER = '術語對照表';

/** 從最近一次 fetch 的 request body 取出 systemInstruction 文字 */
function lastSystemInstruction() {
  return capturedBodies.at(-1).systemInstruction.parts[0].text;
}

test.beforeEach(() => { capturedBodies = []; });

test.describe('systemInstruction 建構順序', () => {
  test('placeholder + glossary → placeholder rule before glossary', async () => {
    await translateBatch(
      ['Some ⟦0⟧link text⟦/0⟧ here'],
      settings,
      [{ source: 'Einstein', target: '愛因斯坦' }],
    );
    const sys = lastSystemInstruction();

    const phPos = sys.indexOf('額外規則（極重要，處理佔位符標記）');
    const glPos = sys.indexOf(GLOSSARY_MARKER);
    expect(phPos).toBeGreaterThan(-1);
    expect(glPos).toBeGreaterThan(-1);
    expect(phPos).toBeLessThan(glPos);
  });

  test('newline + glossary → newline rule before glossary', async () => {
    await translateBatch(
      ['First line\nSecond line'],
      settings,
      [{ source: 'Paris', target: '巴黎' }],
    );
    const sys = lastSystemInstruction();

    const nlPos = sys.indexOf('額外規則（段落分隔）');
    const glPos = sys.indexOf(GLOSSARY_MARKER);
    expect(nlPos).toBeGreaterThan(-1);
    expect(glPos).toBeGreaterThan(-1);
    expect(nlPos).toBeLessThan(glPos);
  });

  test('newline + placeholder + glossary → base < newline < placeholder < glossary', async () => {
    await translateBatch(
      ['Line one\n⟦0⟧link⟦/0⟧ here'],
      settings,
      [{ source: 'Tokyo', target: '東京' }],
    );
    const sys = lastSystemInstruction();

    const basePos = sys.indexOf(BASE_SYSTEM);
    const nlPos   = sys.indexOf('額外規則（段落分隔）');
    const phPos   = sys.indexOf('額外規則（極重要，處理佔位符標記）');
    const glPos   = sys.indexOf(GLOSSARY_MARKER);

    expect(basePos).toBe(0);
    expect(nlPos).toBeGreaterThan(basePos);
    expect(phPos).toBeGreaterThan(nlPos);
    expect(glPos).toBeGreaterThan(phPos);
  });

  test('glossary content embedded in system instruction', async () => {
    await translateBatch(
      ['Some text'],
      settings,
      [
        { source: 'Einstein', target: '愛因斯坦' },
        { source: 'Tokyo', target: '東京' },
      ],
    );
    const sys = lastSystemInstruction();
    expect(sys).toContain('Einstein → 愛因斯坦');
    expect(sys).toContain('Tokyo → 東京');
  });

  test('no glossary → no glossary section', async () => {
    await translateBatch(['Some ⟦0⟧link⟦/0⟧ text'], settings);
    expect(lastSystemInstruction()).not.toContain(GLOSSARY_MARKER);
  });

  test('plain text + glossary → only base + glossary (no extra rules)', async () => {
    await translateBatch(
      ['Simple plain text'],
      settings,
      [{ source: 'AI', target: '人工智慧' }],
    );
    const sys = lastSystemInstruction();
    expect(sys).toContain(BASE_SYSTEM);
    expect(sys).toContain(GLOSSARY_MARKER);
    expect(sys).not.toContain('額外規則（段落分隔）');
    expect(sys).not.toContain('額外規則（極重要，處理佔位符標記）');
  });
});
