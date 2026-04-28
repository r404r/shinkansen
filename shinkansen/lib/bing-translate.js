// lib/bing-translate.js — Microsoft Translator 翻譯 API（Nozomi 獨立模組）
//
// 使用 Microsoft Cognitive Services Translator API（免費、無需 API Key）。
// Token 來自 edge.microsoft.com/translate/auth（JWT Bearer）。
// 翻譯端點：api.cognitive.microsofttranslator.com/translate
// 中國大陸可用（已驗證 2026-04-28）。
// 介面對齊 lib/google-translate.js 的 translateGoogleBatch。

import { getBingToken } from './bing-token.js';

const TRANSLATE_URL = 'https://api.cognitive.microsofttranslator.com/translate';
const API_VERSION = '3.0';

// Microsoft Translator 單次最大字元數
// 官方文檔：5000 字元（比 Bing 網頁端點的 1000 寬鬆得多）
const MAX_CHARS_PER_REQUEST = 5000;

// 並發控制：同時最多 3 個翻譯請求
const MAX_CONCURRENCY = 3;

// 語言代碼映射：uiLocale → Microsoft Translator API 格式
const LANG_MAP = {
  'zh-TW': 'zh-Hant',
  'zh-CN': 'zh-Hans',
  'ja': 'ja',
};

/**
 * 批次翻譯字串陣列（自動偵測語言 → 目標語言）。
 * 每段獨立 POST，並發控制最多 3 個同時請求。
 * 超過 5000 字元的段落自動拆分再串接。
 *
 * @param {string[]} texts — 待翻譯文字陣列
 * @param {string} [targetLang='zh-TW'] — 目標語言（zh-TW / zh-CN / ja）
 * @returns {Promise<{ translations: string[], chars: number }>}
 */
export async function translateBingBatch(texts, targetLang = 'zh-TW') {
  if (!texts || texts.length === 0) return { translations: [], chars: 0 };

  const totalChars = texts.reduce((s, t) => s + (t?.length || 0), 0);
  const result = new Array(texts.length).fill('');
  const msLang = LANG_MAP[targetLang] || targetLang;

  // 取得 Bearer token
  let token = await getBingToken();

  // 將長文本拆分為不超過 MAX_CHARS_PER_REQUEST 的 chunk
  const jobs = [];
  for (let i = 0; i < texts.length; i++) {
    const text = texts[i] || '';
    if (text.length === 0) {
      result[i] = '';
      continue;
    }
    if (text.length <= MAX_CHARS_PER_REQUEST) {
      jobs.push({ idx: i, text, partOf: null });
    } else {
      const parts = [];
      for (let offset = 0; offset < text.length; offset += MAX_CHARS_PER_REQUEST) {
        parts.push(text.slice(offset, offset + MAX_CHARS_PER_REQUEST));
      }
      for (let p = 0; p < parts.length; p++) {
        jobs.push({ idx: i, text: parts[p], partOf: { total: parts.length, partIdx: p } });
      }
    }
  }

  // 收集拆分段落的部分結果
  const partialResults = {};

  // 共享 token 刷新狀態
  let _refreshedToken = null;

  async function _doTranslateWithRetry(text, lang, currentToken) {
    const tk = _refreshedToken || currentToken;
    try {
      return await _translateSingle(text, lang, tk);
    } catch (err) {
      if (_isAuthError(err)) {
        if (!_refreshedToken) {
          _refreshedToken = await getBingToken(true);
        }
        return await _translateSingle(text, lang, _refreshedToken);
      }
      throw err;
    }
  }

  function _writeResult(job, translated, resultArr, partials) {
    if (!job.partOf) {
      resultArr[job.idx] = translated;
    } else {
      if (!partials[job.idx]) partials[job.idx] = new Array(job.partOf.total).fill('');
      partials[job.idx][job.partOf.partIdx] = translated;
      if (partials[job.idx].every(p => p !== '')) {
        resultArr[job.idx] = partials[job.idx].join('');
      }
    }
  }

  // 並發執行翻譯
  let cursor = 0;

  async function worker() {
    while (cursor < jobs.length) {
      const job = jobs[cursor++];
      if (!job) break;
      try {
        const translated = await _doTranslateWithRetry(job.text, msLang, token);
        _writeResult(job, translated, result, partialResults);
      } catch {
        _writeResult(job, job.text, result, partialResults);
      }
    }
  }

  const workers = [];
  const concurrency = Math.min(MAX_CONCURRENCY, jobs.length);
  for (let w = 0; w < concurrency; w++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  return { translations: result, chars: totalChars };
}

/**
 * 單次 Microsoft Translator API 請求。
 * @param {string} text — 單段文字
 * @param {string} toLang — Microsoft 語言代碼（zh-Hant / zh-Hans / ja）
 * @param {string} bearerToken — JWT Bearer token
 * @returns {Promise<string>} — 譯文
 */
async function _translateSingle(text, toLang, bearerToken) {
  const url = `${TRANSLATE_URL}?api-version=${API_VERSION}&to=${encodeURIComponent(toLang)}`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${bearerToken}`,
    },
    credentials: 'omit',
    body: JSON.stringify([{ Text: text }]),
  });

  if (!resp.ok) {
    const err = new Error(`Microsoft Translator HTTP ${resp.status}`);
    err.status = resp.status;
    throw err;
  }

  const data = await resp.json();

  // 回應格式：[{ "translations": [{ "text": "...", "to": "zh-Hant" }] }]
  if (Array.isArray(data) && data[0]?.translations?.[0]?.text) {
    return data[0].translations[0].text;
  }

  throw new Error('Unexpected Microsoft Translator response format');
}

/**
 * 判斷是否為認證相關錯誤（需刷新 token）。
 */
function _isAuthError(err) {
  const s = err?.status;
  return s === 401 || s === 403;
}
