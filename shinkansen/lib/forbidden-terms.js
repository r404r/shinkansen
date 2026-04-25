// forbidden-terms.js — 中國用語黑名單 Debug 偵測層（v1.5.6）
//
// 任務：翻譯結果回來後，掃描每段譯文是否含有黑名單詞。命中時呼叫傳入的
// logger.warn 記錄一筆診斷訊息，方便使用者從 Debug 分頁追查 LLM 漏網案例。
//
// 設計：純記錄、不修改譯文。中文排版偏好一律交給 system prompt 處理（見
// CLAUDE.md 硬規則 §7），這裡的 detect 層只是事後審計，不做事後 normalize。
//
// logger 走 dependency injection，spec 可以塞 stub 觀察呼叫；正式呼叫端
// （background.js）會包一層 adapter 把 logger.warn 轉接到 debugLog('warn', ...)。

/**
 * @param {string[]} translations 譯文陣列
 * @param {string[]} originals    對應的原文陣列（用來在 log 裡留下 source 片段供追查）
 * @param {Array<{forbidden:string, replacement:string}>} forbiddenTerms
 * @param {{warn: (category:string, message:string, data:object) => void}} logger
 */
export function detectForbiddenTermLeaks(translations, originals, forbiddenTerms, logger) {
  if (!Array.isArray(forbiddenTerms) || forbiddenTerms.length === 0) return;
  if (!Array.isArray(translations) || translations.length === 0) return;
  if (!logger || typeof logger.warn !== 'function') return;

  for (let i = 0; i < translations.length; i++) {
    const tr = translations[i] || '';
    if (!tr) continue;
    const src = (Array.isArray(originals) && originals[i]) || '';
    for (const t of forbiddenTerms) {
      if (!t || !t.forbidden) continue;
      if (tr.indexOf(t.forbidden) !== -1) {
        logger.warn('forbidden-term-leak', `黑名單詞「${t.forbidden}」漏進譯文`, {
          forbidden: t.forbidden,
          replacement: t.replacement,
          sourceSnippet: src.slice(0, 120),
          translationSnippet: tr.slice(0, 120),
        });
      }
    }
  }
}
