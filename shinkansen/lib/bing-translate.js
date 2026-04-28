// lib/bing-translate.js — Bing Translate 翻譯 API（Nozomi 獨立模組）
//
// 使用 Bing 非官方端點（/ttranslatev3），免費、無需 API Key。
// 中國大陸可用（cn.bing.com）。
// 介面對齊 lib/google-translate.js 的 translateGoogleBatch。

import { getBingToken } from './bing-token.js';

// Bing 單次翻譯上限（公開頁面標示 1000 字元）
const MAX_CHARS_PER_REQUEST = 1000;

// 並發控制：同時最多 3 個翻譯請求（避免被限流）
const MAX_CONCURRENCY = 3;

// 語言代碼映射：uiLocale → Bing API 格式
const LANG_MAP = {
  'zh-TW': 'zh-Hant',
  'zh-CN': 'zh-Hans',
  'ja': 'ja',
};

/**
 * 批次翻譯字串陣列（自動偵測語言 → 目標語言）。
 * 逐段翻譯（不串接），並發控制最多 3 個同時請求。
 *
 * @param {string[]} texts — 待翻譯文字陣列
 * @param {string} [targetLang='zh-TW'] — 目標語言（zh-TW / zh-CN / ja）
 * @param {string} [endpointMode='auto'] — 域名策略（auto / global / china）
 * @returns {Promise<{ translations: string[], chars: number }>}
 */
export async function translateBingBatch(texts, targetLang = 'zh-TW', endpointMode = 'auto') {
  if (!texts || texts.length === 0) return { translations: [], chars: 0 };

  const totalChars = texts.reduce((s, t) => s + (t?.length || 0), 0);
  const result = new Array(texts.length).fill('');
  const bingLang = LANG_MAP[targetLang] || targetLang;

  // 取得 token（快取 + 自動刷新）
  let tokenData = await getBingToken(endpointMode);

  // 將長文本拆分為不超過 MAX_CHARS_PER_REQUEST 的 chunk
  // 超過上限的文本拆成多段分別翻譯，結果串接回去（Codex P2-1）
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
      // 拆分為多個 chunk，記錄歸屬同一 idx
      const parts = [];
      for (let offset = 0; offset < text.length; offset += MAX_CHARS_PER_REQUEST) {
        parts.push(text.slice(offset, offset + MAX_CHARS_PER_REQUEST));
      }
      for (let p = 0; p < parts.length; p++) {
        jobs.push({ idx: i, text: parts[p], partOf: { total: parts.length, partIdx: p } });
      }
    }
  }

  // 用於收集拆分段落的部分結果
  const partialResults = {};

  // 共享 token 刷新狀態（Codex P2-2：所有 worker 共享刷新後的 token）
  let _refreshedTokenData = null;

  async function _doTranslateWithRetry(text, lang, currentTokenData, mode) {
    // 若已有刷新過的 token，優先使用
    const td = _refreshedTokenData || currentTokenData;
    try {
      return await _translateSingle(text, lang, td);
    } catch (err) {
      if (_isAuthError(err)) {
        // 只刷新一次，所有 worker 共享結果
        if (!_refreshedTokenData) {
          _refreshedTokenData = await getBingToken(mode, true);
        }
        return await _translateSingle(text, lang, _refreshedTokenData);
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
      // 所有 part 都完成時串接
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
        const translated = await _doTranslateWithRetry(job.text, bingLang, tokenData, endpointMode);
        _writeResult(job, translated, result, partialResults);
      } catch {
        // 翻譯失敗 fallback 原文
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
 * 單次 Bing 翻譯請求。
 * @param {string} text — 單段文字
 * @param {string} toLang — Bing 語言代碼（zh-Hant / zh-Hans / ja）
 * @param {{ ig, iid, key, token, baseUrl }} tokenData — token 資訊
 * @returns {Promise<string>} — 譯文
 */
async function _translateSingle(text, toLang, tokenData) {
  const { ig, iid, key, token, baseUrl } = tokenData;

  const url = `${baseUrl}/ttranslatev3?isVertical=1&IG=${ig}&IID=${iid}`;

  const body = new URLSearchParams({
    fromLang: 'auto-detect',
    to: toLang,
    text: text,
    token: token,
    key: key,
  });

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    },
    credentials: 'omit',
    body: body.toString(),
  });

  if (!resp.ok) {
    const err = new Error(`Bing Translate HTTP ${resp.status}`);
    err.status = resp.status;
    throw err;
  }

  const data = await resp.json();

  // 回應格式：[{ "translations": [{ "text": "...", "to": "zh-Hant" }] }]
  if (Array.isArray(data) && data[0]?.translations?.[0]?.text) {
    return data[0].translations[0].text;
  }

  // 錯誤格式：{ statusCode: 400, errorMessage: "..." }
  if (data?.statusCode) {
    const err = new Error(data.errorMessage || `Bing error ${data.statusCode}`);
    err.status = data.statusCode;
    throw err;
  }

  throw new Error('Unexpected Bing Translate response format');
}

/**
 * 判斷是否為認證相關錯誤（需刷新 token）。
 */
function _isAuthError(err) {
  const s = err?.status;
  return s === 400 || s === 401 || s === 403;
}
