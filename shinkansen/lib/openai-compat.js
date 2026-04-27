// openai-compat.js — OpenAI-compatible Chat Completions adapter（v1.5.7 起）
//
// 為什麼有這個檔：使用者想用 Gemini 之外的模型（OpenRouter / Together / DeepSeek /
// Groq / Fireworks / OpenAI 自家 / 自架 Ollama 等）。chat.completions 是事實上的
// lingua franca；OpenRouter 把 Anthropic 與 Gemini 原生 API 都已經 wrap 成
// OpenAI-compatible，使用者要冷門 provider 透過它就能接，不需要 Shinkansen
// 為每個 provider 寫獨立 adapter。
//
// 介面對齊 lib/gemini.js 的 translateBatch：呼叫端（background.js）只看 engine
// 字串切換 import 不同 module，其他流程（cache / 注入 / segment mismatch fallback）
// 完全共用。
//
// Rate limiter / RPD 配額：bypass（Jimmy 設計決定 #5）。OpenRouter 等 provider
// 自己處理配額；429 退避重試由本檔 fetchWithRetry 處理。
//
// systemInstruction 構建：使用者自訂的 customProvider.systemPrompt 是 base，
// 其後由 buildEffectiveSystemInstruction 自動追加：多段分隔符規則 / 段內換行
// 規則 / 佔位符規則 / 自動 glossary / 使用者固定術語表 / 中國用語黑名單。
// 黑名單與固定術語表是「跨 provider 共用」（Jimmy 設計決定 #3）。

import { debugLog } from './logger.js';
import { DELIMITER, packChunks, buildEffectiveSystemInstruction } from './system-instruction.js';
// v1.6.18: thinking 控制 mapping(各家 provider 的 thinking schema 不同,統一成
// thinkingLevel 'auto/off/low/medium/high' + extraBodyJson 進階透傳)
import { buildThinkingPayload } from './openai-compat-thinking.js';

const MAX_BACKOFF_MS = 8000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * fetch chat.completions endpoint，帶 429 / 5xx 退避重試。
 * 與 lib/gemini.js 的 fetchWithRetry 邏輯對齊（除了 quota dimension 提取，
 * OpenAI-compatible provider 的 429 body 結構不一致，這裡只做純退避）。
 */
async function fetchWithRetry(url, headers, body, { maxRetries = 3 } = {}) {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let resp;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
    } catch (err) {
      await debugLog('error', 'api', 'openai-compat fetch network error', { error: err.message, attempt });
      if (attempt >= maxRetries) throw new Error('網路錯誤：' + err.message);
      await sleep(Math.min(MAX_BACKOFF_MS, 500 * Math.pow(2, attempt)));
      attempt += 1;
      continue;
    }

    // 5xx → 退避重試
    if (resp.status >= 500 && resp.status < 600) {
      await debugLog('warn', 'api', `openai-compat ${resp.status} server error`, { status: resp.status, attempt });
      if (attempt >= maxRetries) {
        let errMsg = `HTTP ${resp.status}`;
        try { const j = await resp.json(); errMsg = j?.error?.message || errMsg; } catch { /* noop */ }
        throw new Error(errMsg);
      }
      await sleep(Math.min(MAX_BACKOFF_MS, 500 * Math.pow(2, attempt)));
      attempt += 1;
      continue;
    }

    if (resp.status !== 429) return resp;

    // 429 退避（不依 quota dimension 細分，OpenAI 相容 provider 沒有統一的維度標記）
    let bodyJson = null;
    try { bodyJson = await resp.clone().json(); } catch { /* noop */ }
    const retryAfterHeader = resp.headers.get('retry-after');
    const retryAfterSec = retryAfterHeader ? parseInt(retryAfterHeader, 10) : NaN;

    await debugLog('warn', 'api', 'openai-compat 429 rate limit', {
      retryAfter: retryAfterHeader,
      attempt,
      error: bodyJson?.error?.message,
    });

    if (attempt >= maxRetries) {
      const msg = bodyJson?.error?.message || `HTTP 429`;
      throw new Error(msg);
    }
    const waitMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0
      ? retryAfterSec * 1000 + 100
      : Math.min(MAX_BACKOFF_MS, 500 * Math.pow(2, attempt));
    await sleep(waitMs);
    attempt += 1;
  }
}

/**
 * 把 OpenAI 風格的 base URL 標準化成 chat.completions endpoint。
 *   "https://openrouter.ai/api/v1"          → ".../chat/completions"
 *   "https://openrouter.ai/api/v1/"         → ".../chat/completions"
 *   "https://openrouter.ai/api/v1/chat/completions" → 原值（已是完整 endpoint）
 *   "http://localhost:11434/v1"             → ".../chat/completions"（Ollama）
 */
function resolveChatCompletionsUrl(baseUrl) {
  if (!baseUrl) throw new Error('customProvider.baseUrl 未設定');
  const trimmed = String(baseUrl).trim().replace(/\/+$/, '');
  if (/\/chat\/completions$/.test(trimmed)) return trimmed;
  return trimmed + '/chat/completions';
}

/**
 * 批次翻譯文字陣列（會自動切成多批送出）。介面與 lib/gemini.js 的 translateBatch 對齊。
 *
 * @param {string[]} texts 原文陣列
 * @param {object} settings 完整設定。會讀：
 *   - customProvider.baseUrl
 *   - customProvider.model
 *   - customProvider.systemPrompt
 *   - customProvider.temperature
 *   - customProvider.apiKey（已由 background 端從 storage.local 注入）
 * @param {Array<{source:string, target:string}>} [glossary]
 * @param {Array<{source:string, target:string}>} [fixedGlossary]
 * @param {Array<{forbidden:string, replacement:string}>} [forbiddenTerms]
 * @returns {Promise<{ translations: string[], usage: { inputTokens: number, outputTokens: number, cachedTokens: number }, hadMismatch: boolean }>}
 */
export async function translateBatch(texts, settings, glossary, fixedGlossary, forbiddenTerms) {
  if (!texts?.length) return { translations: [], usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 }, hadMismatch: false };
  const out = new Array(texts.length);
  const usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
  let hadMismatch = false;
  const chunks = packChunks(texts);
  for (const { start, end } of chunks) {
    const slice = texts.slice(start, end);
    const result = await translateChunk(slice, settings, glossary, fixedGlossary, forbiddenTerms);
    for (let j = 0; j < result.parts.length; j++) out[start + j] = result.parts[j];
    usage.inputTokens += result.usage.inputTokens;
    usage.outputTokens += result.usage.outputTokens;
    usage.cachedTokens += result.usage.cachedTokens || 0;
    if (result.hadMismatch) hadMismatch = true;
  }
  return { translations: out, usage, hadMismatch };
}

async function translateChunk(texts, settings, glossary, fixedGlossary, forbiddenTerms) {
  if (!texts?.length) return { parts: [], usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 } };
  const cp = settings.customProvider || {};
  const { baseUrl, model, systemPrompt, temperature, apiKey, thinkingLevel, extraBodyJson } = cp;
  // v1.6.7: API Key 允許為空（本機 llama.cpp / Ollama 等不需要 key）；商用後端漏填會自然 401
  if (!model) throw new Error('尚未設定自訂 Provider 的模型 ID。');

  // 多段時加序號標記（與 Gemini 同邏輯）
  const useSeqMarkers = texts.length > 1;
  const markedTexts = useSeqMarkers
    ? texts.map((t, i) => `«${i + 1}» ${t}`)
    : texts;
  const joined = markedTexts.join(DELIMITER);

  const baseSystem = (typeof systemPrompt === 'string' && systemPrompt.trim())
    ? systemPrompt
    : '你是專業的英文 → 繁體中文（台灣慣用語）翻譯助理，僅輸出譯文不加任何說明。';
  const effectiveSystem = buildEffectiveSystemInstruction(baseSystem, texts, joined, glossary, fixedGlossary, forbiddenTerms);

  // v1.6.18: 依 baseUrl + model 偵測 provider,組對應 thinking 控制 payload。
  // 若 user 的 extraBodyJson 解析失敗,debugLog 一條 warn 但不阻斷翻譯。
  const thinkingPayload = buildThinkingPayload({
    baseUrl, model,
    level: thinkingLevel || 'auto',
    extraBodyRaw: extraBodyJson || '',
    onWarn: (msg) => { debugLog('warn', 'api', `customProvider thinking config: ${msg}`); },
  });

  const body = {
    model,
    messages: [
      { role: 'system', content: effectiveSystem },
      { role: 'user', content: joined },
    ],
    temperature: typeof temperature === 'number' ? temperature : 0.7,
    stream: false,
    ...thinkingPayload,
  };

  const url = resolveChatCompletionsUrl(baseUrl);
  // v1.6.7: apiKey 為空時不送 Authorization（本機 llama.cpp / Ollama 等不需要 key）
  const headers = apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {};

  await debugLog('info', 'api', 'openai-compat request', {
    baseUrl, model, segments: texts.length, chars: joined.length,
    inputPreview: joined.slice(0, 300), // v1.5.7: 對齊 gemini.js
    // v1.5.8: 本批 prompt 末端注入的條數（同 gemini.js）
    glossaryCount: glossary?.length || 0,
    fixedGlossaryCount: fixedGlossary?.length || 0,
    forbiddenTermsCount: forbiddenTerms?.length || 0,
  });

  const t0 = Date.now();
  const maxRetries = typeof settings?.maxRetries === 'number' ? settings.maxRetries : 3;
  const resp = await fetchWithRetry(url, headers, body, { maxRetries });

  let json;
  try {
    json = await resp.json();
  } catch (parseErr) {
    const ms = Date.now() - t0;
    let rawPreview = '';
    try { rawPreview = await resp.clone().text().then(t => t.slice(0, 200)); } catch { /* noop */ }
    await debugLog('error', 'api', 'openai-compat response not JSON', {
      status: resp.status, elapsed: ms, parseError: parseErr.message, rawPreview,
    });
    throw new Error(`自訂 Provider 回應格式異常（非 JSON）：HTTP ${resp.status}。${rawPreview ? '前 200 字：' + rawPreview : ''}`);
  }
  const ms = Date.now() - t0;

  if (!resp.ok) {
    const errMsg = json?.error?.message || `HTTP ${resp.status}`;
    await debugLog('error', 'api', 'openai-compat error', { status: resp.status, elapsed: ms, error: errMsg });
    throw new Error(errMsg);
  }

  const choice = json?.choices?.[0];
  const finishReason = choice?.finish_reason || 'unknown';
  const text = choice?.message?.content || '';

  if (!text) {
    await debugLog('error', 'api', 'openai-compat empty content', {
      elapsed: ms, finishReason, choicesLength: json?.choices?.length || 0,
    });
    throw new Error(`自訂 Provider 回傳空內容（finish_reason: ${finishReason}）。`);
  }

  // 抽 usage（OpenAI / OpenRouter 標準結構）
  const u = json?.usage || {};
  const chunkUsage = {
    inputTokens: u.prompt_tokens || 0,
    outputTokens: u.completion_tokens || 0,
    // OpenAI 2024-09 起加的 cache 命中欄位（OpenRouter 也支援）
    cachedTokens: u.prompt_tokens_details?.cached_tokens || u.cached_tokens || 0,
  };

  await debugLog('info', 'api', 'openai-compat response', {
    elapsed: ms,
    segments: texts.length,
    inputTokens: chunkUsage.inputTokens,
    outputTokens: chunkUsage.outputTokens,
    cachedTokens: chunkUsage.cachedTokens,
    finishReason,
    outputPreview: text.slice(0, 300), // v1.5.7: 對齊 gemini.js

  });

  // 拆分對齊（與 Gemini 同邏輯：split by DELIMITER + 移除 «N» 序號標記）
  const SEQ_MARKER_RE = /^«\d+»\s*/;
  const parts = text.split(DELIMITER).map(s => s.trim().replace(SEQ_MARKER_RE, ''));
  if (parts.length !== texts.length) {
    await debugLog('warn', 'api', 'openai-compat segment count mismatch — fallback to per-segment', {
      expected: texts.length, got: parts.length, elapsed: ms,
    });
    if (texts.length === 1) {
      return { parts: [text.trim()], usage: chunkUsage, hadMismatch: false };
    }
    const aligned = [];
    const aggUsage = { ...chunkUsage };
    for (let fi = 0; fi < texts.length; fi++) {
      const r = await translateChunk([texts[fi]], settings, glossary, fixedGlossary, forbiddenTerms);
      aligned.push(r.parts[0] || '');
      aggUsage.inputTokens += r.usage.inputTokens;
      aggUsage.outputTokens += r.usage.outputTokens;
      aggUsage.cachedTokens += r.usage.cachedTokens || 0;
    }
    return { parts: aligned, usage: aggUsage, hadMismatch: true };
  }
  return { parts, usage: chunkUsage, hadMismatch: false };
}
