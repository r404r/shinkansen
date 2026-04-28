// Regression: streaming 路徑 zh-CN 禁用詞跳過
//
// Bug: handleTranslateStream 缺少 zh-CN forbidden terms 跳過邏輯,
// 導致簡體中文用戶在 streaming 路徑(batch 0 SSE)仍被注入禁用詞,
// 把正確的簡體用語標記為「禁用」。
//
// Fix: 在 handleTranslateStream 加上與 handleTranslate / handleTranslateCustom
// 相同的 `settings.uiLocale === 'zh-CN' ? [] : ...` guard。
//
// Test: 驗證 background.js handleTranslateStream 對 zh-CN 用戶不注入 forbiddenTerms。
// 策略: 讀 background.js 原始碼,確認 handleTranslateStream 中 forbiddenTermsList
// 的建構包含 zh-CN guard。
//
// 這是 source-level 驗證(不需要跑完整翻譯流程),用 Node fs 讀 background.js
// 並做字串斷言。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BG_PATH = path.resolve(__dirname, '../../shinkansen/background.js');

test('handleTranslateStream: zh-CN forbidden terms skip guard 存在', () => {
  const src = fs.readFileSync(BG_PATH, 'utf8');

  // 找到 handleTranslateStream 函式範圍
  const fnStart = src.indexOf('async function handleTranslateStream');
  expect(fnStart, 'handleTranslateStream 函式應存在').toBeGreaterThan(-1);

  // 找到下一個 async function(函式邊界)
  const fnEnd = src.indexOf('\nasync function ', fnStart + 1);
  const fnBody = fnEnd > fnStart ? src.slice(fnStart, fnEnd) : src.slice(fnStart);

  // 在 handleTranslateStream 函式體中,forbiddenTermsList 的建構
  // 應包含 zh-CN guard
  expect(
    fnBody,
    'handleTranslateStream 內的 forbiddenTermsList 應包含 zh-CN skip guard',
  ).toContain("settings.uiLocale === 'zh-CN'");
});

test('handleTranslate 和 handleTranslateStream 的 zh-CN guard 一致', () => {
  const src = fs.readFileSync(BG_PATH, 'utf8');

  // handleTranslate (非 streaming) 中的 guard
  const htStart = src.indexOf('async function handleTranslate(');
  const htEnd = src.indexOf('\nasync function ', htStart + 1);
  const htBody = htEnd > htStart ? src.slice(htStart, htEnd) : src.slice(htStart);

  // handleTranslateStream 中的 guard
  const sStart = src.indexOf('async function handleTranslateStream');
  const sEnd = src.indexOf('\nasync function ', sStart + 1);
  const sBody = sEnd > sStart ? src.slice(sStart, sEnd) : src.slice(sStart);

  // 兩者都應有 zh-CN guard
  const htHasGuard = htBody.includes("settings.uiLocale === 'zh-CN'");
  const sHasGuard = sBody.includes("settings.uiLocale === 'zh-CN'");

  expect(htHasGuard, 'handleTranslate 應有 zh-CN guard').toBe(true);
  expect(sHasGuard, 'handleTranslateStream 應有 zh-CN guard').toBe(true);
});
