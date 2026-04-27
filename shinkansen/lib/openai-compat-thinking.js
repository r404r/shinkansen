// openai-compat-thinking.js — v1.6.18
// 自訂模型(OpenAI 相容端點)的 thinking 控制 mapping
//
// 各家 provider thinking schema 差異對照(2026-04 校準,文件來源見 CHANGELOG):
//   OpenRouter unified : reasoning: { effort: 'low'/'medium'/'high', exclude: true }
//   DeepSeek native    : extra_body.thinking: { type: 'enabled'/'disabled' } + effort
//   Anthropic Claude   : thinking: { type: 'enabled'/'disabled'/'adaptive', budget_tokens }
//   OpenAI o-series    : reasoning_effort: 'minimal'/'low'/'medium'/'high'
//   Grok (xAI)         : reasoning_effort: 'low'/'medium'/'high'/'xhigh'(只多 agent model 支援)
//   Qwen               : enable_thinking: true/false (extra_body)
//
// 設計策略:
//   1. user 的 thinkingLevel 為 'auto' → 不送任何 thinking 參數,由 provider 自選
//   2. 偵測 baseUrl 含 openrouter.ai → 一律用 OpenRouter unified reasoning(99% 使用者走這條)
//   3. native 直連各家 → 用對應 provider 的官方 schema
//   4. 不認識的 provider → 不送(避免送到不支援的參數導致 4xx)
//   5. user 的 extraBodyJson(進階)→ deep merge 到結果,可覆蓋 1-3 步的自動 mapping

/**
 * 偵測 baseUrl + model name 屬於哪個 provider。
 * 偵測順序:OpenRouter(host)→ 其他依 baseUrl host → 最後依 model 名。
 * @returns {'openrouter' | 'deepseek' | 'claude' | 'openai-o' | 'grok' | 'qwen' | 'unknown'}
 */
export function detectProvider(baseUrl, model) {
  const url = String(baseUrl || '').toLowerCase();
  const m = String(model || '').toLowerCase();

  if (/openrouter\.ai/.test(url)) return 'openrouter';
  if (/api\.deepseek\.com/.test(url)) return 'deepseek';
  if (/api\.anthropic\.com|claude/.test(url)) return 'claude';
  if (/api\.x\.ai/.test(url)) return 'grok';
  if (/api\.openai\.com/.test(url) && /^o[1-9]/.test(m)) return 'openai-o';
  if (/dashscope|aliyun/.test(url)) return 'qwen';

  // baseUrl 無線索 → 依 model 名(自訂端點 / 自架 proxy 場景)
  if (/^anthropic\/|claude/.test(m)) return 'claude';
  if (/^deepseek\//.test(m)) return 'deepseek';
  if (/^openai\/o|^o[1-9]/.test(m)) return 'openai-o';
  if (/grok/.test(m)) return 'grok';
  if (/qwen|qwq/.test(m)) return 'qwen';

  return 'unknown';
}

/**
 * 依 provider 與 thinking level 產生對應的 request body 片段。
 * 設計重點:
 *   - 'auto' 永遠回 {}(不干涉,讓 provider 自選預設)
 *   - 各 provider 的 'off' 寫法不同:
 *     OpenRouter 沒真 disable,只能 exclude(內部 reason 但不回 token)
 *     DeepSeek extra_body.thinking.type='disabled'
 *     Claude thinking.type='disabled'
 *     OpenAI o-series 沒 disable,最低用 'minimal'
 *     Grok 不支援 disable,off 時索性不送
 *     Qwen extra_body.enable_thinking=false
 *   - 不認識 provider 一律回 {}(不送風險未知參數)
 */
export function buildNativeThinking(provider, level) {
  if (!level || level === 'auto') return {};

  switch (provider) {
    case 'openrouter':
      if (level === 'off') return { reasoning: { exclude: true } };
      return { reasoning: { effort: level } };

    case 'deepseek':
      return { extra_body: { thinking: { type: level === 'off' ? 'disabled' : 'enabled' } } };

    case 'claude':
      if (level === 'off') return { thinking: { type: 'disabled' } };
      return { thinking: { type: 'adaptive' } };

    case 'openai-o':
      // 'off' 用 'minimal'(no real disable);'low'/'medium'/'high' 直送
      return { reasoning_effort: level === 'off' ? 'minimal' : level };

    case 'grok':
      // grok 多數 model 不支援 reasoning_effort,送錯會 400。off 索性不送。
      // 'high' 等支援的場景才送。
      if (level === 'off') return {};
      return { reasoning_effort: level };

    case 'qwen':
      return { extra_body: { enable_thinking: level !== 'off' } };

    case 'unknown':
    default:
      return {};
  }
}

/**
 * 安全解析使用者填的 extraBodyJson。失敗回 {} + 透過 onWarn callback 通知。
 * 不 throw(避免 UI 因 JSON 格式錯就無法翻譯)。
 */
export function safeParseJson(raw, onWarn) {
  if (!raw || typeof raw !== 'string') return {};
  const trimmed = raw.trim();
  if (!trimmed) return {};
  try {
    const v = JSON.parse(trimmed);
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    if (onWarn) onWarn('extraBodyJson 不是物件,已忽略');
    return {};
  } catch (e) {
    if (onWarn) onWarn(`extraBodyJson 解析失敗: ${e.message}`);
    return {};
  }
}

/**
 * 深層 merge 兩個物件(對 plain object 遞迴 merge,陣列/原始值由 b 覆蓋 a)。
 * 用於把 user 的 extraBodyJson 蓋到自動 mapping 結果上。
 */
export function deepMerge(a, b) {
  if (!isPlainObject(b)) return b === undefined ? a : b;
  if (!isPlainObject(a)) return { ...b };
  const out = { ...a };
  for (const k of Object.keys(b)) {
    if (isPlainObject(a[k]) && isPlainObject(b[k])) {
      out[k] = deepMerge(a[k], b[k]);
    } else {
      out[k] = b[k];
    }
  }
  return out;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * 主入口:組合最終要 merge 進 chat.completions request body 的 thinking-related payload。
 *
 * @param {object} opts
 * @param {string} opts.baseUrl
 * @param {string} opts.model
 * @param {string} opts.level - 'auto' | 'off' | 'low' | 'medium' | 'high'
 * @param {string} opts.extraBodyRaw - user 自訂 JSON 字串(可空)
 * @param {Function} [opts.onWarn] - JSON 解析失敗時的 callback,接 message 字串
 * @returns {object} 可直接 spread 進 request body 的物件
 */
export function buildThinkingPayload({ baseUrl, model, level, extraBodyRaw, onWarn }) {
  const provider = detectProvider(baseUrl, model);
  const native = buildNativeThinking(provider, level);
  const extra = safeParseJson(extraBodyRaw, onWarn);
  return deepMerge(native, extra);
}
