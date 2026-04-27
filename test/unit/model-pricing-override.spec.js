// Unit test: getPricingForModel 的優先順序(v1.6.14)
//
// 對應 v1.6.14 修法:Google 改價時內建表會過時,使用者可在「Gemini 分頁 → 模型計價」
// 用 settings.modelPricingOverrides 個別覆蓋。新簽名 getPricingForModel(model, settings)。
//
// 優先順序:
//   1. settings.modelPricingOverrides[model](兩欄都是合法數字才採用)
//   2. fallback MODEL_PRICING 內建表
//   3. 找不到 → null(呼叫端 fallback 全域 settings.pricing)
//
// SANITY 紀錄(已驗證):把 override 分支整段移除 → "override 優先" spec fail,
// 還原後全綠。
import { test, expect } from '@playwright/test';
import { getPricingForModel, MODEL_PRICING, LAST_CALIBRATED_DATE } from '../../shinkansen/lib/model-pricing.js';

test.describe('getPricingForModel: override 優先', () => {
  test('settings.modelPricingOverrides 有合法 entry → 用 override 蓋過內建表', () => {
    const settings = {
      modelPricingOverrides: {
        'gemini-3-flash-preview': { inputPerMTok: 1.23, outputPerMTok: 4.56 },
      },
    };
    expect(getPricingForModel('gemini-3-flash-preview', settings)).toEqual({
      inputPerMTok: 1.23,
      outputPerMTok: 4.56,
    });
  });

  test('override 字串型數字也可接受(coerce)', () => {
    const settings = {
      modelPricingOverrides: {
        'gemini-3.1-pro-preview': { inputPerMTok: '3.5', outputPerMTok: '14.0' },
      },
    };
    expect(getPricingForModel('gemini-3.1-pro-preview', settings)).toEqual({
      inputPerMTok: 3.5,
      outputPerMTok: 14.0,
    });
  });

  test('override 非合法數字(NaN/null/undefined) → 視為無 override 走內建表', () => {
    const settings = {
      modelPricingOverrides: {
        'gemini-3-flash-preview': { inputPerMTok: 'abc', outputPerMTok: 3.0 },
      },
    };
    expect(getPricingForModel('gemini-3-flash-preview', settings)).toEqual(MODEL_PRICING['gemini-3-flash-preview']);
  });

  test('其他 model 即使有 override entry 也不影響 fallback 內建表', () => {
    const settings = {
      modelPricingOverrides: {
        'gemini-3.1-flash-lite-preview': { inputPerMTok: 99, outputPerMTok: 99 },
      },
    };
    // 查詢 flash 不該被 lite 的 override 影響
    expect(getPricingForModel('gemini-3-flash-preview', settings)).toEqual(MODEL_PRICING['gemini-3-flash-preview']);
  });
});

test.describe('getPricingForModel: 內建表 fallback', () => {
  test('沒帶 settings 或 settings 沒 overrides 欄位 → 用內建表', () => {
    expect(getPricingForModel('gemini-3-flash-preview')).toEqual(MODEL_PRICING['gemini-3-flash-preview']);
    expect(getPricingForModel('gemini-3-flash-preview', null)).toEqual(MODEL_PRICING['gemini-3-flash-preview']);
    expect(getPricingForModel('gemini-3-flash-preview', {})).toEqual(MODEL_PRICING['gemini-3-flash-preview']);
    expect(getPricingForModel('gemini-3-flash-preview', { modelPricingOverrides: {} })).toEqual(MODEL_PRICING['gemini-3-flash-preview']);
  });

  test('未列入內建表的 model + 無 override → null', () => {
    expect(getPricingForModel('unknown-model')).toBeNull();
    expect(getPricingForModel('unknown-model', { modelPricingOverrides: {} })).toBeNull();
  });

  test('空值/undefined model → null', () => {
    expect(getPricingForModel('')).toBeNull();
    expect(getPricingForModel(null)).toBeNull();
    expect(getPricingForModel(undefined)).toBeNull();
  });
});

test.describe('LAST_CALIBRATED_DATE 常數', () => {
  test('export 一個非空字串(UI 用來顯示「YYYY-MM 校準」提示)', () => {
    expect(typeof LAST_CALIBRATED_DATE).toBe('string');
    expect(LAST_CALIBRATED_DATE.length).toBeGreaterThan(0);
    // 格式應為 YYYY-MM
    expect(LAST_CALIBRATED_DATE).toMatch(/^\d{4}-\d{2}$/);
  });
});
