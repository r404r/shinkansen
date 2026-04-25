// lib/google-translate.js — Google Translate 非官方 API 封裝
// 使用 translate.googleapis.com/translate_a/single?client=gtx 端點（免費，不需 API Key）
// 此端點非官方，無公開文件；業界通例用於瀏覽器擴充功能（Immersive Translation、read-frog 等）。
// 注意：Google 可能隨時更動此端點，屬灰色地帶，不建議作為唯一翻譯引擎。

// U+2063 INVISIBLE SEPARATOR × 3：翻譯過程中幾乎不會被 MT 引擎改動，用作批次分隔符。
const SEP = '\n\u2063\u2063\u2063\n';

// URL encode 後的 SEP 長度約 66 chars，保守上限設 5500，避免伺服器拒絕過長請求。
const MAX_URL_ENCODED_CHARS = 5500;

/**
 * 批次翻譯字串陣列（自動偵測語言 → 目標語言）。
 * 內部用 SEP 串接多段文字為單一請求，若 URL 過長則自動拆多次請求後合併。
 * @param {string[]} texts
 * @param {string} [targetLang='zh-TW'] 目標語言代碼（zh-TW / zh-CN / ja）
 * @returns {Promise<{ translations: string[], chars: number }>}
 */
export async function translateGoogleBatch(texts, targetLang = 'zh-TW') {
  if (!texts || texts.length === 0) return { translations: [], chars: 0 };

  const totalChars = texts.reduce((s, t) => s + (t?.length || 0), 0);
  const result = new Array(texts.length).fill('');

  // ─── 依 URL 長度分組 ─────────────────────────────────────────
  const groups = [];
  let cur = [];
  let curEncodedLen = 0;
  const encodedSep = encodeURIComponent(SEP).length;

  for (let i = 0; i < texts.length; i++) {
    const t = texts[i] || '';
    const eLen = encodeURIComponent(t).length + encodedSep;
    if (cur.length > 0 && curEncodedLen + eLen > MAX_URL_ENCODED_CHARS) {
      groups.push(cur);
      cur = [];
      curEncodedLen = 0;
    }
    cur.push({ idx: i, text: t });
    curEncodedLen += eLen;
  }
  if (cur.length > 0) groups.push(cur);

  // ─── 逐組翻譯，合併回原索引 ──────────────────────────────────
  for (const group of groups) {
    const joined = group.map(g => g.text).join(SEP);
    const parts = await _fetchTranslate(joined, targetLang);
    group.forEach((g, j) => {
      result[g.idx] = parts[j] ?? g.text; // 解析失敗時 fallback 原文
    });
  }

  return { translations: result, chars: totalChars };
}

/**
 * 對 Google Translate 非官方端點發出單一 GET 請求，回傳用 SEP 分割的字串陣列。
 */
async function _fetchTranslate(text, targetLang = 'zh-TW') {
  const url =
    'https://translate.googleapis.com/translate_a/single' +
    `?client=gtx&sl=auto&tl=${encodeURIComponent(targetLang)}&dt=t&q=` +
    encodeURIComponent(text);

  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Google Translate HTTP ${resp.status}`);

  const data = await resp.json();
  // 回應格式：[[[譯文片段, 原文片段, ...], ...], ...]
  // 取 data[0] 的所有陣列元素的第一個欄位串接即完整譯文
  const full = (data[0] || [])
    .filter(Array.isArray)
    .map(chunk => chunk[0] || '')
    .join('');

  return full.split(SEP);
}
