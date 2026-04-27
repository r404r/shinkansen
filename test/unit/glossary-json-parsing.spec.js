// Unit test: extractGlossary 的 JSON 解析容錯 + request body 驗證
//
// v0.72: 移除 JSON mode，改為純文字 + 解析端容錯
// v0.74: 加入 thinkingConfig: { thinkingBudget: 0 } 防止 thinking token 截斷
import { test, expect } from '@playwright/test';

// ── Mock chrome.storage ──────────────────────────────────────
globalThis.chrome = {
  storage: {
    sync: { get: async () => ({}), remove: async () => {} },
    local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
  },
};

let lastCapturedBody = null;
function mockGeminiResponse(rawText, { ok = true, status = 200, errorMessage } = {}) {
  globalThis.fetch = async (_url, options) => {
    lastCapturedBody = JSON.parse(options.body);
    return {
      ok,
      status,
      json: async () => ok
        ? {
            candidates: [{ content: { parts: [{ text: rawText }] }, finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 },
          }
        : { error: { message: errorMessage || `HTTP ${status}` } },
    };
  };
}

const { extractGlossary } = await import('../../shinkansen/lib/gemini.js');

const settings = {
  apiKey: 'test-key',
  geminiConfig: {
    model: 'gemini-2.5-flash',
    serviceTier: 'DEFAULT',
    temperature: 0.1,
    topP: 0.95,
    topK: 40,
    maxOutputTokens: 8192,
  },
  glossary: {
    prompt: 'Extract glossary.',
    temperature: 0.1,
    maxTerms: 200,
    fetchTimeoutMs: 55_000,
  },
};

test.describe('glossary JSON 解析容錯', () => {
  test('plain JSON array', async () => {
    mockGeminiResponse('[{"source":"Einstein","target":"愛因斯坦","type":"person"}]');
    const { glossary } = await extractGlossary('some text', settings);
    expect(glossary).toHaveLength(1);
    expect(glossary[0]).toEqual({ source: 'Einstein', target: '愛因斯坦', type: 'person' });
  });

  test('JSON in ```json code fence', async () => {
    mockGeminiResponse('```json\n[{"source":"Tokyo","target":"東京","type":"place"}]\n```');
    const { glossary } = await extractGlossary('some text', settings);
    expect(glossary).toHaveLength(1);
    expect(glossary[0].source).toBe('Tokyo');
  });

  test('JSON in ``` code fence (no json tag)', async () => {
    mockGeminiResponse('```\n[{"source":"AI","target":"人工智慧","type":"tech"}]\n```');
    const { glossary } = await extractGlossary('some text', settings);
    expect(glossary).toHaveLength(1);
    expect(glossary[0].source).toBe('AI');
  });

  test('JSON object with "terms" key', async () => {
    mockGeminiResponse('{"terms":[{"source":"Paris","target":"巴黎","type":"place"}]}');
    const { glossary } = await extractGlossary('some text', settings);
    expect(glossary).toHaveLength(1);
    expect(glossary[0].source).toBe('Paris');
  });

  test('JSON object with arbitrary array key', async () => {
    mockGeminiResponse('{"glossary":[{"source":"London","target":"倫敦","type":"place"}]}');
    const { glossary } = await extractGlossary('some text', settings);
    expect(glossary).toHaveLength(1);
    expect(glossary[0].source).toBe('London');
  });

  test('JSON with preamble text', async () => {
    mockGeminiResponse('Here are the extracted terms:\n[{"source":"Trump","target":"川普","type":"person"}]');
    const { glossary } = await extractGlossary('some text', settings);
    expect(glossary).toHaveLength(1);
    expect(glossary[0].source).toBe('Trump');
  });

  test('JSON with preamble and postamble', async () => {
    mockGeminiResponse('Terms:\n[{"source":"NASA","target":"美國太空總署","type":"tech"}]\nDone.');
    const { glossary } = await extractGlossary('some text', settings);
    expect(glossary).toHaveLength(1);
    expect(glossary[0].source).toBe('NASA');
  });

  test('truncated JSON → graceful failure (empty glossary + _diag)', async () => {
    mockGeminiResponse('[{"source":"Einstein","target":"愛因斯坦"},{"sourc');
    const result = await extractGlossary('some text', settings);
    expect(result.glossary).toEqual([]);
    expect(result._diag).toBeTruthy();
  });

  test('invalid entries filtered out (missing source or target)', async () => {
    mockGeminiResponse(JSON.stringify([
      { source: 'A', target: '甲' },
      { source: '', target: '乙' },       // empty source
      { target: '丙' },                   // missing source
      { source: 'D' },                    // missing target
      { source: 'E', target: '戊' },
    ]));
    const { glossary } = await extractGlossary('some text', settings);
    expect(glossary).toHaveLength(2);
    expect(glossary.map(g => g.source)).toEqual(['A', 'E']);
  });

  test('empty response text → empty glossary', async () => {
    mockGeminiResponse('');
    const result = await extractGlossary('some text', settings);
    expect(result.glossary).toEqual([]);
  });

  test('API error → empty glossary with _diag', async () => {
    mockGeminiResponse('', { ok: false, status: 500, errorMessage: 'Internal server error' });
    const result = await extractGlossary('some text', settings);
    expect(result.glossary).toEqual([]);
    expect(result._diag).toContain('500');
  });

  // v0.74 regression: thinking token 截斷防治
  // v1.6.12 起改用 thinkingLevel(舊 thinkingBudget Google 標 not recommended);
  // 此 settings.model='gemini-2.5-flash' 不含 "pro" → pickThinkingConfig 回 'minimal'
  // (thoughts=0 等同舊 budget=0)。對應 v1.6.12 修法詳見 lib/gemini.js#pickThinkingConfig。
  test('request body 包含 thinkingConfig: { thinkingLevel: "minimal" } (Flash 系列)', async () => {
    mockGeminiResponse('[{"source":"test","target":"測試"}]');
    await extractGlossary('some text', settings);
    expect(lastCapturedBody.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'minimal' });
  });

  test('request body 不包含 responseMimeType（v0.72 已移除 JSON mode）', async () => {
    mockGeminiResponse('[{"source":"test","target":"測試"}]');
    await extractGlossary('some text', settings);
    expect(lastCapturedBody.generationConfig.responseMimeType).toBeUndefined();
  });
});
