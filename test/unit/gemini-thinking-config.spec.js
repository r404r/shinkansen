// Unit test: pickThinkingConfig 對映規則（v1.6.12,對應「Pro 模型 Budget 0 is invalid」bug）
//
// 真實資料來源:tools/probe-gemini-pro.js 對 4 個模型 × 5 種 thinkingConfig 組合的實測:
//   - gemini-3-pro-preview / gemini-2.5-pro 強制 thinking-only,thinkingBudget=0 一律 400
//   - gemini-3 Pro 不支援 thinkingLevel='minimal',最低支援 'low'
//   - gemini-3 Flash / Flash Lite 用 thinkingLevel='minimal' = 舊 budget=0 等效
//
// 此 spec 鎖死「model name → thinkingLevel」對映,避免 regression。
import { test, expect } from '@playwright/test';
import { pickThinkingConfig } from '../../shinkansen/lib/gemini.js';

test('pickThinkingConfig: Pro 模型回傳 low(API 強制 thinking-only,minimal 不支援)', () => {
  // Gemini 3 Pro 系列(預期最常見的 Pro 用法)
  expect(pickThinkingConfig('gemini-3-pro-preview')).toEqual({ thinkingLevel: 'low' });
  expect(pickThinkingConfig('gemini-3.1-pro-preview')).toEqual({ thinkingLevel: 'low' });
  // Legacy 2.5 Pro(實測也強制 thinking,雖然 thinkingLevel API 在 2.5 不支援,
  // 但 Shinkansen 預設 / 推薦用 3+;若使用者真設了 2.5-pro 模型名,API 會回 400
  // "Thinking level is not supported"——比舊版 budget=0 的 "Budget 0 is invalid"
  // 至少訊息更清楚)
  expect(pickThinkingConfig('gemini-2.5-pro')).toEqual({ thinkingLevel: 'low' });
});

test('pickThinkingConfig: Flash 系列回傳 minimal(thoughts=0 不額外計費)', () => {
  expect(pickThinkingConfig('gemini-3-flash-preview')).toEqual({ thinkingLevel: 'minimal' });
  expect(pickThinkingConfig('gemini-3.1-flash-preview')).toEqual({ thinkingLevel: 'minimal' });
  expect(pickThinkingConfig('gemini-3.1-flash-lite-preview')).toEqual({ thinkingLevel: 'minimal' });
  expect(pickThinkingConfig('gemini-2.5-flash')).toEqual({ thinkingLevel: 'minimal' });
  expect(pickThinkingConfig('gemini-2.5-flash-lite')).toEqual({ thinkingLevel: 'minimal' });
});

test('pickThinkingConfig: case-insensitive Pro 偵測', () => {
  // 防禦性:使用者可能輸入大寫 / 混合大小寫的模型名
  expect(pickThinkingConfig('GEMINI-3-PRO-PREVIEW')).toEqual({ thinkingLevel: 'low' });
  expect(pickThinkingConfig('Gemini-3-Pro-Preview')).toEqual({ thinkingLevel: 'low' });
});

test('pickThinkingConfig: 空值 / undefined / null 不爆,fallback 到 minimal', () => {
  // 防禦性:settings 殘缺時不應該 throw;預設 minimal 是最安全的(對 Pro 會 API
  // 報錯讓使用者知道,對 Flash 是正常 0-thinking)
  expect(pickThinkingConfig('')).toEqual({ thinkingLevel: 'minimal' });
  expect(pickThinkingConfig(undefined)).toEqual({ thinkingLevel: 'minimal' });
  expect(pickThinkingConfig(null)).toEqual({ thinkingLevel: 'minimal' });
});

test('pickThinkingConfig: 不送 thinkingBudget 欄位(舊 API 已 deprecated)', () => {
  // 確保我們沒有意外保留舊的 thinkingBudget 欄位;Gemini 3+ Google 推薦用 thinkingLevel
  const r = pickThinkingConfig('gemini-3-flash-preview');
  expect(r.thinkingBudget).toBeUndefined();
  const r2 = pickThinkingConfig('gemini-3-pro-preview');
  expect(r2.thinkingBudget).toBeUndefined();
});
