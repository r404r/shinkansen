// Unit test: presetsRequireGemini(presets) — popup 「⚠ 尚未設定 API Key」提示的 gating(v1.8.12)
//
// SANITY 紀錄(已驗證):把 `presets.some(...)` 改成 `presets.every(...)`,
// 「全 google」案例本來回 false 仍是 false 但「mixed gemini + google」會回 false(原本應 true)
// → 第 4 條「mixed」fail。還原後 7/7 pass。
//
// 對應使用者問題:
//   有使用者完全不用 Gemini(三組 preset 都改成 Google MT / 自訂模型)但 popup 一直提醒
//   「尚未設定 Gemini API Key」。修法:把提示 gate 在「presets 中至少一組是 Gemini」之後。
//
// 設計選擇:presets 為空 / undefined / 非 array → 視為 true(保守 fallback,
//   因為 DEFAULT_SETTINGS.translatePresets 三組裡有兩組是 gemini,沒讀到資料時保留既有提醒
//   行為比靜音安全)。
import { test, expect } from '@playwright/test';
import { presetsRequireGemini } from '../../shinkansen/lib/storage.js';

test.describe('presetsRequireGemini', () => {
  test('三組全 gemini → true', () => {
    expect(presetsRequireGemini([
      { slot: 1, engine: 'gemini' },
      { slot: 2, engine: 'gemini' },
      { slot: 3, engine: 'gemini' },
    ])).toBe(true);
  });

  test('預設組合(2 gemini + 1 google) → true', () => {
    expect(presetsRequireGemini([
      { slot: 1, engine: 'gemini', model: 'gemini-3.1-flash-lite-preview' },
      { slot: 2, engine: 'gemini', model: 'gemini-3-flash-preview' },
      { slot: 3, engine: 'google', model: null },
    ])).toBe(true);
  });

  test('三組全 google → false(本次新行為)', () => {
    expect(presetsRequireGemini([
      { slot: 1, engine: 'google' },
      { slot: 2, engine: 'google' },
      { slot: 3, engine: 'google' },
    ])).toBe(false);
  });

  test('mixed:google + openai-compat + google → false(沒 gemini 就靜音)', () => {
    expect(presetsRequireGemini([
      { slot: 1, engine: 'google' },
      { slot: 2, engine: 'openai-compat' },
      { slot: 3, engine: 'google' },
    ])).toBe(false);
  });

  // Nozomi: Bing 引擎不需要 Gemini API Key，全選 Bing 時不應提醒
  test('Nozomi: 三組全 bing → false(Bing 不需 Gemini Key)', () => {
    expect(presetsRequireGemini([
      { slot: 1, engine: 'bing' },
      { slot: 2, engine: 'bing' },
      { slot: 3, engine: 'bing' },
    ])).toBe(false);
  });

  test('Nozomi: mixed bing + google → false(兩者都不需 Gemini Key)', () => {
    expect(presetsRequireGemini([
      { slot: 1, engine: 'bing' },
      { slot: 2, engine: 'google' },
      { slot: 3, engine: 'bing' },
    ])).toBe(false);
  });

  test('mixed:google + gemini + openai-compat → true(只要有一組 gemini 就提醒)', () => {
    expect(presetsRequireGemini([
      { slot: 1, engine: 'google' },
      { slot: 2, engine: 'gemini' },
      { slot: 3, engine: 'openai-compat' },
    ])).toBe(true);
  });

  test('空 array → true(保守 fallback,跟 DEFAULT_SETTINGS 對齊)', () => {
    expect(presetsRequireGemini([])).toBe(true);
  });

  test('undefined / null / 非 array → true(讀不到 storage 時保留既有提醒)', () => {
    expect(presetsRequireGemini(undefined)).toBe(true);
    expect(presetsRequireGemini(null)).toBe(true);
    expect(presetsRequireGemini({})).toBe(true);
    expect(presetsRequireGemini('gemini')).toBe(true);
  });
});
