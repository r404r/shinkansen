// Unit test: 工具列「翻譯本頁」按鈕的 preset slot 解析（v1.6.6）
//
// SANITY 紀錄（已驗證）：把 fallback 從 2 改 1，4 條中 2 條 fail
// （undefined 路徑與「範圍外 / NaN」路徑），還原後 4/4 pass。
//
//
// 驗證 lib/storage.js 的 pickPopupSlot：
//   - 合法值 1 / 2 / 3 → 原樣回傳
//   - undefined / null（向下相容，舊 storage 沒這欄位） → 2
//   - 字串 "1" / "3"（storage 異常或舊資料） → 1 / 3
//   - 0 / 4 / 999 / NaN → 2
//
// 為什麼是 2：v1.4.12 起 popup 按鈕硬碼映射到 slot 2（Flash），這是 popupButtonSlot
// 設定推出前的歷史行為。fallback 必須維持這個值才不會打擾既有使用者。
import { test, expect } from '@playwright/test';
import { pickPopupSlot } from '../../shinkansen/lib/storage.js';

test.describe('pickPopupSlot', () => {
  test('合法 slot 1 / 2 / 3 原樣回傳', () => {
    expect(pickPopupSlot(1)).toBe(1);
    expect(pickPopupSlot(2)).toBe(2);
    expect(pickPopupSlot(3)).toBe(3);
  });

  test('字串型合法 slot 自動 coerce 成 number', () => {
    expect(pickPopupSlot('1')).toBe(1);
    expect(pickPopupSlot('3')).toBe(3);
  });

  test('undefined（向下相容：舊 storage 沒這欄位）→ fallback 2', () => {
    expect(pickPopupSlot(undefined)).toBe(2);
    expect(pickPopupSlot(null)).toBe(2);
  });

  test('範圍外 / NaN → fallback 2', () => {
    expect(pickPopupSlot(0)).toBe(2);
    expect(pickPopupSlot(4)).toBe(2);
    expect(pickPopupSlot(999)).toBe(2);
    expect(pickPopupSlot('abc')).toBe(2);
    expect(pickPopupSlot({})).toBe(2);
  });
});
