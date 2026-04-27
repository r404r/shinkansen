// model-pricing.js — Gemini 模型計價表（Standard tier，USD per 1M tokens）
// 來源：https://ai.google.dev/gemini-api/docs/pricing
// 結構對齊 settings.pricing，可直接當 effectivePricing 使用。
//
// v1.4.12：preset 快速鍵按 modelOverride 觸發翻譯時，由 background.js handleTranslate
// 依當下 model 查此表覆蓋 settings.pricing，讓 toast 顯示的費用與 usage log 跟 model 走。
// 使用者若在 options 頁有自訂 settings.pricing，該值在「沒有 modelOverride」時仍會被使用。
//
// v1.6.14:加入 LAST_CALIBRATED_DATE + settings.modelPricingOverrides。
// Google 改價時內建表會過時,使用者可在「Gemini 分頁 → 模型計價」逐模型覆蓋。
// getPricingForModel 簽名加 settings 參數,先查 override 再 fallback 內建。
export const MODEL_PRICING = {
  'gemini-3.1-flash-lite-preview': { inputPerMTok: 0.10, outputPerMTok: 0.30 },
  'gemini-3-flash-preview':        { inputPerMTok: 0.50, outputPerMTok: 3.00 },
  'gemini-3.1-pro-preview':        { inputPerMTok: 2.00, outputPerMTok: 12.00 },
};

// v1.6.14:內建表校準日期。UI 顯示「(YYYY-MM 校準)」提示使用者可能過時。
// release 時若 Google 公布新價,把這裡更新 + 同步 MODEL_PRICING 數字。
export const LAST_CALIBRATED_DATE = '2026-04';

/**
 * 查模型計價,優先順序:
 *   1. settings.modelPricingOverrides[model] 內 input/output 都是合法數字 → 用 override
 *   2. fallback MODEL_PRICING 內建表
 *   3. 找不到 → null(呼叫端要 fallback 到 settings.pricing 全域 fallback)
 *
 * @param {string} model 模型 ID
 * @param {object|null} settings 完整 settings(可只帶 modelPricingOverrides)
 */
export function getPricingForModel(model, settings = null) {
  if (!model) return null;
  const override = settings?.modelPricingOverrides?.[model];
  if (override
      && Number.isFinite(Number(override.inputPerMTok))
      && Number.isFinite(Number(override.outputPerMTok))) {
    return {
      inputPerMTok: Number(override.inputPerMTok),
      outputPerMTok: Number(override.outputPerMTok),
    };
  }
  return MODEL_PRICING[model] || null;
}
