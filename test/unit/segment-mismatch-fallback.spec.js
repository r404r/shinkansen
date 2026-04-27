// Unit test: segment mismatch fallback + 明確分隔符規則（v0.77/v0.78 regression）
//
// v0.77: translateChunk 加入 thinkingConfig: { thinkingBudget: 0 }，防止
//   thinking token 吃掉 maxOutputTokens 額度導致輸出截斷 → 段數不符。
// v0.78: 多段翻譯時追加明確分隔符規則到 effectiveSystem，告訴 Gemini 確切的
//   <<<SHINKANSEN_SEP>>> 分隔符和預期段數。
//
// 驗證項目：
//   1. 多段翻譯的 systemInstruction 包含分隔符規則（含正確段數）
//   2. 單段翻譯不追加分隔符規則
//   3. API 回傳段數不符時觸發 per-segment fallback
//   4. fallback 後的結果與 usage 正確累加
//   5. translateChunk 的 thinkingConfig 設定
import { test, expect } from '@playwright/test';

// ── Mock chrome.storage ──────────────────────────────────────
globalThis.chrome = {
  storage: {
    sync: { get: async () => ({}), remove: async () => {} },
    local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
  },
};

const DELIMITER = '\n<<<SHINKANSEN_SEP>>>\n';

// ── Mock fetch：可依序回傳不同的 response ──────────────────
let fetchCalls = [];
let fetchResponses = [];

function pushResponse(text, { inputTokens = 100, outputTokens = 50 } = {}) {
  fetchResponses.push({
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [{ content: { parts: [{ text }] } }],
      usageMetadata: {
        promptTokenCount: inputTokens,
        candidatesTokenCount: outputTokens,
      },
    }),
  });
}

globalThis.fetch = async (_url, options) => {
  const body = JSON.parse(options.body);
  fetchCalls.push({ url: _url, body });
  const resp = fetchResponses.shift();
  if (!resp) throw new Error('No more mock responses');
  return resp;
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

function lastSystemInstruction() {
  return fetchCalls.at(-1).body.systemInstruction.parts[0].text;
}

function nthSystemInstruction(n) {
  return fetchCalls[n].body.systemInstruction.parts[0].text;
}

test.beforeEach(() => {
  fetchCalls = [];
  fetchResponses = [];
});

const SEP_RULE_MARKER = '額外規則（多段翻譯分隔符與序號，極重要）';

test.describe('v0.78 明確分隔符規則', () => {
  test('多段翻譯 → systemInstruction 包含分隔符規則與正確段數', async () => {
    const texts = ['Hello world', 'Good morning', 'Thank you'];
    pushResponse(`你好世界${DELIMITER}早安${DELIMITER}謝謝`);
    await translateBatch(texts, settings);

    const sys = lastSystemInstruction();
    expect(sys).toContain(SEP_RULE_MARKER);
    expect(sys).toContain('本批次包含 3 段文字');
    expect(sys).toContain('恰好輸出 3 段譯文和 2 個分隔符');
  });

  test('單段翻譯 → 不追加分隔符規則', async () => {
    pushResponse('你好世界');
    await translateBatch(['Hello world'], settings);

    const sys = lastSystemInstruction();
    expect(sys).not.toContain(SEP_RULE_MARKER);
  });

  test('分隔符規則在 base 之後、其他規則之前', async () => {
    // 多段 + 含 placeholder → 分隔符規則應在佔位符規則之前
    pushResponse(`⟦0⟧你好⟦/0⟧${DELIMITER}早安`);
    await translateBatch(['⟦0⟧Hello⟦/0⟧', 'Good morning'], settings);

    const sys = lastSystemInstruction();
    const basePos = sys.indexOf(BASE_SYSTEM);
    const sepPos = sys.indexOf(SEP_RULE_MARKER);
    const phPos = sys.indexOf('額外規則（極重要，處理佔位符標記）');

    expect(basePos).toBe(0);
    expect(sepPos).toBeGreaterThan(basePos);
    expect(phPos).toBeGreaterThan(sepPos);
  });
});

test.describe('v0.77 segment mismatch fallback', () => {
  test('API 回傳段數不符 → 觸發 per-segment fallback', async () => {
    const texts = ['Hello', 'World', 'Test'];
    // 第一次：3 段送出但 API 只回 1 段（模擬 Gemini 忽略分隔符）
    pushResponse('你好世界測試');
    // fallback: 逐段重送 3 次
    pushResponse('你好', { inputTokens: 30, outputTokens: 10 });
    pushResponse('世界', { inputTokens: 30, outputTokens: 10 });
    pushResponse('測試', { inputTokens: 30, outputTokens: 10 });

    const result = await translateBatch(texts, settings);

    // 共 4 次 API 呼叫（1 次失敗 + 3 次 fallback）
    expect(fetchCalls).toHaveLength(4);
    // 結果正確對齊
    expect(result.translations).toEqual(['你好', '世界', '測試']);
  });

  test('fallback 的 usage 正確累加（含原始失敗批次的成本）', async () => {
    const texts = ['Hello', 'World'];
    // 第一次：段數不符
    pushResponse('你好和世界', { inputTokens: 200, outputTokens: 100 });
    // fallback 逐段
    pushResponse('你好', { inputTokens: 50, outputTokens: 20 });
    pushResponse('世界', { inputTokens: 50, outputTokens: 20 });

    const result = await translateBatch(texts, settings);

    // usage 應包含原始失敗批次 + 兩次 fallback
    expect(result.usage.inputTokens).toBe(200 + 50 + 50);
    expect(result.usage.outputTokens).toBe(100 + 20 + 20);
  });

  test('段數正確 → 不觸發 fallback，直接回傳', async () => {
    const texts = ['Hello', 'World'];
    pushResponse(`你好${DELIMITER}世界`);

    const result = await translateBatch(texts, settings);

    // 只有 1 次 API 呼叫
    expect(fetchCalls).toHaveLength(1);
    expect(result.translations).toEqual(['你好', '世界']);
  });

  test('fallback 的每段呼叫是單段模式（不含分隔符規則）', async () => {
    const texts = ['Hello', 'World'];
    // 第一次：段數不符
    pushResponse('你好和世界');
    // fallback
    pushResponse('你好');
    pushResponse('世界');

    await translateBatch(texts, settings);

    // 第一次呼叫（多段）應含分隔符規則
    expect(nthSystemInstruction(0)).toContain(SEP_RULE_MARKER);
    // fallback 呼叫（單段）不應含分隔符規則
    expect(nthSystemInstruction(1)).not.toContain(SEP_RULE_MARKER);
    expect(nthSystemInstruction(2)).not.toContain(SEP_RULE_MARKER);
  });
});

// v0.77 / v0.88 / v1.6.12 thinkingConfig 演進:
//   v0.74 起 Flash 用 { thinkingBudget: 0 } 關閉思考避免吃 maxOutputTokens
//   v1.6.12 起改用 { thinkingLevel: 'minimal' }(Flash) / 'low'(Pro)——
//     真實 API 實測:Pro 系列強制 thinking-only,thinkingBudget=0 直接 400;
//     Gemini 3+ Google 推薦改用 thinkingLevel 而非 thinkingBudget(後者標 deprecated)。
// 此 settings.model='gemini-2.5-flash' → pickThinkingConfig 回 'minimal'。
test.describe('v1.6.12 thinkingConfig for translateChunk', () => {
  test('translateBatch request 包含 thinkingConfig: { thinkingLevel: "minimal" } (Flash 系列)', async () => {
    pushResponse('你好');
    await translateBatch(['Hello'], settings);

    expect(fetchCalls[0].body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'minimal' });
  });

  test('useThinking=true 已 deprecated,thinkingConfig 仍由 model name 決定(本例 Flash → minimal)', async () => {
    pushResponse('你好');
    const thinkingSettings = {
      ...settings,
      geminiConfig: { ...settings.geminiConfig, useThinking: true },
    };
    await translateBatch(['Hello'], thinkingSettings);

    expect(fetchCalls[0].body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'minimal' });
  });
});
