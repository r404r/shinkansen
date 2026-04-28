// Unit test: lib/format.js parseUserNum(v1.6.19 regression)
//
// 原 bug:options.js 用 `Number(v) || default`,使用者輸入 0(safetyMargin /
// maxRetries / maxConcurrentBatches / maxUnitsPerBatch / maxCharsPerBatch /
// maxTranslateUnits 等)時 0 被當 falsy → 回退預設值 → 使用者下次打開設定頁
// 看到自己輸入的 0 變回預設,UI 體感 bug。
//
// 修法:抽出 parseUserNum helper,空字串 / 非法字元走 default,合法有限數字
//(含 0、負數)保留。v1.8.9 把 helper 從 options.js 內部抽到 lib/format.js
// export,讓本 unit test 可直接 ESM import 驗。
//
// SANITY 已驗(2026-04-28):把 parseUserNum body 改回 `return Number(rawValue) || defaultValue;`,
// "0 應保留" test fail。還原後 pass。

import { test, expect } from '@playwright/test';
import { parseUserNum } from '../../shinkansen/lib/format.js';

test.describe('parseUserNum', () => {
  test('"0" 應保留為 0(原 bug 觸發點)', () => {
    expect(parseUserNum('0', 20)).toBe(0);
  });

  test('空字串走 default', () => {
    expect(parseUserNum('', 20)).toBe(20);
  });

  test('純空白走 default', () => {
    expect(parseUserNum('   ', 20)).toBe(20);
  });

  test('null / undefined 走 default', () => {
    expect(parseUserNum(null, 20)).toBe(20);
    expect(parseUserNum(undefined, 20)).toBe(20);
  });

  test('非法字元走 default', () => {
    expect(parseUserNum('abc', 20)).toBe(20);
  });

  test('正常正整數保留', () => {
    expect(parseUserNum('5', 20)).toBe(5);
  });

  test('小數保留', () => {
    expect(parseUserNum('5.5', 20)).toBe(5.5);
  });

  test('負數保留(parseUserNum 不過濾,由 caller 邊界檢查)', () => {
    expect(parseUserNum('-1', 20)).toBe(-1);
  });

  test('前後空白會 trim', () => {
    expect(parseUserNum('  10  ', 20)).toBe(10);
  });

  test('Infinity / NaN 走 default(Number.isFinite 過濾)', () => {
    expect(parseUserNum('Infinity', 20)).toBe(20);
    expect(parseUserNum('NaN', 20)).toBe(20);
  });
});
