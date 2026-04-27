// Unit test: OpenAI-compatible adapter 的 systemInstruction 注入（v1.5.7 regression）
//
// 驗證 lib/openai-compat.js 的 translateBatch：
//   - 走 chat.completions endpoint（不是 Gemini 的 generateContent）
//   - request body 是 OpenAI messages 結構（system + user 兩條 message）
//   - 透過共用 buildEffectiveSystemInstruction 自動注入 fixedGlossary 與
//     forbiddenTerms（Jimmy 設計決定 #3：systemPrompt 獨立、黑名單與固定術語表共用）
//   - Bearer Authorization header 帶上 customProvider.apiKey
//
// Mock 策略：替換 globalThis.fetch 攔截 chat.completions 請求，記錄 URL / headers /
// request body，回傳一段假譯文。
import { test, expect } from '@playwright/test';

globalThis.chrome = {
  storage: {
    sync: { get: async () => ({}), remove: async () => {} },
    local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
  },
};

let fetchCalls = [];
globalThis.fetch = async (url, options) => {
  fetchCalls.push({
    url: String(url),
    headers: options?.headers || {},
    body: JSON.parse(options?.body || '{}'),
  });
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: '翻譯結果' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    }),
  };
};

const { translateBatch } = await import('../../shinkansen/lib/openai-compat.js');

const FORBIDDEN_SAMPLE = [
  { forbidden: '視頻', replacement: '影片', note: '' },
  { forbidden: '軟件', replacement: '軟體', note: '' },
];

const FIXED_GLOSSARY = [
  { source: 'Einstein', target: '愛因斯坦' },
];

function makeSettings(overrides = {}) {
  return {
    customProvider: {
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'anthropic/claude-sonnet-4-5',
      systemPrompt: '你是專業翻譯員。',
      temperature: 0.5,
      apiKey: 'test-bearer-token',
      ...overrides,
    },
    maxRetries: 0,
  };
}

test.beforeEach(() => { fetchCalls = []; });

test.describe('OpenAI-compat translateBatch', () => {
  test('chat.completions endpoint 自動接尾綴 + Bearer auth', async () => {
    await translateBatch(['Hello'], makeSettings(), null, null, null);
    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0].url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(fetchCalls[0].headers.Authorization).toBe('Bearer test-bearer-token');
  });

  test('baseUrl 已含 /chat/completions 不重複接', async () => {
    await translateBatch(['Hello'], makeSettings({
      baseUrl: 'https://openrouter.ai/api/v1/chat/completions',
    }), null, null, null);
    expect(fetchCalls[0].url).toBe('https://openrouter.ai/api/v1/chat/completions');
  });

  test('request body 是 OpenAI messages 結構（system + user）', async () => {
    await translateBatch(['Some text'], makeSettings(), null, null, null);
    const body = fetchCalls[0].body;
    expect(body.model).toBe('anthropic/claude-sonnet-4-5');
    expect(body.temperature).toBe(0.5);
    expect(body.stream).toBe(false);
    expect(Array.isArray(body.messages)).toBe(true);
    expect(body.messages.length).toBe(2);
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[1].role).toBe('user');
    expect(body.messages[1].content).toBe('Some text');
  });

  test('forbiddenTerms 注入 systemInstruction（共用 buildEffectiveSystemInstruction）', async () => {
    await translateBatch(['Some video software text'], makeSettings(), null, null, FORBIDDEN_SAMPLE);
    const sys = fetchCalls[0].body.messages[0].content;
    expect(sys).toContain('<forbidden_terms_blacklist>');
    expect(sys).toContain('視頻 → 影片');
    expect(sys).toContain('軟件 → 軟體');
  });

  test('fixedGlossary 注入 systemInstruction（與 Gemini 路徑同行為）', async () => {
    await translateBatch(['Some text about Einstein'], makeSettings(), null, FIXED_GLOSSARY, null);
    const sys = fetchCalls[0].body.messages[0].content;
    expect(sys).toContain('使用者指定的固定術語表');
    expect(sys).toContain('Einstein → 愛因斯坦');
  });

  test('systemPrompt 獨立於 Gemini（自訂 prompt 是 base，不繼承 geminiConfig.systemInstruction）', async () => {
    await translateBatch(
      ['Some text'],
      makeSettings({ systemPrompt: '我是自訂 prompt 的 base 段。' }),
      null, null, null,
    );
    const sys = fetchCalls[0].body.messages[0].content;
    expect(sys.startsWith('我是自訂 prompt 的 base 段。')).toBe(true);
  });

  // v1.6.7: apiKey 為空時改成允許（本機 llama.cpp / Ollama 等不需要 key），
  // 且不送 Authorization header（OpenAI 相容規範允許省略；商用端會自然 401）。
  test('apiKey 為空 → 不 throw 且不送 Authorization header（本機後端相容）', async () => {
    await translateBatch(['Hello'], makeSettings({ apiKey: '' }), null, null, null);
    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0].headers.Authorization).toBeUndefined();
  });

  test('apiKey 為 undefined（settings.customProvider 沒這欄位）→ 不 throw 且不送 Authorization', async () => {
    await translateBatch(['Hello'], makeSettings({ apiKey: undefined }), null, null, null);
    expect(fetchCalls[0].headers.Authorization).toBeUndefined();
  });

  test('model 缺失 → 仍會 throw（model 是必填）', async () => {
    let err = null;
    try {
      await translateBatch(['Hello'], makeSettings({ model: '' }), null, null, null);
    } catch (e) { err = e; }
    expect(err).not.toBeNull();
    expect(err.message).toContain('模型');
  });
});

// SANITY 紀錄（已在 Claude Code 端驗證）：
//   (1) 把 lib/openai-compat.js translateChunk 的
//       `const effectiveSystem = buildEffectiveSystemInstruction(...)` 改成 `const effectiveSystem = baseSystem;`
//       → 「forbiddenTerms 注入」與「fixedGlossary 注入」兩條 spec fail。還原後全部 pass。
//   (2) v1.6.7: 把 headers 改回硬送 `{ 'Authorization': \`Bearer ${apiKey}\` }`
//       → 「apiKey 為空 → 不送 Authorization」與「apiKey undefined」兩條新 spec fail。
//       還原為 `apiKey ? { 'Authorization': ... } : {}` 後全部 pass。
