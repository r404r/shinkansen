// Unit test: 自動翻譯白名單觸發的 preset slot 解析（v1.6.13）
//
// 對應 v1.6.13 修法:autoTranslate 觸發路徑改走 SK.handleTranslatePreset(slot)
// 而非裸 SK.translatePage(),讓白名單翻譯與使用者按下對應快速鍵的行為一致
// (走 preset.model 的 modelOverride,而非 fallback 全域 geminiConfig.model)。
//
// SANITY 紀錄(已驗證):把 fallback 從 2 改成 1,4 條測試中 2 條 fail
// (undefined / 範圍外路徑),還原後全綠。
//
// 驗證 lib/storage.js 的 pickAutoTranslateSlot:
//   - 合法值 1 / 2 / 3 → 原樣回傳
//   - undefined / null(向下相容,舊 storage 沒這欄位) → 2
//   - 字串 "1" / "3"(storage coerce) → 1 / 3
//   - 0 / 4 / 999 / NaN → 2
//
// 為什麼 fallback 是 2:v1.6.12 之前白名單路徑直接 SK.translatePage() 不帶 slot,
// fallback 全域 geminiConfig.model;改走 preset slot 後,選 slot 2(預設 Flash)
// 等效於原行為(全域預設 model 也是 flash-preview)。
import { test, expect } from '@playwright/test';
import { pickAutoTranslateSlot } from '../../shinkansen/lib/storage.js';

test.describe('pickAutoTranslateSlot', () => {
  test('合法 slot 1 / 2 / 3 原樣回傳', () => {
    expect(pickAutoTranslateSlot(1)).toBe(1);
    expect(pickAutoTranslateSlot(2)).toBe(2);
    expect(pickAutoTranslateSlot(3)).toBe(3);
  });

  test('字串型合法 slot 自動 coerce 成 number', () => {
    expect(pickAutoTranslateSlot('1')).toBe(1);
    expect(pickAutoTranslateSlot('3')).toBe(3);
  });

  test('undefined / null(舊 storage 無此欄位) → fallback 2', () => {
    expect(pickAutoTranslateSlot(undefined)).toBe(2);
    expect(pickAutoTranslateSlot(null)).toBe(2);
  });

  test('範圍外 / NaN / 物件 → fallback 2', () => {
    expect(pickAutoTranslateSlot(0)).toBe(2);
    expect(pickAutoTranslateSlot(4)).toBe(2);
    expect(pickAutoTranslateSlot(999)).toBe(2);
    expect(pickAutoTranslateSlot('abc')).toBe(2);
    expect(pickAutoTranslateSlot({})).toBe(2);
    expect(pickAutoTranslateSlot([])).toBe(2);
  });
});
