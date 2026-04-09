// gemini.js — Google Gemini REST API 封裝
// 支援批次翻譯、Service Tier (Flex/Standard/Priority)、除錯 Log。
// v0.69: 新增 extractGlossary() 術語表擷取功能。

import { debugLog } from './logger.js';

const DELIMITER = '\n<<<SHINKANSEN_SEP>>>\n';
// v0.37 起改為「段數 + 字元預算」雙門檻（雙重保險層 — content.js 已先打包過）
const MAX_UNITS_PER_CHUNK = 20;
const MAX_CHARS_PER_CHUNK = 3500;
const MAX_BACKOFF_MS = 8000;

/**
 * Greedy 打包：對 texts 陣列用字元預算 + 段數上限雙門檻切成連續子批次，
 * 回傳「起始 index 陣列」讓呼叫端可以對齊結果。
 */
function packChunks(texts) {
  const batches = [];
  let cur = null;
  const flush = () => { if (cur && cur.end > cur.start) batches.push(cur); cur = null; };
  for (let i = 0; i < texts.length; i++) {
    const len = (texts[i] || '').length;
    if (len > MAX_CHARS_PER_CHUNK) {
      flush();
      batches.push({ start: i, end: i + 1 });
      continue;
    }
    if (cur && (cur.chars + len > MAX_CHARS_PER_CHUNK || (cur.end - cur.start) >= MAX_UNITS_PER_CHUNK)) {
      flush();
    }
    if (!cur) cur = { start: i, end: i, chars: 0 };
    cur.end = i + 1;
    cur.chars += len;
  }
  flush();
  return batches;
}

/** 自訂錯誤:RPD 每日配額用盡,不應該被重試。 */
export class DailyQuotaExceededError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DailyQuotaExceededError';
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 從 Gemini 429 的 response body 找出爆掉的維度(RPM/TPM/RPD)。
 * 若找不到明確線索回傳 null。
 */
function extractQuotaDimension(json) {
  const details = json?.error?.details;
  if (!Array.isArray(details)) return null;
  for (const d of details) {
    const metric = d?.quotaMetric || d?.metric || '';
    const id = d?.quotaId || '';
    const haystack = `${metric} ${id}`.toLowerCase();
    if (haystack.includes('perday') || haystack.includes('_day')) return 'RPD';
    if (haystack.includes('tokens') && haystack.includes('minute')) return 'TPM';
    if (haystack.includes('requests') && haystack.includes('minute')) return 'RPM';
  }
  return null;
}

/**
 * fetch Gemini API,帶 429 退避重試。
 * - 收到 429 → 讀 Retry-After header(秒數)等待後重試
 * - Retry-After 沒給 → 指數退避 2^n * 500ms(上限 8s)
 * - 爆的是 RPD → 丟 DailyQuotaExceededError,不 retry
 * - 重試次數超過 maxRetries → 丟原錯誤
 */
async function fetchWithRetry(url, body, { maxRetries = 3 } = {}) {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let resp;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err) {
      await debugLog('error', 'gemini fetch network error', { error: err.message, attempt });
      if (attempt >= maxRetries) throw new Error('網路錯誤：' + err.message);
      await sleep(Math.min(MAX_BACKOFF_MS, 500 * Math.pow(2, attempt)));
      attempt += 1;
      continue;
    }

    // v0.84: 5xx 伺服器錯誤也重試（Gemini 偶爾回 500/503 服務暫時不可用）
    if (resp.status >= 500 && resp.status < 600) {
      await debugLog('warn', `gemini ${resp.status} server error`, { status: resp.status, attempt });
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

    // 429 處理
    let bodyJson = null;
    try { bodyJson = await resp.clone().json(); } catch { /* noop */ }
    const dim = extractQuotaDimension(bodyJson);
    const retryAfterHeader = resp.headers.get('retry-after');
    const retryAfterSec = retryAfterHeader ? parseInt(retryAfterHeader, 10) : NaN;

    await debugLog('warn', 'gemini 429 rate limit', {
      dimension: dim,
      retryAfter: retryAfterHeader,
      attempt,
      error: bodyJson?.error?.message,
    });

    if (dim === 'RPD') {
      throw new DailyQuotaExceededError('今日 Gemini API 配額已用盡(RPD 達上限),請明天再試或升級付費層級。');
    }

    if (attempt >= maxRetries) {
      const msg = bodyJson?.error?.message || `HTTP 429(${dim || '未知維度'})`;
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
 * v0.69: 術語表擷取 — 從壓縮過的文章摘要中提取專有名詞對照表。
 * v0.70: 改為直接 fetch + AbortController（不走 fetchWithRetry），
 *        因為術語表是 best-effort，不需要重試，且必須在有限時間內回應。
 *
 * @param {string} compressedText 壓縮後的文章摘要（headings + 每段首句等）
 * @param {object} settings 完整設定
 * @returns {Promise<{ glossary: Array<{source:string, target:string, type:string}>, usage: {inputTokens:number, outputTokens:number, cachedTokens:number} }>}
 *
 * 失敗（包含 JSON 格式錯誤、逾時）一律回傳空陣列 + usage，由上層 fallback。
 */
export async function extractGlossary(compressedText, settings) {
  const { apiKey, geminiConfig, glossary: glossaryConfig } = settings;
  const {
    model,
    serviceTier,
    topP,
    topK,
    maxOutputTokens,
  } = geminiConfig;

  const glossaryPrompt = glossaryConfig?.prompt || '';
  const glossaryTemperature = glossaryConfig?.temperature ?? 0.1;
  const maxTerms = glossaryConfig?.maxTerms ?? 200;
  // v0.70: fetch 層級的 timeout — Structured Output 對大輸入可能需要 30–60 秒
  const fetchTimeoutMs = glossaryConfig?.fetchTimeoutMs ?? 55_000;

  // v0.72: 保底至少 4096，作為額外防線。
  const glossaryMaxOutput = Math.max(maxOutputTokens || 0, 4096);

  const body = {
    contents: [{ role: 'user', parts: [{ text: compressedText }] }],
    systemInstruction: { parts: [{ text: glossaryPrompt }] },
    generationConfig: {
      temperature: glossaryTemperature,
      topP,
      topK,
      maxOutputTokens: glossaryMaxOutput,
      // v0.74: 關閉思考功能。gemini-2.5-flash 是 thinking model，思考 token
      // 計入 maxOutputTokens 額度。術語擷取是直覺性對照工作，不需深度推理，
      // 關閉思考後全部 token 額度留給實際 JSON 輸出，徹底解決「明明上限 8192
      // 卻只產出 300 多 tokens 就 MAX_TOKENS」的問題（根因：思考 token 吃掉
      // 了 7000+ 額度）。v0.72 的註解（「JSON mode 提早結束生成」）描述的也是
      // 同一個現象，當時誤判為 JSON mode 的問題而移除 responseMimeType，
      // 實際上是 thinking token 的問題。
      thinkingConfig: { thinkingBudget: 0 },
    },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
    ],
  };

  if (serviceTier && serviceTier !== 'DEFAULT') {
    body.service_tier = serviceTier.toLowerCase();
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  await debugLog('info', 'glossary extraction request', { model, chars: compressedText.length, fetchTimeoutMs, maxOutputTokens: glossaryMaxOutput, settingsMaxOutput: maxOutputTokens });

  const t0 = Date.now();

  // v0.70: 直接 fetch + AbortController，不走 fetchWithRetry。
  // 術語表是 best-effort：要嘛一次成功，要嘛放棄。不值得 retry 燒時間。
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), fetchTimeoutMs);
  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(abortTimer);
    const reason = err.name === 'AbortError' ? `fetch timeout (${fetchTimeoutMs}ms)` : 'network error';
    await debugLog('error', `glossary extraction failed (${reason})`, { error: err.message, ms: Date.now() - t0 });
    return { glossary: [], usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 }, _diag: `${reason}: ${err.message}` };
  }
  clearTimeout(abortTimer);

  let json;
  try {
    json = await resp.json();
  } catch (parseErr) {
    await debugLog('error', 'glossary extraction: response body parse failed', { status: resp.status, error: parseErr.message });
    return { glossary: [], usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 }, _diag: `resp.json() failed: ${parseErr.message}` };
  }
  const ms = Date.now() - t0;
  const meta = json?.usageMetadata || {};
  const usage = {
    inputTokens: meta.promptTokenCount || 0,
    outputTokens: meta.candidatesTokenCount || 0,
    cachedTokens: meta.cachedContentTokenCount || 0,
  };

  if (!resp.ok) {
    const errMsg = json?.error?.message || `HTTP ${resp.status}`;
    await debugLog('error', 'glossary extraction failed (API)', { status: resp.status, error: errMsg, ms });
    // v0.70: 回傳 _diag 供 content.js 顯示，方便從頁面 console 看到錯誤原因
    return { glossary: [], usage, _diag: `API error ${resp.status}: ${errMsg}` };
  }

  const rawText = json?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const finishReason = json?.candidates?.[0]?.finishReason || 'unknown';
  await debugLog('info', 'glossary extraction response', {
    ms, usage: meta, rawChars: rawText.length, finishReason,
  });

  // v0.72: 不用 responseMimeType 後，模型可能在 JSON 前後附帶說明文字
  // 或用 ```json ... ``` code fence 包裹。需要先提取 JSON 部分再 parse。
  let jsonStr = rawText.trim();

  // 移除 markdown code fence（```json ... ``` 或 ``` ... ```）
  const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim();
  } else {
    // 找第一個 [ 或 { 到最後一個 ] 或 } 之間的內容
    const firstBracket = jsonStr.search(/[\[{]/);
    const lastBracket = Math.max(jsonStr.lastIndexOf(']'), jsonStr.lastIndexOf('}'));
    if (firstBracket !== -1 && lastBracket > firstBracket) {
      jsonStr = jsonStr.slice(firstBracket, lastBracket + 1);
    }
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (parseErr) {
    await debugLog('warn', 'glossary JSON parse failed', {
      error: parseErr.message, finishReason,
      preview: rawText.slice(0, 500),
    });
    return { glossary: [], usage, _diag: `JSON parse error (finishReason=${finishReason}): ${parseErr.message}, preview: ${rawText.slice(0, 300)}` };
  }

  // 從各種可能的 JSON 結構中找出術語陣列
  let entries;
  if (Array.isArray(parsed)) {
    entries = parsed;
  } else if (parsed && typeof parsed === 'object') {
    // 找第一個值是 array 的 key（模型可能用 "terms"、"glossary"、"entries" 等任何 key）
    const arrKey = Object.keys(parsed).find(k => Array.isArray(parsed[k]));
    entries = arrKey ? parsed[arrKey] : null;
  }

  if (!entries) {
    await debugLog('warn', 'glossary result: no array found in response', {
      type: typeof parsed,
      keys: parsed ? Object.keys(parsed).slice(0, 5) : [],
    });
    return { glossary: [], usage, _diag: `no array in response (rawText first 500): ${rawText.slice(0, 500)}` };
  }

  if (entries.length === 0) {
    return { glossary: [], usage, _diag: `entries array is empty (rawText first 500): ${rawText.slice(0, 500)}` };
  }

  // 過濾有效 entry 並截斷到 maxTerms
  const glossary = entries
    .filter(e => e && typeof e.source === 'string' && typeof e.target === 'string' && e.source && e.target)
    .slice(0, maxTerms);

  // v0.75 診斷：若有 entries 但全被過濾掉，回傳前幾筆的結構讓 content.js 能看到
  if (entries.length > 0 && glossary.length === 0) {
    const sampleDiag = JSON.stringify(entries.slice(0, 3)).slice(0, 500);
    return { glossary: [], usage, _diag: `entries=${entries.length} but 0 valid (missing source/target?). samples: ${sampleDiag}` };
  }

  await debugLog('info', 'glossary extraction done', {
    totalEntries: entries.length, validTerms: glossary.length, ms, finishReason,
  });

  return { glossary, usage };
}

/**
 * 批次翻譯文字陣列（會自動切成多批送出）。
 * @param {string[]} texts 原文陣列
 * @param {object} settings 完整設定
 * @param {Array<{source:string, target:string}>} [glossary] 可選的術語對照表（v0.69）
 * @returns {Promise<{ translations: string[], usage: { inputTokens: number, outputTokens: number, cachedTokens: number } }>}
 *
 * 註：`cachedTokens` 來自 Gemini API 回應的 `usageMetadata.cachedContentTokenCount`，
 * 代表本次輸入中被 Gemini implicit context cache 命中的 token 數。
 * 命中的部分 Gemini 會以全價 25% 計費（2.5 系列 Flash/Pro 預設開啟 implicit cache，
 * 命中條件是 prompt 前綴穩定且達到最低門檻：Flash ~1024、Pro ~2048）。
 * 這個數字跟 `lib/cache.js` 的本地 `tc_<sha1>` 翻譯快取是不同概念 ——
 * 本地快取命中的段落根本不會送 API，而 implicit cache 命中的段落有送 API
 * 但前綴（system prompt 那一大段）被 Gemini 內部 cache 省下。
 */
export async function translateBatch(texts, settings, glossary) {
  if (!texts?.length) return { translations: [], usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 } };
  const out = new Array(texts.length);
  const usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
  const chunks = packChunks(texts);
  for (const { start, end } of chunks) {
    const slice = texts.slice(start, end);
    const { parts, usage: u } = await translateChunk(slice, settings, glossary);
    for (let j = 0; j < parts.length; j++) out[start + j] = parts[j];
    usage.inputTokens += u.inputTokens;
    usage.outputTokens += u.outputTokens;
    usage.cachedTokens += u.cachedTokens || 0;
  }
  return { translations: out, usage };
}

async function translateChunk(texts, settings, glossary) {
  if (!texts?.length) return [];
  const { apiKey, geminiConfig } = settings;
  const {
    model,
    serviceTier,
    temperature,
    topP,
    topK,
    maxOutputTokens,
    useThinking,
    systemInstruction,
  } = geminiConfig;

  // 將多段以分隔符合併，單次請求省費用
  const joined = texts.join(DELIMITER);

  // 若本批文字含 ⟦…⟧ 佔位符（content.js 為了保留連結 / 樣式而注入的）,
  // 在 systemInstruction 後面追加一條規則，要求 LLM 原樣保留這些標記。
  //
  // v0.71: 建構順序很重要——行為規則（換行、佔位符）必須緊跟在基礎翻譯指令後面，
  // 術語表是「參考資料」放最後。若術語表夾在中間會稀釋 LLM 對佔位符規則的注意力，
  // 導致 ⟦*N⟧ 標記洩漏到譯文裡（v0.70 的 bug）。
  let effectiveSystem = systemInstruction;

  // v0.77: 多段翻譯時，追加明確的分隔符規則。
  // 根因：system prompt 第 4 條只說「以特定分隔符號區隔」太模糊，Gemini 有時會
  // 忽略 <<<SHINKANSEN_SEP>>> 分隔符，把所有段落翻譯合併成一段輸出，觸發
  // per-segment fallback（逐段重送 API），造成該批次耗時 10 倍以上。
  // 這裡明確告訴模型分隔符的完整字串和預期的段數，確保輸出格式正確。
  if (texts.length > 1) {
    effectiveSystem = effectiveSystem +
      `\n\n額外規則（多段翻譯分隔符，極重要）:\n本批次包含 ${texts.length} 段文字，段與段之間以分隔符 <<<SHINKANSEN_SEP>>> 隔開。你的輸出也必須用完全相同的分隔符 <<<SHINKANSEN_SEP>>> 將各段譯文隔開。輸出必須恰好包含 ${texts.length} 段譯文和 ${texts.length - 1} 個分隔符，順序與輸入一一對應。不可合併段落、不可省略分隔符、不可增減段數。`;
  }

  // v0.50: 若本批文字含段內換行（\n，來自序列化時 <br> 的還原）,追加一條規則
  // 要求 LLM 在對應位置保留 \n 段落分隔。MJML / Mailjet 等 HTML email 模板用
  // <br><br> 取代 <p> 做段落分隔,如果譯文沒對應的 \n,注入時整段會擠在一起。
  // 注意:這條檢測必須只看「段內」的 \n,DELIMITER 本身的 \n 不算——所以檢查
  // 各段 texts 而不是 joined。
  if (texts.some(t => t && t.indexOf('\n') !== -1)) {
    effectiveSystem = (effectiveSystem || systemInstruction) +
      '\n\n額外規則（段落分隔）:\n輸入中可能含有段內換行符 \\n（例如 "第一段\\n\\n第二段"）,代表原文有對應的段落或行分隔（通常是 <br> 或 <br><br>）。翻譯時必須在對應位置原樣保留 \\n 字元——譯文段落數與輸入段落數一致,連續兩個 \\n 也要保留兩個。不可把段落合併成一行,也不可把空白行多塞或少塞。';
  }

  if (joined.indexOf('\u27E6') !== -1) {
    effectiveSystem = effectiveSystem + '\n\n額外規則（極重要，處理佔位符標記）:\n輸入中可能含有兩種佔位符標記，都是用來保留原文結構，必須原樣保留、不可翻譯、不可省略、不可改寫、不可新增、不可重排。佔位符裡的數字、斜線、星號 **必須是半形 ASCII 字元**（0-9、/、*），絕對不可改成全形（０-９、／、＊），否則程式無法配對會整段崩壞。\n\n（A）配對型 ⟦數字⟧…⟦/數字⟧（例如 ⟦0⟧Tokugawa Ieyasu⟦/0⟧)：\n- 把標記視為透明外殼。外殼「內部」的文字跟外殼「外部」的文字一樣，全部都要翻譯成繁體中文。\n- ⟦數字⟧ 與 ⟦/數字⟧ 兩個標記本身原樣保留，數字不變。\n- **配對型可以巢狀嵌套**（例如 ⟦0⟧may incorporate text from a ⟦1⟧large language model⟦/1⟧, which is ...⟦/0⟧）。巢狀代表原文是 `<b>text <a>link</a> more text</b>` 這類嵌套結構。翻譯時必須**同時**保留外層與內層兩組標記、不可扁平化成單層、不可交換順序、不可遺漏任何一層。外層與內層的內部文字全部要翻成繁體中文。\n\n（B）自閉合 ⟦*數字⟧（例如 ⟦*5⟧)：\n- 這是「原子保留」位置記號，代表原文裡有一段不可翻譯的小區塊（例如維基百科腳註參照 [2])。\n- 整個 ⟦*數字⟧ token 原樣保留，不可拆開、不可翻譯、不可省略，數字不變。\n- 它的位置代表那段內容應該插在譯文的哪裡。\n\n具體範例 1（單層）：\n輸入： ⟦0⟧Tokugawa Ieyasu⟦/0⟧ won the ⟦1⟧Battle of Sekigahara⟦/1⟧ in 1600.⟦*2⟧\n正確輸出： ⟦0⟧德川家康⟦/0⟧於 1600 年贏得⟦1⟧關原之戰⟦/1⟧。⟦*2⟧\n錯誤輸出 1： ⟦0⟧Tokugawa Ieyasu⟦/0⟧於 1600 年贏得⟦1⟧Battle of Sekigahara⟦/1⟧。⟦*2⟧（配對型內部英文沒翻）\n錯誤輸出 2： ⟦0⟧德川家康⟦/0⟧於 1600 年贏得⟦1⟧關原之戰⟦/1⟧。[2]（自閉合 ⟦*2⟧ 被擅自還原成 [2])\n\n具體範例 2（巢狀）：\n輸入： This article ⟦0⟧may incorporate text from a ⟦1⟧large language model⟦/1⟧, which is ⟦2⟧prohibited in Wikipedia articles⟦/2⟧⟦/0⟧.\n正確輸出： 本條目⟦0⟧可能包含來自⟦1⟧大型語言模型⟦/1⟧的文字，這在⟦2⟧維基百科條目中是被禁止的⟦/2⟧⟦/0⟧。\n錯誤輸出 3： 本條目可能包含來自⟦1⟧大型語言模型⟦/1⟧的文字，這在⟦2⟧維基百科條目中是被禁止的⟦/2⟧。（外層 ⟦0⟧…⟦/0⟧ 被扁平化丟掉）';
  }

  // v0.69/v0.71: 術語對照表放在 systemInstruction 最末端。
  // 這是「參考資料」而非「行為規則」，放最後不會干擾佔位符 / 換行等關鍵規則。
  if (glossary && glossary.length > 0) {
    const lines = glossary.map(e => `${e.source} → ${e.target}`).join('\n');
    effectiveSystem = effectiveSystem +
      '\n\n以下是本篇文章的術語對照表，遇到這些原文一律使用指定譯名，不可自行改寫，也不需加註英文原文：\n' + lines;
  }

  const body = {
    contents: [{ role: 'user', parts: [{ text: joined }] }],
    systemInstruction: { parts: [{ text: effectiveSystem }] },
    generationConfig: {
      temperature,
      topP,
      topK,
      maxOutputTokens,
      // v0.77: 預設關閉思考功能（useThinking=false）。gemini-2.5-flash 是
      // thinking model，思考 token 計入 maxOutputTokens 額度，可能導致輸出
      // 截斷 → segment mismatch → per-segment fallback（極慢）。
      // v0.79: 改為可透過設定頁開關控制。開啟時移除此限制，讓模型自行決定
      // 思考預算（可能提高翻譯品質但增加延遲與 token 消耗）。
      ...(useThinking ? {} : { thinkingConfig: { thinkingBudget: 0 } }),
    },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
    ],
  };

  // 只有在使用者明確選擇 flex/standard/priority 時才送 service_tier。
  // 若為 'DEFAULT' 或空值則完全不送此欄位，避免舊模型拒絕。
  // 注意：REST API 欄位名稱用 snake_case（service_tier），值用小寫（flex）,
  // 對應 Google 官方 REST 範例與 JS SDK 慣例。
  if (serviceTier && serviceTier !== 'DEFAULT') {
    body.service_tier = serviceTier.toLowerCase(); // "flex" / "standard" / "priority"
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  await debugLog('info', 'gemini request', { model, serviceTier, segments: texts.length });

  const t0 = Date.now();
  const maxRetries = typeof settings?.maxRetries === 'number' ? settings.maxRetries : 3;
  console.log(`[Shinkansen] translateChunk: sending ${texts.length} segments, ${joined.length} chars`);
  const resp = await fetchWithRetry(url, body, { maxRetries });

  // v0.84: resp.json() 加 try-catch。API 回傳非 JSON 時（HTML 錯誤頁、空回應、
  // CDN 擋下的 502 HTML 頁面等）原本會直接 crash，現在包成可讀的錯誤訊息。
  let json;
  try {
    json = await resp.json();
  } catch (parseErr) {
    const ms = Date.now() - t0;
    // 嘗試讀 raw text 取前 200 字元作為診斷線索
    let rawPreview = '';
    try { rawPreview = await resp.clone().text().then(t => t.slice(0, 200)); } catch { /* noop */ }
    await debugLog('error', 'gemini response body is not JSON', {
      status: resp.status, ms, parseError: parseErr.message, rawPreview,
    });
    throw new Error(`Gemini API 回應格式異常（非 JSON）：HTTP ${resp.status}。${rawPreview ? '回應前 200 字元：' + rawPreview : ''}`);
  }
  const ms = Date.now() - t0;
  console.log(`[Shinkansen] translateChunk: API responded in ${ms}ms (${texts.length} segments)`);

  if (!resp.ok) {
    await debugLog('error', 'gemini error', { status: resp.status, json, ms });
    const msg = json?.error?.message || `HTTP ${resp.status}`;
    throw new Error(msg);
  }

  // v0.84: candidates 結構驗證。API 可能回傳空 candidates（被安全過濾器擋掉、
  // 模型拒絕回應、promptFeedback.blockReason 不為空等情況）。
  const candidate = json?.candidates?.[0];
  const finishReason = candidate?.finishReason || 'unknown';
  const text = candidate?.content?.parts?.[0]?.text || '';

  // 檢查 promptFeedback（整個 prompt 被擋的情況，candidates 會是空陣列）
  const blockReason = json?.promptFeedback?.blockReason;
  if (blockReason) {
    await debugLog('error', 'gemini prompt blocked', { blockReason, ms });
    throw new Error(`Gemini 拒絕處理此請求（promptFeedback.blockReason: ${blockReason}）。可能是安全過濾器誤判，請嘗試縮短段落或調整內容。`);
  }

  // 檢查 candidates 為空或無文字輸出
  if (!candidate || !text) {
    await debugLog('error', 'gemini empty candidates', {
      ms, finishReason,
      candidatesLength: json?.candidates?.length || 0,
      promptFeedback: json?.promptFeedback,
    });
    // 根據 finishReason 給出更有意義的錯誤訊息
    const reasonMessages = {
      SAFETY: '內容被 Gemini 安全過濾器擋下。可能是原文含有敏感內容，請嘗試跳過此段落。',
      RECITATION: 'Gemini 偵測到輸出與已知作品高度重複（recitation filter），請嘗試縮短段落。',
      MAX_TOKENS: '輸出超過 maxOutputTokens 上限。請到設定頁提高上限，或減少每批段落數。',
      OTHER: 'Gemini 回傳空內容（finishReason: OTHER），原因不明。請稍後重試。',
    };
    const friendlyMsg = reasonMessages[finishReason]
      || `Gemini 回傳空內容（finishReason: ${finishReason}）。`;
    throw new Error(friendlyMsg);
  }

  // finishReason 異常警告（有文字但不是正常結束）
  if (finishReason && finishReason !== 'STOP' && finishReason !== 'unknown') {
    console.warn(`[Shinkansen] translateChunk: finishReason=${finishReason} (expected STOP) — output may be truncated`);
    await debugLog('warn', 'gemini unusual finishReason', { finishReason, ms, textLength: text.length });
  }

  const meta = json?.usageMetadata || {};
  const chunkUsage = {
    inputTokens: meta.promptTokenCount || 0,
    outputTokens: meta.candidatesTokenCount || 0,
    // Gemini 2.5+ implicit context caching 命中的 token 數（輸入 tokens 的子集）。
    // 未命中或舊模型時欄位不會出現，用 || 0 防呆。
    cachedTokens: meta.cachedContentTokenCount || 0,
  };
  await debugLog('info', 'gemini response', {
    ms,
    usage: meta,
    finishReason,
    preview: text.slice(0, 200),
  });

  const parts = text.split(DELIMITER).map(s => s.trim());
  // 若回傳段數不符，且本批不只一段，則 fallback 改為逐段單獨翻譯，確保對齊
  if (parts.length !== texts.length) {
    console.warn(`[Shinkansen] ⚠️ SEGMENT MISMATCH: expected ${texts.length} segments, got ${parts.length} — falling back to per-segment translation (this will be SLOW)`);
    await debugLog('warn', 'segment count mismatch — fallback to per-segment', {
      expected: texts.length, got: parts.length,
    });
    if (texts.length === 1) {
      // 單段模式：直接回傳整個 text(LLM 可能多吐了分隔符）
      return { parts: [text.trim()], usage: chunkUsage };
    }
    // 逐段 fallback：每段都會真的再打一次 API，需累加 usage
    // 注意：此時原本這一批的 chunkUsage 已經付過錢了，但結果沒法對齊要丟掉，
    // 所以還是要算進總成本裡。
    const aligned = [];
    const aggUsage = { ...chunkUsage };
    const tFallback0 = Date.now();
    for (let fi = 0; fi < texts.length; fi++) {
      const tSeg0 = Date.now();
      const r = await translateChunk([texts[fi]], settings, glossary);
      console.log(`[Shinkansen]   fallback segment ${fi + 1}/${texts.length}: ${Date.now() - tSeg0}ms`);
      aligned.push(r.parts[0] || '');
      aggUsage.inputTokens += r.usage.inputTokens;
      aggUsage.outputTokens += r.usage.outputTokens;
      aggUsage.cachedTokens += r.usage.cachedTokens || 0;
    }
    console.log(`[Shinkansen] fallback complete: ${texts.length} segments in ${Date.now() - tFallback0}ms (original batch took ${ms}ms)`);
    return { parts: aligned, usage: aggUsage };
  }
  return { parts, usage: chunkUsage };
}
