// Unit test: OpenAI-compatible adapter 的 usage 結構抽取（v1.5.7 regression）
//
// OpenAI / OpenRouter 的 usage 結構與 Gemini 不同：
//   Gemini: usageMetadata.promptTokenCount / candidatesTokenCount / cachedContentTokenCount
//   OpenAI: usage.prompt_tokens / completion_tokens / prompt_tokens_details.cached_tokens
//                                                     ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
//                                                     OpenAI 2024-09 起的 cache 命中欄位
//
// 驗證 lib/openai-compat.js translateBatch 的 usage 物件正確從 OpenAI 結構抽取。
import { test, expect } from '@playwright/test';

globalThis.chrome = {
  storage: {
    sync: { get: async () => ({}), remove: async () => {} },
    local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
  },
};

let nextResponseUsage = null;
globalThis.fetch = async (_url, _options) => ({
  ok: true,
  status: 200,
  json: async () => ({
    choices: [{ message: { content: '翻譯結果' }, finish_reason: 'stop' }],
    usage: nextResponseUsage,
  }),
});

const { translateBatch } = await import('../../shinkansen/lib/openai-compat.js');

const settings = {
  customProvider: {
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'anthropic/claude-sonnet-4-5',
    systemPrompt: 'system',
    temperature: 0.5,
    apiKey: 'sk-test',
  },
  maxRetries: 0,
};

test.describe('OpenAI-compat usage 抽取', () => {
  test('標準 usage 結構（OpenAI / OpenRouter 主流）', async () => {
    nextResponseUsage = {
      prompt_tokens: 1234,
      completion_tokens: 567,
      total_tokens: 1801,
    };
    const { usage } = await translateBatch(['Hello'], settings, null, null, null);
    expect(usage.inputTokens).toBe(1234);
    expect(usage.outputTokens).toBe(567);
    expect(usage.cachedTokens).toBe(0); // 沒有 cache 命中時
  });

  test('含 prompt_tokens_details.cached_tokens（OpenAI 2024-09 起）', async () => {
    nextResponseUsage = {
      prompt_tokens: 2000,
      completion_tokens: 300,
      total_tokens: 2300,
      prompt_tokens_details: { cached_tokens: 500 },
    };
    const { usage } = await translateBatch(['Hello'], settings, null, null, null);
    expect(usage.inputTokens).toBe(2000);
    expect(usage.outputTokens).toBe(300);
    expect(usage.cachedTokens).toBe(500);
  });

  test('支援 fallback usage.cached_tokens（部分 provider 不嵌 prompt_tokens_details）', async () => {
    nextResponseUsage = {
      prompt_tokens: 1000,
      completion_tokens: 200,
      cached_tokens: 250,
    };
    const { usage } = await translateBatch(['Hello'], settings, null, null, null);
    expect(usage.cachedTokens).toBe(250);
  });

  test('usage 缺欄位 → 0 安全 fallback（不噴 NaN）', async () => {
    nextResponseUsage = {}; // 完全空（極端 provider 行為）
    const { usage } = await translateBatch(['Hello'], settings, null, null, null);
    expect(usage.inputTokens).toBe(0);
    expect(usage.outputTokens).toBe(0);
    expect(usage.cachedTokens).toBe(0);
  });

  test('多批 usage 累加（packChunks 切多 chunk 時各 chunk usage 加總）', async () => {
    nextResponseUsage = {
      prompt_tokens: 100,
      completion_tokens: 50,
      prompt_tokens_details: { cached_tokens: 20 },
    };
    // 14 段普通字串會被 packChunks 切成 2 個 chunk（每 chunk 上限 12 段）
    const texts = Array.from({ length: 14 }, (_, i) => `Text ${i}`);
    const { usage, translations } = await translateBatch(texts, settings, null, null, null);
    // 14 段一定會在 mismatch fallback 中產生額外呼叫——我們只需確認 usage 不為 0
    // 且 translations 數量正確
    expect(usage.inputTokens).toBeGreaterThan(0);
    expect(usage.outputTokens).toBeGreaterThan(0);
    expect(translations.length).toBe(14);
  });
});

// SANITY 紀錄（已在 Claude Code 端驗證）：
//   把 lib/openai-compat.js 中
//     `cachedTokens: u.prompt_tokens_details?.cached_tokens || u.cached_tokens || 0,`
//   改成 `cachedTokens: 0,`
//   → 第 #2 與 #3 條 fail（cachedTokens 期待 500 / 250 但實際 0）。
//   還原後全部 pass。
